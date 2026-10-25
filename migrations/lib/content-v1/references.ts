import type { RowDataPacket } from 'mysql2/promise'
import type { MigrationContext, MigrationReadContext } from '../../../scripts/migration/contract'
import { enqueue_workspace_change } from '@server/services/content/workspace-sync.service'
import { upgrade_legacy_refs } from '@shared/content-markdown'
import { digest } from './plan'
import { pending_work, require_quiet } from './preflight'

interface Row extends RowDataPacket { id: number, markdown: string, revision: number }
export async function reference_plan(ctx: MigrationReadContext) {
  const [rows] = await ctx.db.query<Row[]>('SELECT id,markdown,revision FROM content_stories ORDER BY id')
  const pending = await pending_work(ctx.db)
  return { summary: '正文引用转换', counts: { ... pending, stories: rows.length, changed: rows.filter(row => upgrade_legacy_refs(row.markdown) !== row.markdown).length }, blocked: Object.values(pending).some(Boolean) }
}
export async function migrate_references(ctx: MigrationContext) {
  await require_quiet(ctx.db)
  const [rows] = await ctx.db.query<Row[]>('SELECT id,markdown,revision FROM content_stories ORDER BY id')
  for (const source of rows) {
    ctx.signal.throwIfAborted()
    await ctx.transaction(async (db) => {
      const [[row]] = await db.query<Row[]>('SELECT id,markdown,revision FROM content_stories WHERE id=? FOR UPDATE', [source.id])
      if (! row)
        throw new Error('story_changed')
      const rewritten = upgrade_legacy_refs(row.markdown)
      if (rewritten !== row.markdown) {
        await db.execute('INSERT INTO content_migration_references(story_id,source_markdown,source_revision,result_sha256) VALUES (?,?,?,?)', [row.id, row.markdown, row.revision, digest(rewritten)])
        await db.execute('UPDATE content_stories SET markdown=?, namespace_revision=namespace_revision+1, namespace_floor=namespace_revision, updated_at=updated_at WHERE id=?', [rewritten, row.id])
        await enqueue_workspace_change(db, row.id, { story: true, stories: true })
      }
      await ctx.checkpoint.save({ last_story: Number(row.id) })
    })
  }
}
export async function verify_references(ctx: MigrationReadContext) {
  const report = await reference_plan(ctx)
  return report.counts.changed === 0
}
