import type { AuthUser } from '@server/types/auth'
import type { ContentAttachmentWorkspace } from '@shared/types/content'
import type { RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { list_scope_attachments } from '@server/services/content-attachments.service'
import { has_permission } from '@shared/permissions'
import { workspace_node_versions, workspace_rows } from './workspace.repository'

/** Coherent namespace snapshot, independent of body/title/task reads. */
export async function get_attachment_workspace(story_id: number, viewer: AuthUser | null): Promise<ContentAttachmentWorkspace> {
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    const [stories] = await connection.execute<RowDataPacket[]>('SELECT namespace_revision FROM content_stories WHERE id = ? FOR SHARE', [story_id])
    if (! stories[0])
      throw new ApiError(404, '档案不存在或已被删除')
    const rows = await workspace_rows(connection, story_id)
    const can_private = has_permission(viewer, 'content_private', 'read')
    const attachments = await list_scope_attachments(story_id, connection, can_private)
    const versions = workspace_node_versions(rows)
    const attachments_by_id = new Map(attachments.map(attachment => [attachment.id, attachment]))
    for (const attachment of attachments) {
      attachment.node_version = versions.get(Number(attachment.id))!
      if (attachment.is_private && ! can_private && ! attachment.is_redacted_view)
        attachment.url = null
    }
    const payload = {
      root_id: Number(rows.find(row => row.parent_id === 0)?.id ?? 0),
      nodes: rows.filter(row => row.parent_id !== 0).map(row => ({ id: Number(row.id), parent_id: Number(row.parent_id), name: row.name, path: row.file_name,
        kind: row.is_folder ? 'folder' as const : 'file' as const, version: versions.get(Number(row.id))!, attachment: attachments_by_id.get(Number(row.id)) })),
      attachments,
      folders: rows.filter(row => row.is_folder && row.parent_id !== 0).map(row => row.file_name),
      namespace_revision: Number(stories[0].namespace_revision),
      viewer_key: `${viewer?.id ?? 'anon'}:${can_private}`,
    }
    await connection.commit()
    return payload
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally {
    connection.release()
  }
}
