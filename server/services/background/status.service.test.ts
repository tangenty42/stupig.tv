import type { Pool } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'

vi.mock('@config/loader', () => ({ runtime_config: () => ({ app: { backgroundRunner: { mode: 'app' } } }) }))
vi.mock('@server/lib/db', () => ({ db: {} }))
vi.mock('@server/services/content/background.service', () => ({ local_background_status: () => null }))
const { read_background_ledgers } = await import('./status.service')

it('aggregates six domain ledgers and target leases without exposing payloads or raw errors', async () => {
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes('FROM content_preload_sites'))
      return [[{ total: '2', leased: '1', last_error_code: 'permission_denied', base_url: 'secret' }]]
    if (sql.includes('FROM storage_audit_findings'))
      return [[{ kind: 'orphan_candidate', total: '2' }]]
    if (sql.includes('FROM storage_audit_targets ORDER BY'))
      return [[{ destination_id: 'a'.repeat(64), phase: 'objects', references_checked: '20', objects_checked: '100', last_error_code: 'https://signed.secret/?auth_key=x' }]]
    return [[{ phase: 'queued', error_code: 'https://signed.secret/?auth_key=x', total: '3', pending: '2', due: '1', leased: '1', oldest_pending_at: new Date('2026-10-24T00:00:00Z'), payload: 'secret' }]]
  })
  const result = await read_background_ledgers({ execute } as unknown as Pool)
  expect(result.ledgers.map(group => group.id)).toEqual(['images', 'uploads', 'retirement', 'preload', 'sync', 'storage_audit'])
  expect(result.ledgers[0]!.groups[0]).toEqual({ phase: 'queued', error_code: null, total: 3, pending: 2, due: 1, leased: 1, oldest_pending_at: '2026-10-24T00:00:00.000Z' })
  expect(result.preload_targets).toEqual([{ total: 2, leased: 1, error_code: 'permission_denied' }])
  expect(result.storage_audit_findings).toEqual([{ kind: 'orphan_candidate', total: 2 }])
  expect(result.storage_audit[0]).toMatchObject({ phase: 'objects', references_checked: 20, objects_checked: 100, error_code: null })
  expect(JSON.stringify(result)).not.toContain('secret')
  expect(execute).toHaveBeenCalledTimes(9)
})
