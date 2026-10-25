import type { InventoryObject } from '@server/lib/oss-inventory'
import type { StorageAuditKind } from '@shared/types/storage-audit'
import type { z } from 'zod'
import type { AuditIssue, AuditPool } from './repository'
import { runtime_config } from '@config/loader'
import { storage_audit_config_schema } from '@config/schema'
import { create_aliyun_oss } from '@server/lib/aliyun-oss'
import { db } from '@server/lib/db'
import { create_oss_inventory } from '@server/lib/oss-inventory'
import { enqueue_object_retirement } from '@server/services/content/object-retirement.repository'
import { create_orphan_cleanup } from './cleanup'
import { audit_destination, audit_key, create_audit_catalog, create_audit_repository, read_audit_findings } from './repository'

type Options = z.input<typeof storage_audit_config_schema>
type Storage = Pick<ReturnType<typeof create_aliyun_oss>, 'head_object' | 'get_object_access'> & ReturnType<typeof create_oss_inventory>
const reference_kinds: StorageAuditKind[] = ['missing_object', 'size_mismatch', 'public_object', 'invalid_reference']

export function audit_error_code(error: unknown) {
  const value = error as { status?: number, statusCode?: number, message?: string, code?: string }
  if (value.message === 'audit_lease_lost')
    return 'lease_lost'
  if (value.code === 'SignatureDoesNotMatch')
    return 'oss_signature_invalid'
  if ((value.status ?? value.statusCode) === 403)
    return 'oss_access_denied'
  return 'scan_failed'
}

/** Each observation is advisory. This service has no storage mutation methods. */
export function create_storage_auditor(pool: AuditPool, storage: Storage, destination: { bucket: string, endpoint: string }, raw_options: Options) {
  const options = storage_audit_config_schema.parse(raw_options)
  const catalog = create_audit_catalog(pool, destination, options.staticKeys)
  async function reference_issues(key: string, renew: () => Promise<void>, signal?: AbortSignal): Promise<AuditIssue[]> {
    const reference = await catalog.reference(key)
    if (! reference)
      return []
    if (! /^(?:content\/att\/|avatar\/|imgs\/)/.test(key) || /[\\?\0\r\n]/.test(key) || Buffer.byteLength(key) > 1024 || key.split('/').some(part => part === '.' || part === '..'))
      return [{ key, kind: 'invalid_reference' }]
    const issues: AuditIssue[] = []
    try {
      await renew()
      signal?.throwIfAborted()
      const head = await storage.head_object(key)
      if (reference.size !== null && head.size !== reference.size)
        issues.push({ key, kind: 'size_mismatch', expected: reference.size, observed: head.size })
      await renew()
      signal?.throwIfAborted()
      const acl = await storage.get_object_access(key)
      if (acl === 'public-read' || acl === 'public-read-write')
        issues.push({ key, kind: 'public_object', observed: head.size })
    }
    catch (error) {
      if ((error as { status?: number }).status !== 404)
        throw error
      issues.push({ key, kind: 'missing_object', expected: reference.size })
    }
    signal?.throwIfAborted()
    // The pointer may have been replaced/deleted while HEAD was in flight.
    const current = await catalog.reference(key)
    return current && current.size === reference.size ? issues : []
  }
  async function object_issue(object: InventoryObject, started_at: Date): Promise<AuditIssue[]> {
    if ((object.size === 0 && object.key.endsWith('/')) || await catalog.reference(object.key))
      return []
    const ownership = await catalog.ownership(object.key)
    if (ownership === 'tracked' || object.modified_at.getTime() > new Date(started_at).getTime() - options.orphanGraceSeconds * 1000)
      return []
    const kind: StorageAuditKind = ownership === 'retired'
      ? 'retired_object_present'
      : object.key.startsWith('imgs/')
        ? 'unregistered_static'
        : /^(?:content\/att\/|content-upload\/|avatar\/)/.test(object.key) ? 'orphan_candidate' : 'unmanaged_object'
    return [{ key: object.key, kind, observed: object.size, modified_at: object.modified_at }]
  }
  async function sweep(signal?: AbortSignal) {
    if (! options.enabled || signal?.aborted)
      return
    const repository = create_audit_repository(pool, destination, options.leaseSeconds)
    let state = await repository.claim()
    if (! state)
      return
    const deadline = Date.now() + options.batchBudgetMs
    const stopped = () => signal?.aborted || Date.now() >= deadline
    let steps = 0
    try {
      while (steps < options.batchSize && ! stopped() && state.phase !== 'completed') {
        await repository.renew()
        if (state.phase === 'objects') {
          const page = await storage.list_page(audit_key(state.object_cursor), options.batchSize - steps)
          let consumed = true
          for (const object of page.objects) {
            if (stopped()) {
              consumed = false
              break
            }
            await repository.renew()
            const issues = await object_issue(object, state.cycle_started_at)
            signal?.throwIfAborted()
            state = { ... state, object_cursor: object.key }
            await repository.checkpoint(state, issues, null, 0, 1)
            steps ++
          }
          if (consumed && ! page.truncated) {
            state = { ... state, phase: 'findings', row_cursor: 0, role_cursor: 0 }
            await repository.checkpoint(state)
          }
          // An empty final page must still consume a bounded step.
          if (! page.objects.length)
            steps ++
          continue
        }
        if (state.phase === 'findings') {
          const finding = await catalog.next_finding(state)
          if (! finding) {
            state = { ... state, phase: 'completed' }
            await repository.checkpoint(state)
            break
          }
          let issues: AuditIssue[]
          if (reference_kinds.includes(finding.kind)) {
            issues = await reference_issues(finding.key, repository.renew, signal)
          }
          else {
            const object = await storage.find_object(finding.key)
            issues = object ? await object_issue(object, state.cycle_started_at) : []
          }
          signal?.throwIfAborted()
          state = { ... state, row_cursor: finding.id }
          await repository.checkpoint(state, issues, issues.some(issue => issue.kind === finding.kind) ? null : finding.id)
          steps ++
          continue
        }
        const candidate = await catalog.next_reference(state)
        if (! candidate) {
          const next = { attachments: 'avatars', avatars: 'static', static: 'objects' } as const
          state = { ... state, phase: next[state.phase], row_cursor: 0, role_cursor: 0 }
          await repository.checkpoint(state)
          steps ++
          continue
        }
        const issues = candidate.key ? await reference_issues(candidate.key, repository.renew, signal) : []
        signal?.throwIfAborted()
        state = candidate.next
        await repository.checkpoint(state, issues, null, candidate.key ? 1 : 0)
        steps ++
      }
      await repository.release(state.phase === 'completed' ? options.cycleIntervalSeconds : options.sweepIntervalSeconds)
    }
    catch (error) {
      await repository.release(options.retrySeconds, signal?.aborted ? null : audit_error_code(error)).catch(() => {})
      if (! signal?.aborted)
        throw new Error('storage_audit_failed')
    }
  }
  return { sweep }
}

export async function sweep_storage_audit(signal?: AbortSignal) {
  const config = runtime_config()
  if (! config.app.storageAudit.enabled || ! config.aliyun.oss)
    return
  const storage = { ... create_aliyun_oss(config.aliyun.oss), ... create_oss_inventory(config.aliyun.oss) }
  await create_storage_auditor(db, storage, config.aliyun.oss, config.app.storageAudit).sweep(signal)
  await create_orphan_cleanup(db, storage, config.aliyun.oss, config.app.storageAudit,
    (connection, key) => enqueue_object_retirement(connection, key, 0, 'storage_audit_orphan')).sweep(signal)
}

export async function get_storage_audit_findings(input: { after_id: number, limit: number }) {
  const config = runtime_config().aliyun.oss
  if (! config)
    return []
  return read_audit_findings(db, audit_destination(config.bucket, config.endpoint), input.after_id, input.limit)
}
