import type { MigrationContext } from './contract'
import { describe, expect, it, vi } from 'vitest'
import retirement from '../../migrations/20261101143000_retire_legacy_content'

const names = ['content_task_items', 'content_tasks', 'content_locks', 'content_attachment_encryption_backup', 'content_attachment_storage_migrations']

function fixture(occupied?: string) {
  const present = new Set(names)
  const db = {
    execute: vi.fn(async () => [[... present].map(name => ({ name }))]),
    query: vi.fn(async (sql: string) => {
      const table = sql.split(' ').at(- 1)!
      if (sql.startsWith('DROP TABLE')) {
        present.delete(table)
        return [{}]
      }
      return [[{ n: table === occupied ? 1 : 0 }]]
    }),
  }
  const ctx = { db, signal: new AbortController().signal, assert_active: vi.fn(async () => {}) } as unknown as MigrationContext
  return { db, ctx, present }
}

describe('legacy Content table retirement', () => {
  it.each(names)('refuses all DDL when %s still contains data', async (table) => {
    const { db, ctx, present } = fixture(table)
    expect(retirement.execution).toBe('maintenance')
    expect((await retirement.plan(ctx)).blocked).toBe(true)
    await expect(retirement.apply(ctx)).rejects.toThrow('legacy_content_tables_not_empty')
    expect(present.size).toBe(5)
    expect(db.query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true)
  })

  it('resumes after implicit-commit DDL without recreating tables or losing unrelated ledgers', async () => {
    const { ctx, present } = fixture()
    present.add('migration_runs')
    present.add('content_webp_migration_objects')
    ctx.assert_active = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('interrupted'))
    await expect(retirement.apply(ctx)).rejects.toThrow('interrupted')
    expect(present.has('content_task_items')).toBe(false)
    expect(present.has('content_tasks')).toBe(true)
    expect(await retirement.verify(ctx)).toBe(false)
    ctx.assert_active = async () => {}
    await retirement.apply(ctx)
    expect(await retirement.verify(ctx)).toBe(true)
    await retirement.apply(ctx)
    expect([... present].sort()).toEqual(['content_webp_migration_objects', 'migration_runs'])
  })
})
