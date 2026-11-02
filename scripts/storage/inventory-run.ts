import type { Protection } from './inventory-catalog'
import type { Reader, Upload, Version } from './oss-inventory'
import { cleanup_key_pattern } from '@server/services/storage-audit/cleanup'
import { z } from 'zod'

const cursor = z.object({ key: z.string().min(1), id: z.string().min(1) }).nullable()
const upload = z.object({ key: z.string().min(1), upload_id: z.string().min(1), initiated_at: z.iso.datetime() })
const status = z.object({ complete: z.boolean(), error: z.string().nullable() })
const stats = z.object({ count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() })
const scan_options = z.object({ prefix: z.string(), min_age_days: z.number().int().min(7), parts: z.boolean(), page_size: z.number().int().min(1).max(100), catalog_mode: z.enum(['database', 'unverified']).default('database') })
export const checkpoint_schema = z.object({
  format: z.literal(1), target: z.string(), started_at: z.iso.datetime(), updated_at: z.iso.datetime(),
  options: scan_options,
  configuration: z.object({ versioning: z.unknown(), lifecycle: z.unknown() }),
  configuration_status: z.object({ versioning: status, lifecycle: status }),
  versions: status.extend({ cursor }), uploads: status.extend({ cursor }),
  pending: z.object({ rows: z.array(upload).max(100), index: z.number().int().nonnegative(), next: cursor,
    parts: z.object({ after: z.number().int().nonnegative(), count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }) }).nullable(),
  revision: z.number().int().nonnegative(), requests: z.number().int().nonnegative(),
  totals: z.record(z.string(), stats), groups: z.record(z.string(), stats),
})
export type Checkpoint = z.infer<typeof checkpoint_schema>
export type RecordRow = (Version | Upload) & { protection: Protection, action: string, executable: false, observed_at: string, parts?: { count: number, bytes: number, complete: boolean, error: string | null } }
interface Sink { save: (state: Checkpoint, records: RecordRow[]) => Promise<void> }
class PersistenceError extends Error {}
interface Options { max_requests: number, max_ms: number, pause_ms: number, now?: () => number, wait?: (ms: number) => Promise<void> }
const fresh_status = () => ({ complete: false, error: null })
export function new_checkpoint(target: string, options: z.input<typeof scan_options>, now = Date.now()): Checkpoint {
  return { format: 1, target, options: scan_options.parse(options), started_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
    configuration: { versioning: null, lifecycle: null }, configuration_status: { versioning: fresh_status(), lifecycle: fresh_status() },
    versions: { ... fresh_status(), cursor: null }, uploads: { ... fresh_status(), cursor: null }, pending: null,
    revision: 0, requests: 0, totals: {}, groups: {} }
}
export function inventory_error(error: unknown) {
  const value = error as { status?: number, code?: string, message?: string }
  if (value.status === 403)
    return 'access_denied'
  if (value.status === 404 && value.code === 'NoSuchUpload')
    return 'upload_disappeared'
  if (value.code === 'ER_BAD_FIELD_ERROR' || value.code === 'ER_NO_SUCH_TABLE')
    return 'database_schema_mismatch'
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ER_ACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR'].includes(value.code ?? ''))
    return 'database_unavailable'
  if (value.message === 'inventory_budget_reached' || value.message === 'invalid_oss_inventory_response')
    return value.message
  return 'inventory_operation_failed'
}
function namespace(key: string) {
  return ['content/att/staging/', 'content/att/images/', 'content/att/originals/', 'content/att/transfers/', 'content/att/', 'avatar/', 'imgs/'].find(prefix => key.startsWith(prefix)) ?? 'other'
}
function add(values: Record<string, { count: number, bytes: number }>, key: string, bytes: number) {
  const previous = values[key] ?? { count: 0, bytes: 0 }
  if (! Number.isSafeInteger(previous.bytes + bytes) || ! Number.isSafeInteger(previous.count + 1))
    throw new Error('invalid_oss_inventory_response')
  values[key] = { count: previous.count + 1, bytes: previous.bytes + bytes }
}
function record(state: Checkpoint, row: RecordRow) {
  const bytes = 'size' in row ? row.size : row.parts?.bytes ?? 0
  const kind = 'deleted' in row ? row.deleted ? 'delete_marker' : row.latest ? 'current_version' : 'historical_version' : 'multipart'
  const age = Math.max(0, (Date.parse(state.started_at) - Date.parse('modified_at' in row ? row.modified_at : row.initiated_at)) / 86400000)
  const band = age < 7 ? 'under_7d' : age < 30 ? '7_to_30d' : age < 90 ? '30_to_90d' : '90d_plus'
  const raw_class = 'storage_class' in row ? row.storage_class : 'multipart'
  const storage_class = ['Standard', 'IA', 'Archive', 'ColdArchive', 'DeepColdArchive', 'delete_marker', 'multipart'].includes(raw_class) ? raw_class : 'other'
  add(state.totals, kind, bytes)
  if (kind === 'multipart' && ! row.parts?.complete)
    add(state.totals, 'multipart_bytes_unconfirmed', bytes)
  add(state.totals, `action:${row.action}`, bytes)
  add(state.groups, JSON.stringify([namespace(row.key), kind, storage_class, band, row.protection]), bytes)
}
function action(state: Checkpoint, row: Version | Upload, protection: Protection) {
  if ('deleted' in row && row.deleted)
    return 'retain_delete_marker'
  if (protection === 'unverified')
    return 'unclassified_without_database'
  if (protection !== 'none')
    return 'retain_protected_key'
  const timestamp = 'modified_at' in row ? row.modified_at : row.initiated_at
  if (Date.parse(timestamp) > Date.parse(state.started_at) - state.options.min_age_days * 86400000)
    return 'retain_recent'
  if (! new RegExp(cleanup_key_pattern).test(row.key))
    return 'review_unmanaged_namespace'
  return 'latest' in row ? row.latest ? 'daily_audit_reobserve' : 'review_history_retention' : 'review_abort_multipart'
}
export function inventory_summary(state: Checkpoint) {
  const configuration = state.configuration as { versioning: { Status?: unknown }, lifecycle: { Rule?: unknown } }
  const lifecycle = configuration.lifecycle?.Rule
  return { format: 1, target: state.target, started_at: state.started_at, updated_at: state.updated_at,
    complete: state.versions.complete && state.uploads.complete && Object.values(state.configuration_status).every(value => value.complete),
    executable: false, requests_checkpointed: state.requests, options: state.options,
    committed_revision: state.revision,
    protection_checks_complete: state.options.catalog_mode === 'database' && state.versions.complete && state.uploads.complete,
    multipart_bytes_complete: state.options.parts && state.uploads.complete && ! state.totals.multipart_bytes_unconfirmed?.count,
    age_basis: 'version LastModified / multipart Initiated; not the time a version became noncurrent',
    configuration: { versioning: { ... state.configuration_status.versioning, value: state.configuration_status.versioning.complete ? configuration.versioning?.Status ?? null : null },
      lifecycle: { ... state.configuration_status.lifecycle, rule_count: state.configuration_status.lifecycle.complete ? lifecycle === undefined ? 0 : Array.isArray(lifecycle) ? lifecycle.length : 1 : null } },
    versions: { complete: state.versions.complete, error: state.versions.error, has_cursor: state.versions.cursor !== null }, uploads: { complete: state.uploads.complete, error: state.uploads.error, pending: state.pending !== null },
    totals: state.totals, groups: state.groups,
    scope: 'rolling metadata only; protected keys retain all versions; multipart bytes are observed parts, not billable storage; candidates require fresh authorization and identity checks' }
}

/** Bounded GET/SELECT observations; no delete/abort/enqueue dependency exists in this runner. */
export async function run_inventory(state: Checkpoint, reader: Reader, protection: (key: string, upload_id?: string) => Promise<Protection>, sink: Sink, options: Options) {
  const now = options.now ?? Date.now
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const began = now()
  let requests = 0
  async function save(rows: RecordRow[] = []) {
    if (rows.length) {
      for (const row of rows)
        record(state, row)
      state.revision ++
    }
    state.updated_at = new Date(now()).toISOString()
    try {
      await sink.save(state, rows)
    }
    catch {
      throw new PersistenceError('inventory_checkpoint_failed')
    }
  }
  async function call<T>(work: () => Promise<T>): Promise<T> {
    if (requests >= options.max_requests || now() - began >= options.max_ms)
      throw new Error('inventory_budget_reached')
    if (requests)
      await wait(options.pause_ms)
    requests ++
    state.requests ++
    await save()
    return work()
  }
  function scoped(key: string) {
    if (! key.startsWith(state.options.prefix))
      throw new Error('invalid_oss_inventory_response')
  }
  for (const kind of ['versioning', 'lifecycle'] as const) {
    try {
      state.configuration[kind] = await call(() => reader.configuration(kind))
      state.configuration_status[kind] = { complete: true, error: null }
    }
    catch (error) {
      if (error instanceof PersistenceError)
        throw error
      const code = inventory_error(error)
      if (code === 'inventory_budget_reached')
        return inventory_summary(state)
      state.configuration_status[kind] = { complete: false, error: code }
    }
    await save()
  }
  while (! state.versions.complete) {
    try {
      const page = await call(() => reader.versions(state.versions.cursor, state.options.page_size, state.options.prefix))
      const rows: RecordRow[] = []
      for (const row of page.items) {
        scoped(row.key)
        const protected_by = await protection(row.key)
        rows.push({ ... row, protection: protected_by, action: action(state, row, protected_by), executable: false, observed_at: new Date(now()).toISOString() })
      }
      state.versions = { complete: page.next === null, cursor: page.next, error: null }
      await save(rows)
    }
    catch (error) {
      if (error instanceof PersistenceError)
        throw error
      const code = inventory_error(error)
      state.versions.error = code
      await save()
      if (code === 'inventory_budget_reached')
        return inventory_summary(state)
      break
    }
  }
  while (! state.uploads.complete) {
    try {
      if (! state.pending) {
        const page = await call(() => reader.uploads(state.uploads.cursor, state.options.page_size, state.options.prefix))
        page.items.forEach(row => scoped(row.key))
        state.pending = { rows: page.items, index: 0, next: page.next, parts: { after: 0, count: 0, bytes: 0 } }
        await save()
      }
      const pending = state.pending
      const row = pending.rows[pending.index]
      if (! row) {
        state.uploads = { complete: pending.next === null, cursor: pending.next, error: null }
        state.pending = null
        await save()
        continue
      }
      let parts: RecordRow['parts']
      if (state.options.parts) {
        try {
          const page = await call(() => reader.parts(row, pending.parts.after, state.options.page_size))
          const count = pending.parts.count + page.count
          const bytes = pending.parts.bytes + page.bytes
          if (! Number.isSafeInteger(bytes))
            throw new Error('invalid_oss_inventory_response')
          if (page.next !== null) {
            pending.parts = { after: page.next, count, bytes }
            await save()
            continue
          }
          parts = { count, bytes, complete: true, error: null }
        }
        catch (error) {
          const code = inventory_error(error)
          if (code !== 'upload_disappeared')
            throw error
          parts = { count: pending.parts.count, bytes: pending.parts.bytes, complete: false, error: code }
        }
      }
      const protected_by = await protection(row.key, row.upload_id)
      const result: RecordRow = { ... row, protection: protected_by, action: parts?.error ? 'upload_disappeared' : action(state, row, protected_by),
        executable: false, observed_at: new Date(now()).toISOString(), ... (parts ? { parts } : {}) }
      pending.index ++
      pending.parts = { after: 0, count: 0, bytes: 0 }
      state.uploads.error = null
      await save([result])
    }
    catch (error) {
      if (error instanceof PersistenceError)
        throw error
      state.uploads.error = inventory_error(error)
      await save()
      break
    }
  }
  return inventory_summary(state)
}
