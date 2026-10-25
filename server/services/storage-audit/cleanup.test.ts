import type { AuditPool } from './repository'
import { storage_audit_config_schema } from '@config/schema'
import { describe, expect, it, vi } from 'vitest'
import { cleanup_key_pattern, create_orphan_cleanup } from './cleanup'

function fixture(enabled = true) {
  const key = `content/att/staging/${'a'.repeat(32)}/${'b'.repeat(32)}`
  const modified_at = new Date('2020-01-01')
  const state = { completed: true, eligible: true, live: false, tracked: false, static: false }
  const candidate = { id: 1, object_key: Buffer.from(key), observed_size: 3, object_modified_at: modified_at, cycle_id: 'cycle' }
  const execute = vi.fn(async (sql: string): Promise<any> => {
    if (sql.startsWith('SELECT f.id,f.object_key'))
      return [[candidate]]
    if (sql.startsWith('SELECT cycle_id'))
      return [state.completed ? [{}] : []]
    if (sql.startsWith('SELECT f.id FROM storage_audit_findings'))
      return [state.eligible ? [{}] : []]
    if (sql.startsWith('SELECT id FROM content_story_attachments'))
      return [state.live ? [{}] : []]
    if (sql.startsWith('SELECT IF(object_key='))
      return [state.static ? [{ expected_size: null }] : []]
    if (sql.startsWith('SELECT 1 FROM ('))
      return [state.tracked ? [{}] : []]
    throw new Error(`Unexpected query: ${sql}`)
  })
  const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }
  const pool = { execute, getConnection: vi.fn(async () => connection) } as unknown as AuditPool
  const storage = { find_object: vi.fn(async () => ({ key, size: 3, modified_at })) }
  const enqueue = vi.fn(async () => {})
  const options = storage_audit_config_schema.parse({ enabled: true, sweepIntervalSeconds: 30, cycleIntervalSeconds: 86400,
    retrySeconds: 300, leaseSeconds: 300, batchSize: 25, batchBudgetMs: 15000, orphanGraceSeconds: 604800,
    staticKeys: [], orphanCleanup: { enabled } })
  const service = create_orphan_cleanup(pool, storage, { bucket: 'test', endpoint: 'https://oss.example.test' }, options, enqueue)
  return { service, connection, storage, enqueue, state, execute, options, candidate }
}

describe('observed orphan retirement', () => {
  it('defaults to disabled and enforces minimum observation and age thresholds', async () => {
    const f = fixture(false)
    await f.service.sweep()
    expect(f.execute).not.toHaveBeenCalled()
    expect(storage_audit_config_schema.parse({ ... f.options, orphanCleanup: undefined }).orphanCleanup).toEqual({ enabled: false, minAgeSeconds: 604800, minObservations: 2 })
    expect(storage_audit_config_schema.safeParse({ ... f.options, orphanCleanup: { enabled: true, minAgeSeconds: 1, minObservations: 1 } }).success).toBe(false)
  })

  it('queues only through the retirement transaction after a fresh identity and ownership check', async () => {
    const f = fixture()
    await f.service.sweep()
    expect(f.enqueue).toHaveBeenCalledWith(f.connection, f.candidate.object_key.toString())
    expect(f.connection.commit).toHaveBeenCalledOnce()
    expect(f.connection.rollback).not.toHaveBeenCalled()
    expect(f.storage.find_object).toHaveBeenCalledOnce()
  })

  it.each(['completed', 'eligible', 'live', 'tracked', 'static'] as const)('rolls back when %s changes before publication', async (field) => {
    const f = fixture()
    f.state[field] = ! f.state[field]
    await f.service.sweep()
    expect(f.connection.commit).not.toHaveBeenCalled()
    expect(f.connection.rollback).toHaveBeenCalledOnce()
  })

  it('does not enqueue a rewritten or missing object, and cooperates with shutdown', async () => {
    const changed = fixture()
    changed.storage.find_object.mockResolvedValue({ key: changed.candidate.object_key.toString(), size: 3, modified_at: new Date() })
    await changed.service.sweep()
    expect(changed.enqueue).not.toHaveBeenCalled()
    const absent = fixture()
    absent.storage.find_object.mockResolvedValue(null as never)
    await absent.service.sweep()
    expect(absent.enqueue).not.toHaveBeenCalled()
    const stopped = fixture()
    await stopped.service.sweep(AbortSignal.abort())
    expect(stopped.execute).not.toHaveBeenCalled()
  })

  it('never accepts avatars, static assets, arbitrary Content paths or directory markers', () => {
    const pattern = new RegExp(cleanup_key_pattern)
    for (const key of ['avatar/a.png', 'imgs/logo.svg', 'content/att/custom', 'content/att/../file', 'content/att/staging/', 'content-upload/file'])
      expect(pattern.test(key)).toBe(false)
    expect(pattern.test(`content/att/images/${'a'.repeat(32)}/${'b'.repeat(32)}.avif`)).toBe(true)
  })
})
