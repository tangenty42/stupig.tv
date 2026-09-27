import type { ContentStoryAttachment } from '@shared/types/content'
import type { Connection, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { attachment_mime_type, attachment_name_conflict_message, compare_attachment_names } from '@shared/content-markdown'

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
  encryption_key: string | null
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
    is_encrypted: row.encryption_key !== null,
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

/**
 * Every path a scope holds, files and folders in one list, for the shared
 * collision rule (`attachment_path_taken`, which expands the implied folders
 * itself). Both kinds are rows of this table, so one query answers for both.
 */
export async function list_scope_paths(story_id: number | null, executor: DbExecutor = db) {
  const [rows] = await executor.execute<AttachmentRow[]>(
    'SELECT file_name FROM content_story_attachments WHERE story_id <=> ?',
    [story_id],
  )
  return rows.map(row => row.file_name)
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

/** Per-file encryption keys of a scope (encrypted files only), for permitted story-detail viewers. */
export async function list_scope_encryption_keys(story_id: number | null) {
  const [rows] = await db.execute<AttachmentRow[]>(
    'SELECT file_name, encryption_key FROM content_story_attachments WHERE story_id <=> ? AND is_folder = 0 AND encryption_key IS NOT NULL',
    [story_id],
  )
  return new Map(rows.map(row => [row.file_name, row.encryption_key!]))
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
      throw new ApiError(409, attachment_name_conflict_message)
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

/** Raw file rows by name (encrypt/decrypt need object_key and encryption_key, which format_row drops). */
export async function list_scope_file_rows(story_id: number | null, file_names: string[], executor: DbExecutor = db) {
  if (! file_names.length)
    return []
  const placeholders = file_names.map(() => '?').join(',')
  const [rows] = await executor.execute<AttachmentRow[]>(
    `SELECT * FROM content_story_attachments WHERE story_id <=> ? AND file_name IN (${placeholders}) AND is_folder = 0`,
    [story_id, ... file_names],
  )
  return rows
}

/** Encrypt/decrypt: new name, new ciphertext/plaintext object, key set or cleared. */
export async function update_attachment_row_encryption(id: number, fields: { file_name: string, object_key: string, file_size: number, version: string, encryption_key: string | null }, executor: DbExecutor = db) {
  try {
    await executor.execute(
      'UPDATE content_story_attachments SET file_name = ?, object_key = ?, file_size = ?, version = ?, encryption_key = ? WHERE id = ?',
      [fields.file_name, fields.object_key, fields.file_size, fields.version, fields.encryption_key, id],
    )
  }
  catch (ex) {
    if ((ex as { errno?: unknown }).errno === duplicate_entry_errno)
      throw new ApiError(409, attachment_name_conflict_message)
    throw ex
  }
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
export async function create_folder_rows(story_id: number | null, folders: string[], executor: DbExecutor = db) {
  for (const folder of folders) {
    try {
      // Folder rows are placeholders without an object; version is '' there.
      await executor.execute(
        'INSERT INTO content_story_attachments (story_id, is_folder, file_name, version) VALUES (?, 1, ?, \'\')',
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

/** Every row of a folder subtree (files and folders, the source row included), matched with the rows' own collation. */
export async function list_folder_subtree_rows(story_id: number | null, source: string, executor: DbExecutor = db) {
  const [rows] = await executor.execute<AttachmentRow[]>(
    'SELECT * FROM content_story_attachments WHERE story_id <=> ? AND (file_name = ? OR SUBSTRING(file_name, 1, ?) = ?)',
    [story_id, source, source.length + 1, `${source}/`],
  )
  return rows
}

/** Every row of a scope; move_folder derives the paths outside the subtree from this one listing. */
export async function list_scope_rows(story_id: number | null, executor: DbExecutor = db) {
  const [rows] = await executor.execute<AttachmentRow[]>(
    'SELECT * FROM content_story_attachments WHERE story_id <=> ?',
    [story_id],
  )
  return rows
}

/** Two-phase folder moves address rows by id: temp names first, final names once the contested namespace is vacated. */
export async function rename_row_by_id(id: number, new_file_name: string, executor: DbExecutor = db) {
  try {
    await executor.execute(
      'UPDATE content_story_attachments SET file_name = ? WHERE id = ?',
      [new_file_name, id],
    )
  }
  catch (ex) {
    if ((ex as { errno?: unknown }).errno === duplicate_entry_errno)
      throw new ApiError(409, attachment_name_conflict_message)
    throw ex
  }
}

/** Folder rows absorbed by a merge disappear; the target folder row already answers to the name. */
export async function delete_rows_by_ids(ids: number[], executor: DbExecutor = db) {
  if (! ids.length)
    return
  const placeholders = ids.map(() => '?').join(',')
  await executor.execute(
    `DELETE FROM content_story_attachments WHERE id IN (${placeholders})`,
    ids,
  )
}
