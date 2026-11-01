import type { RowDataPacket } from 'mysql2/promise'
import type { MigrationReadContext } from '../scripts/migration/contract'
import { define_migration } from '../scripts/migration/contract'

const tables = ['content_task_items', 'content_tasks', 'content_locks', 'content_attachment_encryption_backup', 'content_attachment_storage_migrations'] as const

async function inventory(ctx: MigrationReadContext) {
  const [existing] = await ctx.db.execute<RowDataPacket[]>('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()')
  const present = new Set(existing.map(row => String(row.name)))
  const counts: Record<string, number> = {}
  for (const table of tables) {
    ctx.signal.throwIfAborted()
    if (present.has(table)) {
      const [rows] = await ctx.db.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`)
      counts[table] = Number(rows[0]!.n)
    }
  }
  return counts
}

export default define_migration({
  async plan(ctx) {
    const counts = await inventory(ctx)
    return { summary: 'Retire five unused Content tables only when every remaining table is empty', counts, blocked: Object.values(counts).some(Boolean) }
  },
  async apply(ctx) {
    // Check ALL tables before the first implicit-commit DDL; never discard old work.
    if (Object.values(await inventory(ctx)).some(Boolean))
      throw new Error('legacy_content_tables_not_empty')
    for (const table of tables) {
      await ctx.assert_active()
      await ctx.db.query(`DROP TABLE IF EXISTS ${table}`)
    }
  },
  async verify(ctx) {
    return Object.keys(await inventory(ctx)).length === 0
  },
})
