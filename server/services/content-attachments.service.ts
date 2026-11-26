import type { StorageBucket } from '@server/lib/storage'
import type { ContentStoryAttachment } from '@shared/types/content'

import type { Connection, RowDataPacket } from 'mysql2/promise'

import { createHash } from 'node:crypto'

import { db } from '@server/lib/db'

import { attachment_mime_type, attachment_redaction_path, compare_attachment_names } from '@shared/content-markdown'

import { content_name_key } from '@shared/content-reference'
import { attachment_owned_object_keys } from './content/attachment-objects'
import { image_presentation } from './content/image-presentation'

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
  redacted_display_key?: string | null
  redacted_fallback_key?: string | null
  redacted_revision?: number
  redacted_metadata?: unknown
  redacted_lqip?: Buffer | null
  original_key?: string | null
  display_key?: string | null
  fallback_key?: string | null
  image_revision?: number
  image_metadata?: unknown
  lqip?: Buffer | null
  id: number
  story_id: number | null
  is_folder: number
  file_name: string
  object_key: string | null
  mime_type: string | null
  file_size: number
  version: string
  is_private: number
  storage_bucket: StorageBucket
  oss_version_id?: string | null
}

/** Bind reads to object identity even when a replacement has the same ETag. */
export function attachment_access_version(row: Pick<AttachmentRow, 'version' | 'object_key' | 'storage_bucket' | 'is_private' | 'oss_version_id'> & { redacted_revision?: number }) {
  // The provider literal keeps issued URLs and cache keys stable.
  const identity = [row.version, row.object_key, row.storage_bucket, Number(row.is_private), 'aliyun', row.oss_version_id ?? '']
  if (Number(row.redacted_revision) > 0)
    identity.push(String(row.redacted_revision))
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

/** Stable same-origin entry; no expiring credentials in payloads or Markdown. */
export function attachment_object_url(row: Pick<AttachmentRow, 'id' | 'version' | 'object_key' | 'storage_bucket' | 'is_private' | 'oss_version_id'>) {
  return `/api/links/attachments/${Number(row.id)}?version=${attachment_access_version(row)}`
}

function format_row(row: AttachmentRow, private_readable = false, redaction?: AttachmentRow, is_redaction = false): ContentStoryAttachment {
  const mime_type = row.mime_type ?? attachment_mime_type(row.file_name)
  const redacted = Boolean(row.is_private && ! private_readable && redaction)
  const image = image_presentation(row, private_readable)
  const redacted_image = redaction ? image_presentation(redaction, true) : undefined
  return {
    ... (image ? { image } : {}),
    has_redacted: Boolean(redaction),
    is_redaction,
    is_redacted_view: redacted,
    ... (redaction ? { redacted_url: attachment_object_url(redaction), ... (redacted_image ? { redacted_image } : {}) } : {}),
    id: Number(row.id),
    file_name: row.file_name,
    mime_type,
    file_size: Number(row.file_size),
    version: row.version,
    is_image: (mime_type ?? '').startsWith('image/'),
    url: row.is_private && ! private_readable ? null : attachment_object_url(row),
    is_private: Boolean(row.is_private),
  }
}

/** Each private file's public 删减版, keyed by the private row id (see attachment_redaction_path). */
export function redaction_rows<T extends Pick<AttachmentRow, 'id' | 'file_name' | 'is_folder' | 'is_private' | 'object_key'>>(rows: readonly T[]) {
  const public_files = new Map(rows.filter(row => ! row.is_folder && ! row.is_private && row.object_key).map(row => [content_name_key(row.file_name), row]))
  const twins = new Map<number, T>()
  for (const row of rows) {
    const path = ! row.is_folder && row.is_private ? attachment_redaction_path(row.file_name) : null
    const twin = path ? public_files.get(content_name_key(path)) : undefined
    if (twin)
      twins.set(Number(row.id), twin)
  }
  return twins
}

export async function list_scope_attachments(story_id: number, executor: DbExecutor = db, private_readable = false) {
  const [rows] = await executor.execute<AttachmentRow[]>(
    'SELECT * FROM content_story_attachments WHERE story_id = ? AND is_folder = 0',
    [story_id],
  )
  const twins = redaction_rows(rows)
  const redaction_ids = new Set([... twins.values()].map(twin => Number(twin.id)))
  return rows
    .map(row => format_row(row, private_readable, twins.get(Number(row.id)), redaction_ids.has(Number(row.id))))
    .sort((a, b) => compare_attachment_names(a.file_name, b.file_name))
}

export async function get_scope_attachment_by_id(story_id: number, id: number) {
  const [rows] = await db.execute<AttachmentRow[]>('SELECT * FROM content_story_attachments WHERE story_id = ? AND id = ? AND is_folder = 0', [story_id, id])
  return rows[0] ? format_row(rows[0]) : null
}

/** Every object key owned by a story (delete_story collects before removing rows). */
export async function get_story_object_keys(story_id: number, executor: DbExecutor = db) {
  const [rows] = await executor.execute<AttachmentRow[]>(
    'SELECT object_key, original_key, display_key, fallback_key, redacted_display_key, redacted_fallback_key, storage_bucket FROM content_story_attachments WHERE story_id = ? AND is_folder = 0',
    [story_id],
  )
  return rows.flatMap(row => attachment_owned_object_keys(row).map(key => ({ bucket: row.storage_bucket, key, provider: 'aliyun' as const })))
}

/** Raw file rows for server-side object identity and publication checks. */
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

/** Removes attachments in the deletion transaction before deleting the story row. */
export async function delete_story_attachment_rows(story_id: number, executor: DbExecutor = db) {
  await executor.execute(
    'DELETE FROM content_story_attachments WHERE story_id = ?',
    [story_id],
  )
}

/** Cover reads and change detection use only the named attachment's public representation. */
type CoverRow = Pick<AttachmentRow, 'id' | 'file_name' | 'object_key' | 'version' | 'storage_bucket' | 'oss_version_id' | 'is_private'> & Partial<AttachmentRow>

function cover_attachment(file_name: string, rows: CoverRow[]) {
  const row = rows.find(row => content_name_key(row.file_name) === content_name_key(file_name) && ! row.is_folder && row.object_key)
  if (! row)
    return null
  if (! row.is_private)
    return row
  return redaction_rows(rows.map(item => ({ ... item, is_folder: Number(item.is_folder ?? 0) }))).get(Number(row.id)) ?? null
}

export function attachment_cover_url(file_name: string, rows: CoverRow[]) {
  const row = cover_attachment(file_name, rows)
  return row ? attachment_object_url(row) : null
}

/** Public cover projections, keyed `story_id:file_name`; never expose normal private metadata. */
export async function list_cover_presentations(covers: { story_id: number, file_name: string }[], executor: DbExecutor = db) {
  const urls = new Map<string, { url: string, image: ContentStoryAttachment['image'] }>()
  if (! covers.length)
    return urls
  // file_name uses binary collation; fetch the scopes before applying the same
  // Unicode identity rule used by Markdown and workspace names. Fetch image
  // metadata only for the matching rows, rather than for every attachment.
  const scopes = [... new Set(covers.map(cover => cover.story_id))]
  const wanted = new Map<number, Set<string>>()
  for (const cover of covers) {
    const names = wanted.get(cover.story_id) ?? new Set<string>()
    names.add(content_name_key(cover.file_name))
    const twin = attachment_redaction_path(cover.file_name)
    if (twin)
      names.add(content_name_key(twin))
    wanted.set(cover.story_id, names)
  }
  const [candidates] = await executor.execute<AttachmentRow[]>(
    `SELECT id, story_id, file_name FROM content_story_attachments WHERE is_folder = 0 AND story_id IN (${scopes.map(() => '?').join(', ')})`,
    scopes,
  )
  const ids = candidates.filter(row => wanted.get(Number(row.story_id))?.has(content_name_key(row.file_name))).map(row => Number(row.id))
  if (! ids.length)
    return urls
  const [rows] = await executor.execute<AttachmentRow[]>(
    `SELECT id, story_id, file_name, is_folder, object_key, version, storage_bucket, oss_version_id, is_private,
      display_key, fallback_key, image_revision, image_metadata, lqip
      FROM content_story_attachments WHERE is_folder = 0 AND id IN (${ids.map(() => '?').join(', ')})`,
    ids,
  )
  const by_story = new Map<number, AttachmentRow[]>()
  for (const row of rows) {
    const scope = Number(row.story_id)
    const group = by_story.get(scope) ?? []
    group.push(row)
    by_story.set(scope, group)
  }
  for (const cover of covers) {
    const row = cover_attachment(cover.file_name, by_story.get(cover.story_id) ?? [])
    if (row)
      urls.set(`${cover.story_id}:${cover.file_name}`, { url: attachment_object_url(row), image: image_presentation(row, false) })
  }
  return urls
}
