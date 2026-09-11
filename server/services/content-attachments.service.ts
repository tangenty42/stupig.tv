import type { ContentStoryAttachment } from '@shared/types/content'
import type { Connection, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { attachment_mime_type, compare_attachment_names } from '@shared/content-markdown'

/**
 * The pool or a transaction connection. Structure changes run their
 * read-check-write sequence on one connection so a half-applied batch (the
 * two-phase move rename can fail between its loops) rolls back instead of
 * leaving `.mvtmp-` rows behind.
 */
export type DbExecutor = Connection

// The rows are the source of truth for attachment display state; the OSS
// object is addressed only through object_key (content/att/<uuid> for new
// uploads), so rename/move/claim are pure row updates.

interface AttachmentRow extends RowDataPacket {
  id: number
  story_id: number | null
  is_folder: number
  file_name: string
  object_key: string | null
  mime_type: string | null
  file_size: number
  version: string
}

/** Root-relative object URL (the static host prefixes it at render time). */
export function attachment_object_url(object_key: string, version: string) {
  const encoded = object_key.split('/').map(encodeURIComponent).join('/')
  return `/${encoded}?version=${version}`
}

function format_row(row: AttachmentRow): ContentStoryAttachment {
  const mime_type = row.mime_type ?? attachment_mime_type(row.file_name)
  return {
    file_name: row.file_name,
    mime_type,
    file_size: Number(row.file_size),
    version: row.version,
    is_image: (mime_type ?? '').startsWith('image/'),
    url: attachment_object_url(row.object_key ?? '', row.version),
  }
}

const duplicate_entry_errno = 1062

export async function list_scope_attachments(story_id: number | null) {
  const [rows] = await db.execute<AttachmentRow[]>(
    'SELECT * FROM content_story_attachments WHERE story_id <=> ? AND is_folder = 0',
    [story_id],
  )
  return rows
    .map(format_row)
    .sort((a, b) => compare_attachment_names(a.file_name, b.file_name))
}

/** Explicit folder paths of a scope, sorted (folders implied by file paths are derived client-side). */
export async function list_scope_folders(story_id: number | null) {
  const [rows] = await db.execute<AttachmentRow[]>(
    'SELECT file_name FROM content_story_attachments WHERE story_id <=> ? AND is_folder = 1',
    [story_id],
  )
  return rows
    .map(row => row.file_name)
    .sort(compare_attachment_names)
}

export async function get_scope_attachment(story_id: number | null, file_name: string) {
  const [rows] = await db.execute<AttachmentRow[]>(
    'SELECT * FROM content_story_attachments WHERE story_id <=> ? AND file_name = ? AND is_folder = 0',
    [story_id, file_name],
  )
  return rows[0] ? format_row(rows[0]) : null
}

/** Object keys of the given files (for object deletion after the rows go). */
export async function get_scope_object_keys(story_id: number | null, file_names: string[]) {
  if (! file_names.length)
    return []
  const placeholders = file_names.map(() => '?').join(',')
  const [rows] = await db.execute<AttachmentRow[]>(
    `SELECT object_key FROM content_story_attachments WHERE story_id <=> ? AND file_name IN (${placeholders}) AND is_folder = 0`,
    [story_id, ... file_names],
  )
  return rows.flatMap(row => row.object_key ? [row.object_key] : [])
}

/** Every object key owned by a story (delete_story collects before removing rows). */
export async function get_story_object_keys(story_id: number) {
  const [rows] = await db.execute<AttachmentRow[]>(
    'SELECT object_key FROM content_story_attachments WHERE story_id = ? AND is_folder = 0',
    [story_id],
  )
  return rows.flatMap(row => row.object_key ? [row.object_key] : [])
}

export interface AttachmentRowInput {
  story_id: number | null
  file_name: string
  object_key: string
  mime_type: string | null
  file_size: number
  version: string
}

export async function insert_attachment_row(row: AttachmentRowInput) {
  await db.execute(
    'INSERT INTO content_story_attachments (story_id, file_name, object_key, mime_type, file_size, version) VALUES (?, ?, ?, ?, ?, ?)',
    [row.story_id, row.file_name, row.object_key, row.mime_type, row.file_size, row.version],
  )
}

/** Rename/move: the display path changes, the object key stays. */
export async function rename_attachment_row(story_id: number | null, old_file_name: string, new_file_name: string, executor: DbExecutor = db) {
  try {
    await executor.execute(
      'UPDATE content_story_attachments SET file_name = ? WHERE story_id <=> ? AND file_name = ? AND is_folder = 0',
      [new_file_name, story_id, old_file_name],
    )
  }
  catch (ex) {
    if ((ex as { errno?: unknown }).errno === duplicate_entry_errno)
      throw new ApiError(409, '目标位置已有同名文件')
    throw ex
  }
}

/** In-place replace: fresh object metadata (and possibly a new display path). */
export async function update_attachment_row_object(story_id: number | null, old_file_name: string, object: { file_name: string, object_key: string, mime_type: string | null, file_size: number, version: string }) {
  await db.execute(
    'UPDATE content_story_attachments SET file_name = ?, object_key = ?, mime_type = ?, file_size = ?, version = ? WHERE story_id <=> ? AND file_name = ? AND is_folder = 0',
    [object.file_name, object.object_key, object.mime_type, object.file_size, object.version, story_id, old_file_name],
  )
}

/** Claim: orphan rows (files by name, plus every orphan folder) join the story. */
export async function claim_attachment_rows(story_id: number, file_names: string[]) {
  if (file_names.length) {
    const placeholders = file_names.map(() => '?').join(',')
    await db.execute(
      `UPDATE content_story_attachments SET story_id = ? WHERE story_id IS NULL AND file_name IN (${placeholders}) AND is_folder = 0`,
      [story_id, ... file_names],
    )
  }
  await db.execute(
    'UPDATE content_story_attachments SET story_id = ? WHERE story_id IS NULL AND is_folder = 1',
    [story_id],
  )
}

export async function delete_attachment_rows(story_id: number | null, file_names: string[]) {
  if (! file_names.length)
    return
  const placeholders = file_names.map(() => '?').join(',')
  await db.execute(
    `DELETE FROM content_story_attachments WHERE story_id <=> ? AND file_name IN (${placeholders})`,
    [story_id, ... file_names],
  )
}

/** Removes every row of a story; the story row is already gone (no FK cascade). */
export async function delete_story_attachment_rows(story_id: number) {
  await db.execute(
    'DELETE FROM content_story_attachments WHERE story_id = ?',
    [story_id],
  )
}

/** Cover URLs for story list cards, keyed `story_id:file_name`. */
export async function list_cover_urls(covers: { story_id: number, file_name: string }[]) {
  const urls = new Map<string, string>()
  if (! covers.length)
    return urls
  const tuples = covers.map(() => '(?, ?)').join(',')
  const [rows] = await db.execute<AttachmentRow[]>(
    `SELECT story_id, file_name, object_key, version FROM content_story_attachments WHERE is_folder = 0 AND (story_id, file_name) IN (${tuples})`,
    covers.flatMap(cover => [cover.story_id, cover.file_name]),
  )
  for (const row of rows) {
    if (row.object_key)
      urls.set(`${row.story_id}:${row.file_name}`, attachment_object_url(row.object_key, row.version))
  }
  return urls
}

/** Persists a folder (and any missing ancestors); existing paths are kept. */
export async function create_folder_rows(story_id: number | null, folders: string[]) {
  for (const folder of folders) {
    try {
      await db.execute(
        'INSERT INTO content_story_attachments (story_id, is_folder, file_name) VALUES (?, 1, ?)',
        [story_id, folder],
      )
    }
    catch (ex) {
      if ((ex as { errno?: unknown }).errno !== duplicate_entry_errno)
        throw ex
    }
  }
}

/** Removes a folder row and its subfolder rows; refuses while files live beneath. */
export async function delete_folder_rows(story_id: number | null, folder: string) {
  const [files] = await db.execute<AttachmentRow[]>(
    'SELECT id FROM content_story_attachments WHERE story_id <=> ? AND is_folder = 0 AND SUBSTRING(file_name, 1, ?) = ? LIMIT 1',
    [story_id, folder.length + 1, `${folder}/`],
  )
  if (files.length)
    throw new ApiError(409, '文件夹内仍有附件，无法删除')
  await db.execute(
    'DELETE FROM content_story_attachments WHERE story_id <=> ? AND is_folder = 1 AND (file_name = ? OR SUBSTRING(file_name, 1, ?) = ?)',
    [story_id, folder, folder.length + 1, `${folder}/`],
  )
}

/** File rows directly or indirectly under a folder (move_folder rewrites references from this). */
export async function list_folder_attachment_rows(story_id: number | null, folder: string, executor: DbExecutor = db) {
  const [rows] = await executor.execute<AttachmentRow[]>(
    'SELECT * FROM content_story_attachments WHERE story_id <=> ? AND is_folder = 0 AND SUBSTRING(file_name, 1, ?) = ?',
    [story_id, folder.length + 1, `${folder}/`],
  )
  return rows.map(format_row)
}

/** True when any file or folder already occupies `path` or lives beneath it. */
export async function folder_target_taken(story_id: number | null, path: string, executor: DbExecutor = db) {
  const [rows] = await executor.execute<AttachmentRow[]>(
    'SELECT id FROM content_story_attachments WHERE story_id <=> ? AND (file_name = ? OR SUBSTRING(file_name, 1, ?) = ?) LIMIT 1',
    [story_id, path, path.length + 1, `${path}/`],
  )
  return rows.length > 0
}

/** Prefix-rewrite every row (files and folders) under `source` onto `new_folder`. */
export async function move_folder_rows(story_id: number | null, source: string, new_folder: string, executor: DbExecutor = db) {
  try {
    await executor.execute(
      'UPDATE content_story_attachments SET file_name = CONCAT(?, SUBSTRING(file_name, ?)) WHERE story_id <=> ? AND SUBSTRING(file_name, 1, ?) = ?',
      [`${new_folder}/`, source.length + 2, story_id, source.length + 1, `${source}/`],
    )
  }
  catch (ex) {
    if ((ex as { errno?: unknown }).errno === duplicate_entry_errno)
      throw new ApiError(409, '目标位置已有同名文件或文件夹')
    throw ex
  }
}
