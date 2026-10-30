import type { RowDataPacket } from 'mysql2/promise'
import type { MigrationDatabase } from '../scripts/migration/contract'
import { define_migration } from '../scripts/migration/contract'

interface LegacyBatch extends RowDataPacket {
  scope_id: number
  revision: number
  changes: string | { node_id: number, from: string, to: string | null, is_folder?: boolean }[]
  created_at: string | Date
}

// Frozen conversion: do not import the evolving runtime parser or settings.
const batch_limit = 200
const key = (ref: string | null) => ref === null ? null : ref.normalize('NFC').toLowerCase()

async function has_legacy_column(db: MigrationDatabase) {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'content_reference_journals' AND column_name = 'changes'`)
  return Number(rows[0]?.count) > 0
}

export default define_migration({
  plan: async ({ db }) => {
    const [rows] = await db.execute<RowDataPacket[]>('SELECT COUNT(*) AS entries, COUNT(DISTINCT scope_id, revision) AS batches FROM content_reference_journals')
    return { summary: 'Convert reference batches to URI event rows and retain 200 complete batches per scope', counts: { entries: Number(rows[0]?.entries), batches: Number(rows[0]?.batches) } }
  },
  apply: async (ctx) => {
    if (await has_legacy_column(ctx.db)) {
      while (true) {
        await ctx.assert_active()
        const converted = await ctx.transaction(async (db) => {
          const [rows] = await db.execute<LegacyBatch[]>('SELECT scope_id, revision, changes, created_at FROM content_reference_journals WHERE changes IS NOT NULL ORDER BY scope_id, revision LIMIT 1 FOR UPDATE')
          const row = rows[0]
          if (! row)
            return false
          const changes: Exclude<LegacyBatch['changes'], string> = typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes
          const scheme = Number(row.scope_id) === 0 ? 'content://' : 'att://'
          const entries = changes.length
            ? changes.map(change => ({
                node_id: change.node_id, from: scheme + change.from.replace(/\/$/, ''),
                to: change.to === null ? null : scheme + change.to.replace(/\/$/, ''), is_folder: Boolean(change.is_folder),
              }))
            : [{ node_id: 0, from: null, to: null, is_folder: false }]
          await db.execute('DELETE FROM content_reference_journals WHERE scope_id = ? AND revision = ?', [row.scope_id, row.revision])
          await db.execute(`INSERT INTO content_reference_journals
            (scope_id, revision, entry_index, node_id, from_ref, to_ref, from_key, to_key, is_folder, created_at)
            VALUES ${entries.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          entries.flatMap((entry, index) => [row.scope_id, row.revision, index, entry.node_id, entry.from, entry.to, key(entry.from), key(entry.to), entry.is_folder, row.created_at]))
          return true
        })
        if (! converted)
          break
      }
    }
    const [scopes] = await ctx.db.execute<RowDataPacket[]>('SELECT DISTINCT scope_id FROM content_reference_journals ORDER BY scope_id')
    for (const scope of scopes) {
      await ctx.assert_active()
      await ctx.transaction(async (db) => {
        const [rows] = await db.execute<RowDataPacket[]>('SELECT DISTINCT revision FROM content_reference_journals WHERE scope_id = ? ORDER BY revision DESC LIMIT 1 OFFSET ?', [scope.scope_id, batch_limit])
        if (! rows[0])
          return
        const floor = Number(rows[0].revision)
        if (Number(scope.scope_id) === 0)
          await db.execute('UPDATE content_title_namespace SET revision_floor = GREATEST(revision_floor, ?) WHERE id = 1', [floor])
        else
          await db.execute('UPDATE content_stories SET namespace_floor = GREATEST(namespace_floor, ?), updated_at = updated_at WHERE id = ?', [floor, scope.scope_id])
        await db.execute('DELETE FROM content_reference_journals WHERE scope_id = ? AND revision <= ?', [scope.scope_id, floor])
      })
    }
  },
  verify: async ({ db }) => {
    if (await has_legacy_column(db)) {
      const [pending] = await db.execute<RowDataPacket[]>('SELECT COUNT(*) AS count FROM content_reference_journals WHERE changes IS NOT NULL')
      if (Number(pending[0]?.count))
        return false
    }
    const [oversized] = await db.execute<RowDataPacket[]>('SELECT scope_id FROM content_reference_journals GROUP BY scope_id HAVING COUNT(DISTINCT revision) > ?', [batch_limit])
    return oversized.length === 0
  },
})
