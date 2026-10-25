import type { AuthUser } from '@server/types/auth'
import type { RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { create_esa } from '@server/lib/esa'
import { list_scope_file_rows } from '@server/services/content-attachments.service'
import { has_permission } from '@shared/permissions'
import { settings } from '@shared/settings'
import { resolve_attachment_delivery } from './attachment-access.service'
/**
 * Signs a short-lived object GET that saves the attachment under its row name.
 *
 * ESA rechecks the signed capability against current authorization before each
 * read, including cache hits. Filename metadata is covered by the signature.
 */
export async function sign_attachment_download(story_id: number, file_name: string, viewer: AuthUser | null = null, role: 'avif' | 'original' | 'redacted_avif' = 'avif') {
  const [stories] = await db.execute<RowDataPacket[]>('SELECT id FROM content_stories WHERE id = ?', [story_id])
  if (! stories.length)
    throw new ApiError(404, '档案不存在或已被删除')
  const rows = await list_scope_file_rows(story_id, [file_name])
  const row = rows[0]
  if (! row)
    throw new ApiError(404, '附件不存在或已被删除')
  // Retired storage and encrypted rows must be migrated before signing.
  if (row.encryption_key !== null || row.storage_provider !== 'aliyun')
    throw new ApiError(503, '附件尚未完成迁移')
  if (row.is_private && role !== 'redacted_avif' && ! has_permission(viewer, 'content_private', 'read'))
    throw new ApiError(403, '你没有机密附件的读取权限')

  const object = await resolve_attachment_delivery(row, role === 'redacted_avif' ? role : role === 'original' ? 'original' : row.avif_key ? 'avif' : 'auto', viewer)
  return { url: create_esa().signed_read_url(object.key, settings.app.content.download.urlTtlSeconds, 'GET', object.name, 'attachment', object.grant) }
}
