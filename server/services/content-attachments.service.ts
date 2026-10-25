import type { StorageBucket } from '@server/lib/storage'

import type { ContentStoryAttachment } from '@shared/types/content'

import type { Connection, RowDataPacket } from 'mysql2/promise'

import { createHash } from 'node:crypto'

import { db } from '@server/lib/db'

import { attachment_mime_type, compare_attachment_names, decrypted_attachment_name } from '@shared/content-markdown'
import { attachment_owned_object_keys } from './content/attachment-objects'
import { image_presentation } from './content/image-presentation'
import { has_redacted_variant, redacted_presentation_row } from './content/redacted-variant'

/**
 * The pool or a transaction connection. Structure changes run their
 * read-check-write sequence on one connection so a half-applied batch (the
 * two-phase move rename can fail between its loops) rolls back instead of
 * leaving `.mvtmp-` rows behind.
 */
export type DbExecutor = Connection

// The rows are the source of truth for attachment display state; the OSS
// object is addressed only through object_key (content/att/<uuid> for new
// uploads), so rename/move are pure row updates.

interface AttachmentRow extends RowDataPacket {
  redacted_avif_key?: string | null
  redacted_jpeg_key?: string | null
  redacted_revision?: number
  redacted_metadata?: unknown
  redacted_lqip_jpeg?: Buffer | null
  original_key?: string | null
  avif_key?: string | null
  jpeg_key?: string | null
  image_revision?: number
  image_metadata?: unknown
  lqip_jpeg?: Buffer | null
  id: number
  story_id: number | null
  is_folder: number
  file_name: string
  object_key: string | null
  mime_type: string | null
  file_size: number
  version: string
  encryption_key: string | null
  is_private: number
  storage_bucket: StorageBucket
  storage_provider?: 'legacy' | 'aliyun'
  oss_version_id?: string | null
}

/** Bind reads to object identity even when a replacement has the same ETag. */
export function attachment_access_version(row: Pick<AttachmentRow, 'version' | 'object_key' | 'storage_bucket' | 'is_private' | 'storage_provider' | 'oss_version_id'> & { redacted_revision?: number }) {
  const identity = [row.version, row.object_key, row.storage_bucket, Number(row.is_private)]
  // Keep existing legacy URLs valid; new provider identity must invalidate them.
  if (row.storage_provider === 'aliyun')
    identity.push(row.storage_provider, row.oss_version_id ?? '')
  if (Number(row.redacted_revision) > 0)
    identity.push(String(row.redacted_revision))
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

/** Stable same-origin entry; no expiring credentials in payloads or Markdown. */
export function attachment_object_url(row: Pick<AttachmentRow, 'id' | 'version' | 'object_key' | 'storage_bucket' | 'is_private' | 'storage_provider' | 'oss_version_id'>) {
  return `/api/content/attachments/${Number(row.id)}?version=${attachment_access_version(row)}`
}

function format_row(row: AttachmentRow, private_readable = false): ContentStoryAttachment {
  const mime_type = row.mime_type ?? attachment_mime_type(row.file_name)
  const redacted = Boolean(row.is_private && ! private_readable && has_redacted_variant(row))
  const image = image_presentation(row, private_readable)
  const redacted_image = has_redacted_variant(row) ? image_presentation({ ... redacted_presentation_row(row), is_private: false }, true) : undefined
  return {
    ... (image ? { image } : {}),
    has_redacted: has_redacted_variant(row),
    is_redacted_view: redacted,
    ... (redacted_image ? { redacted_image, redacted_url: `${attachment_object_url(row)}&role=redacted` } : {}),
    id: Number(row.id),
    file_name: row.file_name,
    mime_type,
    file_size: Number(row.file_size),
    version: row.version,
    is_image: (mime_type ?? '').startsWith('image/'),
    url: row.is_private && ! private_readable ? null : attachment_object_url(row),
    is_private: Boolean(row.is_private),
    is_encrypted: row.encryption_key !== null,
  }
}

export async function list_scope_attachments(story_id: number, executor: DbExecutor = db, private_readable = false) {
  const [rows] = await executor.execute<AttachmentRow[]>(
    'SELECT * FROM content_story_attachments WHERE story_id = ? AND is_folder = 0',
    [story_id],
  )
  return rows
    .map(row => format_row(row, private_readable))
    .sort((a, b) => compare_attachment_names(a.file_name, b.file_name))
}

export async function get_scope_attachment_by_id(story_id: number, id: number) {
  const [rows] = await db.execute<AttachmentRow[]>('SELECT * FROM content_story_attachments WHERE story_id = ? AND id = ? AND is_folder = 0', [story_id, id])
  return rows[0] ? format_row(rows[0]) : null
}

/** Every object key owned by a story (delete_story collects before removing rows). */
export async function get_story_object_keys(story_id: number, executor: DbExecutor = db) {
  const [rows] = await executor.execute<AttachmentRow[]>(
    'SELECT object_key, original_key, avif_key, jpeg_key, redacted_avif_key, redacted_jpeg_key, storage_bucket, storage_provider FROM content_story_attachments WHERE story_id = ? AND is_folder = 0',
    [story_id],
  )
  return rows.flatMap(row => attachment_owned_object_keys(row).map(key => ({ bucket: row.storage_bucket, key, ... (row.storage_provider === 'aliyun' ? { provider: 'aliyun' as const } : {}) })))
}

/** Raw file rows by name (encrypt/decrypt need object_key and encryption_key, which format_row drops). */
export async function list_scope_file_rows(story_id: number, file_names: string[], executor: DbExecutor = db) {
  if (! file_names.length)
    return []
  const placeholders = file_names.map(() => '?').join(',')
  const [rows] = await executor.execute<AttachmentRow[]>(
    `SELECT * FROM content_story_attachments WHERE story_id = ? AND file_name IN (${placeholders}) AND is_folder = 0`,
    [story_id, ... file_names],
  )
  return rows
}

/** Removes every row of a story; the story row is already gone (no FK cascade). */
export async function delete_story_attachment_rows(story_id: number, executor: DbExecutor = db) {
  await executor.execute(
    'DELETE FROM content_story_attachments WHERE story_id = ?',
    [story_id],
  )
}

/** Shared by cover reads and transactional change detection, including public redacted twins. */
export function attachment_cover_url(file_name: string, rows: (Pick<AttachmentRow, 'id' | 'file_name' | 'object_key' | 'version' | 'storage_bucket' | 'storage_provider' | 'oss_version_id' | 'is_private'> & { is_folder?: number, encryption_key?: string | null, redacted_avif_key?: string | null, redacted_jpeg_key?: string | null, redacted_revision?: number })[]) {
  const public_file = (name: string) => rows.find(row => row.file_name === name && ! row.is_folder && ! row.is_private && ! row.encryption_key && row.object_key)
  const redacted = rows.find(row => row.file_name === file_name && row.is_private && ! row.is_folder && ! row.encryption_key && has_redacted_variant(row))
  if (redacted)
    return `${attachment_object_url(redacted)}&role=redacted`
  const row = public_file(file_name) ?? (file_name.endsWith('.good') ? public_file(decrypted_attachment_name(file_name)) : undefined)
  return row ? attachment_object_url(row) : null
}

/** Cover URLs for story list cards, keyed `story_id:file_name`. */
export async function list_cover_urls(covers: { story_id: number, file_name: string }[], executor: DbExecutor = db) {
  const urls = new Map<string, string>()
  if (! covers.length)
    return urls
  const candidates = covers.flatMap(cover => cover.file_name.endsWith('.good') ? [cover, { ... cover, file_name: decrypted_attachment_name(cover.file_name) }] : [cover])
  const tuples = candidates.map(() => '(?, ?)').join(',')
  const [rows] = await executor.execute<AttachmentRow[]>(
    `SELECT id, story_id, file_name, object_key, version, storage_bucket, storage_provider, oss_version_id, is_private, redacted_avif_key, redacted_jpeg_key, redacted_revision FROM content_story_attachments WHERE is_folder = 0 AND encryption_key IS NULL AND (story_id, file_name) IN (${tuples})`,
    candidates.flatMap(cover => [cover.story_id, cover.file_name]),
  )
  const by_story = new Map<number, AttachmentRow[]>()
  for (const row of rows) {
    const scope = Number(row.story_id)
    const group = by_story.get(scope) ?? []
    group.push(row)
    by_story.set(scope, group)
  }
  for (const cover of covers) {
    const url = attachment_cover_url(cover.file_name, by_story.get(cover.story_id) ?? [])
    if (url)
      urls.set(`${cover.story_id}:${cover.file_name}`, url)
  }
  return urls
}
