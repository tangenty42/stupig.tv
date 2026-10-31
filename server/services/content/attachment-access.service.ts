import type { StorageBucket } from '@server/lib/storage'
import type { AuthUser } from '@server/types/auth'
import type { RowDataPacket } from 'mysql2/promise'
import { createHash } from 'node:crypto'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { create_esa } from '@server/lib/esa'
import { attachment_access_version } from '@server/services/content-attachments.service'
import { attachment_download_name } from '@shared/content-markdown'
import { has_permission } from '@shared/permissions'
import { settings } from '@shared/settings'
import { has_redacted_variant } from './redacted-variant'

export interface ImageAccessRow {
  id?: number
  story_id?: number | null
  object_key: string | null
  file_name: string
  version: string
  storage_bucket: StorageBucket
  storage_provider?: 'legacy' | 'aliyun'
  oss_version_id?: string | null
  is_private: number
  encryption_key: string | null
  original_key?: string | null
  avif_key?: string | null
  jpeg_key?: string | null
  image_metadata?: unknown
  redacted_avif_key?: string | null
  redacted_jpeg_key?: string | null
  redacted_revision?: number
  redacted_metadata?: unknown
  read_revision?: number | string
}
export type ImageReadRole = 'auto' | 'avif' | 'jpeg' | 'original' | 'redacted_avif' | 'redacted_jpeg' | 'redacted'
export function require_attachment_read(row: ImageAccessRow, viewer: AuthUser | null) {
  if (row.storage_provider !== 'aliyun' || row.encryption_key !== null)
    throw new ApiError(503, '附件尚未完成迁移')
  if (row.is_private && ! has_permission(viewer, 'content_private', 'read'))
    throw new ApiError(403, '你没有机密附件的读取权限')
}
export function image_download_name(name: string, extension: 'avif' | 'jpg') {
  return `${attachment_download_name(name).replace(/\.[^.]+$/, '')}.${extension}`
}
export async function resolve_attachment_role(row: ImageAccessRow, role: ImageReadRole, viewer: AuthUser | null, authorize?: (row: ImageAccessRow) => Promise<void>) {
  const redacted = (role === 'redacted' || role.startsWith('redacted_')) || (row.is_private && ! has_permission(viewer, 'content_private', 'read') && role !== 'original')
  if (redacted) {
    if (! has_redacted_variant(row))
      throw new ApiError(404, '删减版尚未创建或已删除')
    // Explicit redaction reads are public. The owner remains confidential.
    const public_row = { ... row, is_private: 0 }
    require_attachment_read(public_row, viewer)
    await authorize?.(public_row)
    const jpeg = role === 'jpeg' || role === 'redacted_jpeg'
    return { key: (jpeg ? row.redacted_jpeg_key : row.redacted_avif_key)!, name: image_download_name(row.file_name, jpeg ? 'jpg' : 'avif') }
  }
  async function check(current: ImageAccessRow) {
    if (authorize) {
      if (current.storage_provider !== 'aliyun' || current.encryption_key !== null)
        throw new ApiError(503, '附件尚未完成迁移')
      await authorize(current)
    }
    else { require_attachment_read(current, viewer) }
  }
  await check(row)
  if (role === 'original') {
    if (! row.original_key)
      throw new ApiError(404, '原图存档不存在')
    const metadata = typeof row.image_metadata === 'string' ? JSON.parse(row.image_metadata) : row.image_metadata as { original?: { name?: string } } | null
    return { key: row.original_key, name: attachment_download_name(metadata?.original?.name ?? row.file_name) }
  }
  if (row.avif_key && row.jpeg_key) {
    const jpeg = role === 'jpeg'
    return { key: jpeg ? row.jpeg_key : row.avif_key, name: image_download_name(row.file_name, jpeg ? 'jpg' : 'avif') }
  }
  if (role !== 'auto')
    throw new ApiError(409, '图片尚未处理就绪')
  if (! row.object_key)
    throw new ApiError(404, '附件不存在或已被删除')
  return { key: row.object_key, name: attachment_download_name(row.file_name) }
}

/** Bind a capability to the current attachment's authorization state. */
export async function resolve_attachment_delivery(row: ImageAccessRow, role: ImageReadRole, viewer: AuthUser | null) {
  if (viewer && (! Number.isSafeInteger(viewer.session_id) || viewer.session_id <= 0
    || ! Number.isSafeInteger(viewer.token_generation_id) || Number(viewer.token_generation_id) <= 0)) {
    throw new ApiError(403, '读取会话无效')
  }
  const dependencies = new Map<number, unknown>()
  const object = await resolve_attachment_role(row, role, viewer, async (current) => {
    require_attachment_read(current, viewer)
    if (! Number.isSafeInteger(Number(current.id)) || Number(current.id) <= 0 || ! /^[1-9]\d*$/.test(String(current.read_revision)))
      throw new ApiError(503, '附件读取身份不完整')
    dependencies.set(Number(current.id), [current.id, String(current.read_revision), attachment_access_version(current),
      current.original_key ?? null, current.avif_key ?? null, current.jpeg_key ?? null, current.image_metadata ?? null,
      current.redacted_avif_key ?? null, current.redacted_jpeg_key ?? null, current.redacted_revision ?? 0])
  })
  const revision = createHash('sha256').update(JSON.stringify([... dependencies.values()])).digest('hex')
  return { ... object, grant: { id: Number(row.id), revision, role, session: viewer?.session_id ?? 0, generation: viewer?.token_generation_id ?? 0 } }
}

/** Stable attachment identity; signatures are issued only against current DB state. */
export async function attachment_redirect(id: number, version: string, viewer: AuthUser | null, method: 'GET' | 'HEAD' = 'GET', role: ImageReadRole = 'auto', accept = '') {
  const [rows] = await db.execute<(RowDataPacket & ImageAccessRow)[]>(
    'SELECT a.* FROM content_story_attachments a INNER JOIN content_stories s ON s.id = a.story_id WHERE a.id = ? AND a.is_folder = 0', [id],
  )
  const row = rows[0]
  if (! row?.object_key)
    throw new ApiError(404, '附件不存在或已被删除')
  if (row.storage_provider !== 'aliyun' || row.encryption_key !== null)
    throw new ApiError(503, '附件尚未完成迁移')
  if (row.is_private && ! has_permission(viewer, 'content_private', 'read') && ! has_redacted_variant(row))
    throw new ApiError(403, '你没有机密附件的读取权限')
  if (! version || attachment_access_version(row) !== version)
    throw new ApiError(409, '附件版本已变化，请刷新后重试')
  const selected = role === 'redacted' ? accept.includes('image/avif') ? 'redacted_avif' : 'redacted_jpeg' : role === 'auto' && row.avif_key && ! accept.includes('image/avif') ? 'jpeg' : role
  const object = await resolve_attachment_delivery(row, selected, viewer)
  return create_esa().signed_read_url(object.key, settings.app.content.read.urlTtlSeconds, method, object.name, 'inline', object.grant)
}

export async function image_editor_source(id: number, version: string, viewer: AuthUser, redacted = false) {
  const [rows] = await db.execute<(RowDataPacket & ImageAccessRow)[]>('SELECT a.* FROM content_story_attachments a INNER JOIN content_stories s ON s.id = a.story_id WHERE a.id = ? AND a.is_folder = 0', [id])
  const row = rows[0]
  if (! row)
    throw new ApiError(404, '图片不存在')
  require_attachment_read(row, viewer)
  if (attachment_access_version(row) !== version || ! row.avif_key || ! row.jpeg_key)
    throw new ApiError(409, '图片尚未处理就绪或版本已变化')
  const base = `/api/content/attachments/${id}?version=${version}`
  const avif_url = `${base}&role=${redacted && has_redacted_variant(row) ? 'redacted_avif' : 'avif'}`
  try {
    await resolve_attachment_role(row, 'original', viewer)
    return { avif_url, original_url: `${base}&role=original`, original_reason: '' }
  }
  catch (error) {
    if (! (error instanceof ApiError) || ! [403, 404].includes(error.statusCode))
      throw error
    return { avif_url, original_url: null, original_reason: error.message }
  }
}
