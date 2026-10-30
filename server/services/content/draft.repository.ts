import type { ContentReferenceJournal } from '@shared/types/content-reference'
import type { Connection, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'
import { replay_content_references } from '@shared/content-reference-replay'
import { enqueue_content_refresh } from './sync-outbox.repository'

export interface DraftRow extends RowDataPacket {
  id: string
  story_id: number | null
  markdown: string
  draft_revision: number
  namespace_revision: number
  title_revision: number
  published_main_revision: number | null
  unpublished_changes: number
  updated_at: string | Date
  lease_epoch: number
  lease_actor_id: number | null
  lease_session_id: number | null
  lease_page_id: string | null
  lease_token_hash: string | null
  until_ms: number | null
  last_command_seq: number
  last_command_hash: string | null
  last_command_result: unknown
}

export const draft_select = 'SELECT d.*, UNIX_TIMESTAMP(d.lease_until) * 1000 AS until_ms FROM content_story_drafts d'

export async function database_now(connection: Pick<Connection, 'execute'>) {
  const [rows] = await connection.execute<RowDataPacket[]>('SELECT UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS now_ms')
  return Number(rows[0]!.now_ms)
}

/** Caller holds the title lock (global) or the owning story lock (namespace). */
export async function rewrite_cloud_drafts(connection: Connection, scope: number, journal: ContentReferenceJournal) {
  const [rows] = await connection.execute<DraftRow[]>(`SELECT * FROM content_story_drafts ${scope ? 'WHERE story_id = ?' : ''} ORDER BY id FOR UPDATE`, scope ? [scope] : [])
  for (const row of rows) {
    const previous = Number(scope ? row.namespace_revision : row.title_revision)
    if (previous === journal.revision)
      continue
    if (previous !== journal.revision - 1)
      throw new ApiError(503, '云端草稿引用基线不一致，请先核对迁移状态')
    const markdown = replay_content_references(row.markdown, {
      attachments: scope ? [journal] : [], titles: scope ? [] : [journal], attachment_targets: [], title_targets: [],
    }, false).markdown
    await connection.execute(`UPDATE content_story_drafts SET markdown = ?, ${scope ? 'namespace_revision' : 'title_revision'} = ?, draft_revision = draft_revision + 1,
      unpublished_changes = NOT EXISTS (SELECT 1 FROM content_stories s WHERE s.id = content_story_drafts.story_id AND BINARY s.markdown = BINARY ?) WHERE id = ?`, [markdown, journal.revision, markdown, row.id])
  }
  await enqueue_content_refresh(connection, rows.map(row => `content_draft:${row.id}`))
}
