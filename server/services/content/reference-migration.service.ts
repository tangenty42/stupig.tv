import type { RowDataPacket } from 'mysql2/promise'
import { db } from '@server/lib/db'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { extract_attachment_names, extract_story_reference_titles, upgrade_legacy_refs } from '@shared/content-markdown'

interface ReferenceMigrationRow extends RowDataPacket {
  id: number
  markdown: string
}

export interface ReferenceMigrationReport {
  story_id: number
  changed: boolean
  applied: boolean
  attachment_targets: number
  story_targets: number
}

/** Default is report-only; apply re-reads each story under its row lock. */
export async function migrate_content_references(apply = false, report: (item: ReferenceMigrationReport) => void = () => {}) {
  const [stories] = await db.execute<ReferenceMigrationRow[]>('SELECT id, markdown FROM content_stories ORDER BY id')
  const results: ReferenceMigrationReport[] = []
  for (const story of stories) {
    const connection = apply ? await db.getConnection() : null
    let markdown = story.markdown
    let changed = false
    try {
      if (connection) {
        await connection.beginTransaction()
        const [rows] = await connection.execute<ReferenceMigrationRow[]>('SELECT id, markdown FROM content_stories WHERE id = ? FOR UPDATE', [story.id])
        if (! rows[0]) {
          await connection.commit()
          continue
        }
        markdown = rows[0].markdown
      }
      const rewritten = upgrade_legacy_refs(markdown)
      changed = rewritten !== markdown
      if (connection && changed) {
        // Metadata/cover and related ids have the same meaning; revision remains untouched.
        await connection.execute('UPDATE content_stories SET markdown = ? WHERE id = ?', [rewritten, story.id])
      }
      await connection?.commit()
      if (apply && changed)
        publish_refresh({ resource: sync_resource('content_story', story.id) })
      const item = {
        story_id: story.id,
        changed,
        applied: apply && changed,
        attachment_targets: extract_attachment_names(markdown).length,
        story_targets: extract_story_reference_titles(markdown).length,
      }
      results.push(item)
      report(item)
    }
    catch (error) {
      await connection?.rollback()
      throw error
    }
    finally {
      connection?.release()
    }
  }
  return results
}
