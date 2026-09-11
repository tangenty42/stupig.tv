import type { ContentMarkdownConfig, ContentStoryMeta } from '@shared/content-markdown'
import type { ContentOperationKind, ContentStoryAttachment, ContentStoryDetail, ContentUploadSignRequest } from '@shared/types/content'
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { extname } from 'node:path'
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, ListPartsCommand, PutObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { acquire_operation_lock, content_scope_lock_id, get_operation_lock, release_operation_lock } from '@server/lib/operation-lock'
import { random_file_token } from '@server/lib/random'
import { copy_object, delete_object, head_object, put_object, signed_object_url } from '@server/lib/storage'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { claim_attachment_rows, create_folder_rows, delete_attachment_rows, delete_folder_rows, delete_story_attachment_rows, folder_target_taken, get_scope_attachment, get_scope_object_keys, get_story_object_keys, insert_attachment_row, list_cover_urls, list_folder_attachment_rows, list_scope_attachments, list_scope_folders, move_folder_rows, rename_attachment_row, update_attachment_row_object } from '@server/services/content-attachments.service'
import { attachment_ancestor_folders, attachment_base_name, attachment_folder_of, attachment_mime_type, attachment_path_join, extract_attachment_names, extract_story_reference_titles, link_file_name_byte_length, parse_story_markdown, rename_attachment_references, rename_story_references, sanitize_attachment_file_name, sanitize_attachment_path } from '@shared/content-markdown'
import { env } from '@shared/env'
import { build_html_diagnostics, html_lint_line } from '@shared/html-lint'

interface StoryRow extends RowDataPacket {
  id: number
  title: string
  /** Space-separated labels; `#`-prefixed ones are hidden rating tiers. */
  label: string
  /** Front matter desc/cover parsed at submit time; '' means absent. */
  description: string
  cover: string
  /** Cover alt text from the front matter `![label](file)`; '' means none. */
  cover_label: string
  /** Cover object's ETag; null for external covers or unwritten rows. */
  cover_version: string | null
  event_precision: 'day' | 'month'
  /** JSON array of 'YYYY-MM-DD' strings; month-precision stories use the first of the month. */
  event_dates: string | string[]
  markdown: string
  created_at: string
  updated_at: string
  revision: number
}

interface StoryReferrerRow extends RowDataPacket {
  id: number
  markdown: string
}

interface StoryRevisionRow extends RowDataPacket {
  revision: number
}

const content_markdown_config = {
  title_max_length: env.CONTENT_STORY_TITLE_MAX_LENGTH,
  label_max_bytes: env.CONTENT_STORY_LABEL_MAX_BYTES,
  desc_max_bytes: env.CONTENT_STORY_DESC_MAX_BYTES,
  cover_max_bytes: env.CONTENT_STORY_COVER_MAX_BYTES,
  markdown_max_bytes: env.CONTENT_STORY_MARKDOWN_MAX_BYTES,
} satisfies ContentMarkdownConfig

interface AttachmentUploadOptions {
  max_size_mb: number
}

const upload_url_expires_seconds = 15 * 60

function content_upload_key_prefix(story_id: number) {
  return `content-upload/${story_id}/`
}

function assert_content_upload_key(story_id: number, key: string) {
  const prefix = content_upload_key_prefix(story_id)
  if (! key.startsWith(prefix) || ! /^[\w-]+$/.test(key.slice(prefix.length)))
    throw new ApiError(400, '上传凭证无效')
}

export async function sign_attachment_upload(input: ContentUploadSignRequest) {
  assert_content_upload_key(input.story_id, input.key)
  if (input.story_id > 0)
    await get_story(input.story_id)

  const common = { Bucket: env.OSS_BUCKET, Key: input.key }
  let command
  let return_key = false
  if (input.method === 'PUT' && input.upload_id && input.part_number) {
    command = new UploadPartCommand({ ... common, UploadId: input.upload_id, PartNumber: input.part_number })
  }
  else if (input.method === 'PUT') {
    command = new PutObjectCommand(common)
    return_key = true
  }
  else if (input.method === 'POST' && ! input.upload_id) {
    command = new CreateMultipartUploadCommand(common)
    return_key = true
  }
  else if (input.method === 'POST' && input.upload_id) {
    command = new CompleteMultipartUploadCommand({ ... common, UploadId: input.upload_id })
  }
  else if (input.method === 'GET' && input.upload_id) {
    command = new ListPartsCommand({ ... common, UploadId: input.upload_id })
  }
  else if (input.method === 'DELETE' && input.upload_id) {
    command = new AbortMultipartUploadCommand({ ... common, UploadId: input.upload_id })
  }
  else {
    throw new ApiError(400, '不支持的上传操作')
  }

  return {
    url: await signed_object_url(command, upload_url_expires_seconds),
    ... (return_key ? { key: input.key } : {}),
  }
}

export async function confirm_attachment_upload(story_id: number, key: string, raw_file_name: string, max_size_mb: number) {
  assert_content_upload_key(story_id, key)
  const object = await head_object(key)
  if (object.size > max_size_mb * 1024 * 1024) {
    await delete_object(key).catch(() => {})
    throw new ApiError(413, `文件太大了，不能超过 ${max_size_mb} MB`)
  }

  const base_name = sanitize_attachment_path(raw_file_name, env.CONTENT_LINK_FILE_NAME_MAX_BYTES)
  const existing = story_id > 0 ? (await get_story(story_id)).attachments : await list_scope_attachments(null)
  const ext = extname(attachment_base_name(base_name)).toLowerCase()
  const file_name = attachment_name_taken_in(existing, base_name)
    ? suffixed_attachment_name(base_name, ext)
    : base_name
  const target_key = `content/att/${crypto.randomUUID()}`
  const etag = await copy_object(key, target_key)
  await delete_object(key).catch(() => {})
  const version = etag ?? object.etag ?? String(Date.now())
  try {
    await insert_attachment_row({
      story_id: story_id > 0 ? story_id : null,
      file_name,
      object_key: target_key,
      mime_type: attachment_mime_type(file_name),
      file_size: object.size,
      version,
    })
  }
  catch (ex) {
    await delete_object(target_key).catch(() => {})
    throw ex
  }

  if (story_id > 0)
    publish_refresh({ resource: sync_resource('content_story', story_id) })
  else
    publish_refresh({ resource: sync_resource('content_orphan_attachments', 'all') })
  const row = await get_scope_attachment(story_id > 0 ? story_id : null, file_name)
  if (! row)
    throw new ApiError(500, '附件写入失败，请重试')
  return row
}

function get_form_file(form: FormData, field: string) {
  const file = form.get(field)
  if (! (file instanceof Blob) || file.size === 0) {
    throw new ApiError(400, '请先选择要上传的文件')
  }
  return file
}

function parse_or_throw(markdown: string, existing_titles: ContentMarkdownConfig['existing_titles']) {
  const { meta, issues } = parse_story_markdown(markdown, {
    ... content_markdown_config,
    existing_titles,
  })
  if (! meta) {
    throw new ApiError(400, issues[0]?.message ?? '档案格式不正确')
  }

  // Mirror the editor's HTML grammar lint so a save can't slip past the same
  // broken tags the editor flags.
  const html_issue = build_html_diagnostics(markdown)[0]
  if (html_issue) {
    const line = html_lint_line(markdown, html_issue.from)
    throw new ApiError(400, `第 ${line} 行：${html_issue.message}`)
  }

  return meta
}

/** Existing story ids+titles for dead-`@ref` validation, excluding the story being edited. */
async function existing_story_titles(exclude_id: number) {
  const [rows] = await db.execute<RowDataPacket[]>(
    'SELECT id, title FROM content_stories WHERE id != ?',
    [exclude_id],
  )
  return rows.map(row => ({ id: Number(row.id), title: String(row.title) }))
}

/** Rejects duplicate titles (case-insensitive, matching the table's unique index). */
async function ensure_unique_title(title: string, exclude_id: number) {
  const [rows] = await db.execute<RowDataPacket[]>(
    'SELECT id FROM content_stories WHERE title = ? AND id != ? LIMIT 1',
    [title, exclude_id],
  )
  if (rows.length) {
    throw new ApiError(409, `标题『${title}』已被使用，请换一个标题`)
  }
}

const max_related_story_refs = 200

/** Resolve `[](@title)` references in the markdown to story ids (excluding self), as a JSON array. */
async function resolve_related_story_ids(markdown: string, exclude_id: number) {
  const titles = extract_story_reference_titles(markdown).slice(0, max_related_story_refs)
  if (! titles.length) {
    return '[]'
  }
  const placeholders = titles.map(() => '?').join(',')
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT id FROM content_stories WHERE id != ? AND title IN (${placeholders})`,
    [exclude_id, ... titles],
  )
  return JSON.stringify(rows.map(row => Number(row.id)).sort((a, b) => a - b))
}

function event_row_date(precision: 'day' | 'month', entry: string) {
  return precision === 'month' ? `${entry}-01` : entry
}

/** mysql2 returns a JSON column as a string; normalize to a sorted string array. */
function parse_event_dates(value: string | string[]) {
  let dates: string[]
  if (Array.isArray(value)) {
    dates = value.filter((item): item is string => typeof item === 'string')
  }
  else {
    try {
      const parsed = JSON.parse(value) as unknown
      dates = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    }
    catch {
      dates = []
    }
  }
  return dates.sort((a, b) => a.localeCompare(b))
}

/**
 * Case-insensitive name collision check over an already-fetched list. Matches
 * the dropped table's utf8mb4_unicode_ci unique index, which rejected `A.png`
 * vs `a.png` duplicates.
 */
function attachment_name_taken_in(attachments: { file_name: string }[], file_name: string, ignore_file_name: string | null = null) {
  const target = file_name.toLowerCase()
  return attachments.some(item => item.file_name !== ignore_file_name && item.file_name.toLowerCase() === target)
}

function parse_labels(value: string) {
  return value.split(/\s+/).filter(Boolean)
}

function format_desc_cover(story: Pick<StoryRow, 'description' | 'cover' | 'cover_label' | 'cover_version'>, cover_url: string | null = null) {
  return {
    desc: story.description || null,
    cover: story.cover || null,
    cover_label: story.cover_label || null,
    cover_version: story.cover ? story.cover_version : null,
    // Root-relative object URL for a local-attachment cover; null for external covers.
    cover_url: story.cover ? cover_url : null,
  }
}

/** ETag for a cover pointing at a local attachment; the just-written object's etag wins over the pre-op listing. */
function cover_version_from(attachments: ContentStoryAttachment[], cover: string, written?: { file_name: string, version: string | null }) {
  if (! cover)
    return null
  if (written && cover === written.file_name)
    return written.version
  return attachments.find(item => item.file_name === cover)?.version ?? null
}

export async function list_stories() {
  const [stories] = await db.execute<StoryRow[]>(
    'SELECT id, title, label, description, cover, cover_label, cover_version, event_precision, event_dates, created_at, updated_at FROM content_stories ORDER BY updated_at DESC',
  )
  const cover_urls = await list_cover_urls(stories.flatMap(story => story.cover ? [{ story_id: story.id, file_name: story.cover }] : []))

  return stories.map(story => ({
    id: story.id,
    title: story.title,
    labels: parse_labels(story.label),
    event_precision: story.event_precision,
    event_dates: parse_event_dates(story.event_dates),
    created_at: story.created_at,
    updated_at: story.updated_at,
    ... format_desc_cover(story, cover_urls.get(`${story.id}:${story.cover}`) ?? null),
  }))
}

export async function get_story(id: number): Promise<ContentStoryDetail>
export async function get_story(id: number, base_updated_at: string): Promise<ContentStoryDetail | null>
export async function get_story(id: number, base_updated_at?: string): Promise<ContentStoryDetail | null> {
  if (base_updated_at !== undefined) {
    const [versions] = await db.execute<RowDataPacket[]>(
      'SELECT updated_at FROM content_stories WHERE id = ?',
      [id],
    )
    const version = versions[0]
    if (! version) {
      throw new ApiError(404, '档案不存在或已被删除')
    }
    if (new Date(version.updated_at).getTime() === new Date(base_updated_at).getTime()) {
      return null
    }
  }

  const [stories] = await db.execute<StoryRow[]>(
    'SELECT id, title, label, description, cover, cover_label, cover_version, event_precision, event_dates, markdown, created_at, updated_at, revision FROM content_stories WHERE id = ?',
    [id],
  )
  const story = stories[0]
  if (! story) {
    throw new ApiError(404, '档案不存在或已被删除')
  }

  const attachments = await list_scope_attachments(story.id)
  return {
    id: story.id,
    title: story.title,
    labels: parse_labels(story.label),
    event_precision: story.event_precision,
    event_dates: parse_event_dates(story.event_dates),
    markdown: story.markdown,
    attachments,
    folders: await list_scope_folders(story.id),
    created_at: story.created_at,
    updated_at: story.updated_at,
    revision: story.revision,
    operation_lock: await get_operation_lock(content_scope_lock_id(story.id)),
    ... format_desc_cover(story, attachments.find(item => item.file_name === story.cover)?.url ?? null),
  }
}

/** Serialize the story's event entries into the JSON array stored on the row. */
function story_event_dates(meta: ContentStoryMeta) {
  const dates = meta.event_entries.map(entry => event_row_date(meta.event_precision, entry))
  dates.sort((a, b) => a.localeCompare(b))
  return JSON.stringify(dates)
}

export async function create_story(created_by: number, markdown: string, claim_files: string[]) {
  const existing_titles = await existing_story_titles(0)
  const meta = parse_or_throw(markdown, existing_titles)
  await ensure_unique_title(meta.title, 0)

  const [result] = await db.execute<ResultSetHeader>(
    'INSERT INTO content_stories (title, label, description, cover, cover_label, event_precision, event_dates, related_story_ids, markdown, created_by) VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?)',
    [meta.title, meta.labels.join(' '), meta.desc ?? '', meta.cover ?? '', meta.cover_label ?? '', meta.event_precision, story_event_dates(meta), await resolve_related_story_ids(markdown, 0), markdown, created_by],
  )
  const story_id = Number(result.insertId)

  if (claim_files.length)
    await claim_attachments(story_id, claim_files)

  // Claimed objects carry fresh etags, so resolve the cover version post-claim.
  if (meta.cover) {
    const cover_version = cover_version_from(await list_scope_attachments(story_id), meta.cover)
    if (cover_version)
      await db.execute('UPDATE content_stories SET cover_version = ? WHERE id = ?', [cover_version, story_id])
  }

  publish_refresh({ resource: sync_resource('content_stories', 'all') })
  return story_id
}

/** Adopts orphan attachments into a story: pure row updates, objects stay put. */
async function claim_attachments(story_id: number, file_names: string[]) {
  await claim_attachment_rows(story_id, [... new Set(file_names)])
  publish_refresh({ resource: sync_resource('content_story', story_id) })
  publish_refresh({ resource: sync_resource('content_orphan_attachments', 'all') })
}

/**
 * Saves the markdown and permanently deletes the attachments listed in
 * `delete_files` (trash bin confirmation flow). Returns the accepted file
 * names for callers that need to confirm a requested deletion occurred.
 */
export async function update_story(id: number, markdown: string, delete_files: string[], base_revision: number) {
  const story = await get_story(id)
  const existing_titles = await existing_story_titles(id)
  const meta = parse_or_throw(markdown, existing_titles)
  await ensure_unique_title(meta.title, id)

  const referenced = new Set(extract_attachment_names(markdown))
  const known_files = new Set(story.attachments.map(a => a.file_name))

  const accepted_deletes: string[] = []
  for (const file_name of new Set(delete_files)) {
    if (! known_files.has(file_name)) {
      continue
    }
    if (referenced.has(file_name)) {
      throw new ApiError(400, `附件 ${file_name} 仍在正文中被引用，不能删除`)
    }
    accepted_deletes.push(file_name)
  }

  const related_story_ids = await resolve_related_story_ids(markdown, id)
  const old_title = story.title
  const new_title = meta.title
  const rewritten_referrers: number[] = []

  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    const [version_rows] = await connection.execute<StoryRevisionRow[]>(
      'SELECT revision FROM content_stories WHERE id = ? FOR UPDATE',
      [id],
    )
    const current_version = version_rows[0]
    if (! current_version) {
      throw new ApiError(404, '档案不存在或已被删除')
    }
    if (current_version.revision !== base_revision) {
      throw new ApiError(409, '档案已被其他编辑更新，请先处理版本冲突')
    }

    await connection.execute(
      'UPDATE content_stories SET title = ?, label = ?, description = ?, cover = ?, cover_label = ?, cover_version = ?, event_precision = ?, event_dates = CAST(? AS JSON), related_story_ids = CAST(? AS JSON), markdown = ?, revision = revision + 1 WHERE id = ?',
      [meta.title, meta.labels.join(' '), meta.desc ?? '', meta.cover ?? '', meta.cover_label ?? '', cover_version_from(story.attachments, meta.cover ?? ''), meta.event_precision, story_event_dates(meta), related_story_ids, markdown, id],
    )

    // A title change must cascade into stories that `@`-referenced the old title.
    if (old_title !== new_title) {
      const [referrers] = await connection.execute<StoryReferrerRow[]>(
        'SELECT id, markdown FROM content_stories WHERE JSON_CONTAINS(related_story_ids, ?) AND id != ?',
        [String(id), id],
      )
      for (const referrer of referrers) {
        const rewritten = rename_story_references(referrer.markdown, old_title, new_title)
        if (rewritten !== referrer.markdown) {
          // A mechanical reference rewrite bumps `updated_at` (ON UPDATE
          // CURRENT_TIMESTAMP) so viewers refetch the rewritten markdown, but
          // leaves `revision` alone so an in-progress editor's base version
          // stays valid (no false 409 on save).
          await connection.execute(
            'UPDATE content_stories SET markdown = ? WHERE id = ?',
            [rewritten, referrer.id],
          )
          rewritten_referrers.push(referrer.id)
        }
      }
    }

    await connection.commit()
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally {
    connection.release()
  }

  publish_refresh({ resource: sync_resource('content_stories', 'all') })
  publish_refresh({ resource: sync_resource('content_story', id) })
  for (const referrer_id of rewritten_referrers) {
    publish_refresh({ resource: sync_resource('content_story', referrer_id) })
  }

  const delete_keys = await get_scope_object_keys(id, accepted_deletes)
  await delete_attachment_rows(id, accepted_deletes)
  await Promise.all(delete_keys.map(key => delete_object(key).catch(() => {})))
  return accepted_deletes
}

/** Deletes the story row and its attachment directory. */
export async function delete_story(id: number) {
  await get_story(id)

  // Refuse to delete a story that other stories `@`-reference, so dead links
  // are never silently introduced. Point the referrers out instead.
  const [referrers] = await db.execute<RowDataPacket[]>(
    'SELECT id, title FROM content_stories WHERE JSON_CONTAINS(related_story_ids, ?) AND id != ? ORDER BY id',
    [String(id), id],
  )
  if (referrers.length) {
    const titles = referrers.map(row => `『${row.title}』`).join('、')
    throw new ApiError(409, `无法删除：仍有 ${referrers.length} 个档案引用本档案（${titles}），请先移除相关引用`)
  }

  const object_keys = await get_story_object_keys(id)
  await db.execute('DELETE FROM content_stories WHERE id = ?', [id])
  // No FK (MySQL 8.4 blocks FKs on generated-column tables), so rows go explicitly.
  await delete_story_attachment_rows(id)

  publish_refresh({ resource: sync_resource('content_stories', 'all') })
  publish_refresh({ resource: sync_resource('content_story', id) })
  await Promise.all(object_keys.map(key => delete_object(key).catch(() => {})))
}

/** Attachment files and explicit folders of a scope (`null` = orphan pool). */
async function attachment_scope_payload(story_id: number | null) {
  return {
    attachments: await list_scope_attachments(story_id),
    folders: await list_scope_folders(story_id),
    operation_lock: await get_operation_lock(content_scope_lock_id(story_id)),
  }
}

function publish_attachment_refresh(story_id: number | null) {
  if (story_id !== null)
    publish_refresh({ resource: sync_resource('content_story', story_id) })
  else
    publish_refresh({ resource: sync_resource('content_orphan_attachments', 'all') })
}

/**
 * Runs an attachment structure change under the scope's operation lock.
 *
 * The lock is broadcast on acquire and release as part of the attachment
 * payload, so peers disable the same controls instead of racing into a 409.
 * Peers refetching mid-operation read the pre-operation rows (the row rewrites
 * are still uncommitted), so they never observe the intermediate move names.
 *
 * Uploads and in-place replacement deliberately stay outside: they hold an OSS
 * transfer for the bulk of their lifetime (which could outlive the lease),
 * name themselves around collisions, and are additive rather than
 * renames of names other operations already resolved.
 */
async function with_attachment_lock<T>(story_id: number | null, kind: ContentOperationKind, fn: () => Promise<T>): Promise<T> {
  const lock = await acquire_operation_lock(content_scope_lock_id(story_id), kind)
  publish_attachment_refresh(story_id)
  try {
    return await fn()
  }
  finally {
    // A release failure only leaves the lease to lapse; it must not mask the
    // operation's own error or fail an otherwise successful change.
    await release_operation_lock(lock).catch(() => {})
    publish_attachment_refresh(story_id)
  }
}

interface StoryMarkdownRow extends RowDataPacket {
  markdown: string
  cover: string
}

/**
 * Applies attachment renames to a story's markdown and cover.
 *
 * The row is re-read under `FOR UPDATE` instead of reusing the copy fetched
 * while planning: attachment changes and saves both rewrite `markdown`
 * wholesale, so applying a rename to a stale copy would silently drop a save
 * that committed in between (and vice versa).
 *
 * A reference rewrite bumps `revision`, unlike the cross-story `@title`
 * cascade below. Here the rename and a save write the same field of the same
 * story, so an editor holding the pre-rename markdown must not be allowed to
 * save it back: without the bump, that save would overwrite the rewrite and
 * leave the document pointing at a name that no longer exists. Bumping turns
 * it into the ordinary version conflict the editor already resolves.
 */
async function rewrite_story_attachment_refs(connection: Connection, story_id: number, renames: { old_file_name: string, new_file_name: string }[]) {
  if (! renames.length)
    return
  const [rows] = await connection.execute<StoryMarkdownRow[]>(
    'SELECT markdown, cover FROM content_stories WHERE id = ? FOR UPDATE',
    [story_id],
  )
  const story = rows[0]
  if (! story)
    return

  let markdown = story.markdown
  let cover = story.cover ?? ''
  for (const rename of renames) {
    markdown = rename_attachment_references(markdown, rename.old_file_name, rename.new_file_name)
    if (cover === rename.old_file_name)
      cover = rename.new_file_name
  }
  if (markdown !== story.markdown || cover !== (story.cover ?? '')) {
    await connection.execute(
      'UPDATE content_stories SET markdown = ?, cover = ?, revision = revision + 1 WHERE id = ?',
      [markdown, cover, story_id],
    )
  }
}

/** Lists unclaimed attachments (the orphan pool of the new-story editor). */
export async function list_orphan_attachments() {
  return attachment_scope_payload(null)
}

/** Persists a folder (and missing ancestors) in a scope. */
export async function create_folder(story_id: number | null, folder: string) {
  await with_attachment_lock(story_id, 'folder_create', async () => {
    if (story_id !== null)
      await get_story(story_id)
    await create_folder_rows(story_id, [... attachment_ancestor_folders(folder), folder])
    publish_attachment_refresh(story_id)
  })
  // Read after the lock is released, so the payload reports the scope as idle
  // instead of echoing the caller's own finished operation back as in flight.
  return attachment_scope_payload(story_id)
}

/** Removes a folder row subtree; files beneath make it a 409. */
export async function delete_folder(story_id: number | null, folder: string) {
  await with_attachment_lock(story_id, 'folder_delete', async () => {
    if (story_id !== null)
      await get_story(story_id)
    await delete_folder_rows(story_id, folder)
    publish_attachment_refresh(story_id)
  })
  return attachment_scope_payload(story_id)
}

/**
 * Moves/renames a folder: every row under the old prefix (files and
 * subfolders) gets the new one; story markdown/cover references follow.
 */
export async function move_folder(story_id: number | null, source_folder: string, new_folder: string) {
  if (new_folder === source_folder)
    return attachment_scope_payload(story_id)
  if (new_folder.startsWith(`${source_folder}/`))
    throw new ApiError(400, '不能移动到文件夹自身内部')

  await with_attachment_lock(story_id, 'move', async () => {
    const story = story_id !== null ? await get_story(story_id) : null
    const files = await list_folder_attachment_rows(story_id, source_folder)
    const folders = await list_scope_folders(story_id)
    if (! files.length && ! folders.some(folder => folder === source_folder || folder.startsWith(`${source_folder}/`)))
      throw new ApiError(404, '文件夹不存在或已被删除')

    const renames = files.map(file => ({
      old_file_name: file.file_name,
      new_file_name: `${new_folder}/${file.file_name.slice(source_folder.length + 1)}`,
    }))

    const connection = await db.getConnection()
    try {
      await connection.beginTransaction()
      // Checked inside the transaction: the prefix rewrite and the check must not
      // be separated by another writer.
      if (await folder_target_taken(story_id, new_folder, connection))
        throw new ApiError(409, '目标位置已有同名文件或文件夹')
      await move_folder_rows(story_id, source_folder, new_folder, connection)
      if (story)
        await rewrite_story_attachment_refs(connection, story.id, renames)
      await connection.commit()
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
    finally {
      connection.release()
    }

    publish_attachment_refresh(story_id)
  })
  return attachment_scope_payload(story_id)
}

/** Rebuilds a taken file name with a random suffix before the extension, keeping the byte cap and folder prefix. */
function suffixed_attachment_name(file_name: string, ext: string) {
  const base = attachment_base_name(file_name)
  const stem = ext ? base.slice(0, - ext.length) : base
  const suffix = `-${random_file_token()}`
  const stem_limit = env.CONTENT_LINK_FILE_NAME_MAX_BYTES - link_file_name_byte_length(suffix) - link_file_name_byte_length(ext)
  return attachment_path_join(attachment_folder_of(file_name), `${sanitize_attachment_file_name(stem, Math.max(stem_limit, 1))}${suffix}${ext}`)
}

export async function upload_attachment(story_id: number | null, input: FormData, get_options: () => AttachmentUploadOptions) {
  const upload = get_form_file(input, 'file')
  const file_data = Buffer.from(await upload.arrayBuffer())
  const options = get_options()

  if (file_data.length > options.max_size_mb * 1024 * 1024) {
    throw new ApiError(413, `文件太大了，不能超过 ${options.max_size_mb} MB`)
  }

  // Folder uploads send the (possibly nested) storage path separately; plain
  // uploads fall back to the file's own base name.
  const form_file_name = input.get('file_name')
  const base_name = sanitize_attachment_path(
    typeof form_file_name === 'string' && form_file_name.trim() ? form_file_name : (upload.name ?? 'file'),
    env.CONTENT_LINK_FILE_NAME_MAX_BYTES,
  )
  const ext = extname(attachment_base_name(base_name)).toLowerCase()

  // Validates the story exists and doubles as the name-collision listing.
  const existing = story_id !== null
    ? (await get_story(story_id)).attachments
    : await list_scope_attachments(null)

  let file_name = base_name
  // Check-then-insert: a same-name upload racing past this check loses to the
  // unique index on (scope_id, file_name) and fails the request.
  if (attachment_name_taken_in(existing, file_name)) {
    file_name = suffixed_attachment_name(base_name, ext)
  }

  const object_key = `content/att/${crypto.randomUUID()}`
  const etag = await put_object(object_key, file_data, upload.type || null)
  const version = etag ?? String(Date.now())
  try {
    await insert_attachment_row({
      story_id,
      file_name,
      object_key,
      mime_type: upload.type || null,
      file_size: file_data.length,
      version,
    })
  }
  catch (ex) {
    await delete_object(object_key).catch(() => {})
    throw ex
  }

  if (story_id !== null)
    publish_refresh({ resource: sync_resource('content_story', story_id) })
  else
    publish_refresh({ resource: sync_resource('content_orphan_attachments', 'all') })
  const row = await get_scope_attachment(story_id, file_name)
  if (! row)
    throw new ApiError(500, '附件写入失败，请重试')
  return row
}

/** Deletes an unclaimed attachment and its object. */
export async function delete_orphan_attachment(file_name: string) {
  return await with_attachment_lock(null, 'delete', async () => {
    const keys = await get_scope_object_keys(null, [file_name])
    if (! keys.length)
      throw new ApiError(404, '附件不存在或已被删除')

    await delete_attachment_rows(null, [file_name])
    publish_attachment_refresh(null)
    await Promise.all(keys.map(key => delete_object(key).catch(() => {})))
  })
}

export async function delete_attachment(story_id: number, file_name: string, markdown: string, base_revision: number) {
  return await with_attachment_lock(story_id, 'delete', async () => {
    const deleted_files = await update_story(story_id, markdown, [file_name], base_revision)
    if (! deleted_files.includes(file_name)) {
      throw new ApiError(404, '附件不存在或已被删除')
    }
  })
}

/**
 * Moves an attachment into a folder (or back to root when `target_folder` is
 * null): a row update plus the story's markdown/cover reference rewrite.
 */
export async function move_attachment(story_id: number | null, file_name: string, target_folder: string | null) {
  return await with_attachment_lock(story_id, 'move', async () => {
    const story = story_id !== null ? await get_story(story_id) : null
    const attachments = story
      ? story.attachments
      : (await list_orphan_attachments()).attachments
    const attachment = attachments.find(item => item.file_name === file_name)
    if (! attachment)
      throw new ApiError(404, '附件不存在或已被删除')

    const new_file_name = attachment_path_join(target_folder, attachment_base_name(file_name))
    if (new_file_name === file_name)
      return attachment

    if (attachment_name_taken_in(attachments, new_file_name))
      throw new ApiError(409, '目标位置已有同名文件')

    const connection = await db.getConnection()
    try {
      await connection.beginTransaction()
      await rename_attachment_row(story_id, file_name, new_file_name, connection)
      if (story)
        await rewrite_story_attachment_refs(connection, story.id, [{ old_file_name: file_name, new_file_name }])
      await connection.commit()
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
    finally {
      connection.release()
    }

    publish_attachment_refresh(story_id)
    const row = await get_scope_attachment(story_id, new_file_name)
    return row ?? { ... attachment, file_name: new_file_name }
  })
}

export interface AttachmentMove {
  file_name: string
  target_folder: string | null
}

/**
 * Moves many attachments in one pass: a single listing fetch, a single
 * markdown/cover rewrite and one refresh — instead of one request per file.
 * Each move keeps its own target folder (or root when null).
 */
export async function move_attachments(story_id: number | null, moves: AttachmentMove[]) {
  return await with_attachment_lock(story_id, 'move', async () => {
    const story = story_id !== null ? await get_story(story_id) : null
    const attachments = story
      ? story.attachments
      : (await list_orphan_attachments()).attachments
    const by_name = new Map(attachments.map(item => [item.file_name, item]))
    const taken = new Map(attachments.map(item => [item.file_name.toLowerCase(), item]))

    const planned: { attachment: ContentStoryAttachment, old_file_name: string, new_file_name: string }[] = []
    for (const move of moves) {
      const attachment = by_name.get(move.file_name)
      if (! attachment)
        throw new ApiError(404, '附件不存在或已被删除')
      const new_file_name = attachment_path_join(move.target_folder, attachment_base_name(move.file_name))
      if (new_file_name !== move.file_name)
        planned.push({ attachment, old_file_name: move.file_name, new_file_name })
    }

    if (! planned.length) {
      publish_attachment_refresh(story_id)
      return attachments
    }

    // A destination must not collide with anything that still exists after the
    // batch (case-insensitive, like the dropped unique index), and two moves in
    // the same batch must not land on the same name.
    const moved_away = new Set(planned.map(plan => plan.old_file_name.toLowerCase()))
    const destinations = new Set<string>()
    for (const plan of planned) {
      const lower = plan.new_file_name.toLowerCase()
      if (destinations.has(lower))
        throw new ApiError(409, '目标位置已有同名文件')
      destinations.add(lower)
      if (taken.has(lower) && ! moved_away.has(lower))
        throw new ApiError(409, '目标位置已有同名文件')
    }

    // Two-phase rename: a destination may be another move's source (a→b, b→c),
    // and the unique index forbids holding that name even mid-batch. Both loops
    // run on one transaction — a failure between them must restore the original
    // names instead of stranding rows under `.mvtmp-` display paths.
    const connection = await db.getConnection()
    try {
      await connection.beginTransaction()
      const temp_names = planned.map(() => `.mvtmp-${crypto.randomUUID()}`)
      for (const [index, plan] of planned.entries()) {
        await rename_attachment_row(story_id, plan.old_file_name, temp_names[index]!, connection)
      }
      for (const [index, plan] of planned.entries()) {
        await rename_attachment_row(story_id, temp_names[index]!, plan.new_file_name, connection)
      }
      if (story)
        await rewrite_story_attachment_refs(connection, story.id, planned)
      await connection.commit()
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
    finally {
      connection.release()
    }

    publish_attachment_refresh(story_id)
    return story_id !== null
      ? (await get_story(story_id)).attachments
      : (await list_orphan_attachments()).attachments
  })
}

export async function rename_attachment(story_id: number, old_file_name: string, new_file_name: string) {
  return await with_attachment_lock(story_id, 'rename', async () => {
    const story = await get_story(story_id)
    const attachment = story.attachments.find(item => item.file_name === old_file_name)
    if (! attachment) {
      throw new ApiError(404, '附件不存在或已被删除')
    }
    if (old_file_name === new_file_name) {
      return attachment
    }
    if (attachment_name_taken_in(story.attachments, new_file_name, old_file_name)) {
      throw new ApiError(409, '已有同名附件')
    }

    const connection = await db.getConnection()
    try {
      await connection.beginTransaction()
      await rename_attachment_row(story_id, old_file_name, new_file_name, connection)
      await rewrite_story_attachment_refs(connection, story_id, [{ old_file_name, new_file_name }])
      await connection.commit()
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
    finally {
      connection.release()
    }

    publish_attachment_refresh(story_id)
    const row = await get_scope_attachment(story_id, new_file_name)
    return row ?? { ... attachment, file_name: new_file_name }
  })
}

/** Compute the extension (including the dot) of a file name, or '' when absent. */
function file_extension(file_name: string) {
  const dot = file_name.lastIndexOf('.')
  return dot > 0 ? file_name.slice(dot) : ''
}

function file_stem(file_name: string) {
  const dot = file_name.lastIndexOf('.')
  return dot > 0 ? file_name.slice(0, dot) : file_name
}

export async function replace_attachment(
  story_id: number,
  old_file_name: string,
  input: FormData,
  mode: 'keep-name' | 'new-name',
  get_options: () => AttachmentUploadOptions,
) {
  const story = await get_story(story_id)
  const attachment = story.attachments.find(item => item.file_name === old_file_name)
  if (! attachment) {
    throw new ApiError(404, '附件不存在或已被删除')
  }

  const upload = get_form_file(input, 'file')
  const file_data = Buffer.from(await upload.arrayBuffer())
  const options = get_options()

  if (file_data.length > options.max_size_mb * 1024 * 1024) {
    throw new ApiError(413, `文件太大了，不能超过 ${options.max_size_mb} MB`)
  }

  const new_name = sanitize_attachment_file_name(upload.name ?? 'file', env.CONTENT_LINK_FILE_NAME_MAX_BYTES)

  // Resolve the replacement file name. `keep-name` reuses the old stem but
  // adopts the new file's extension; `new-name` uses the new file's name fully.
  let file_name: string
  if (mode === 'keep-name') {
    const new_ext = file_extension(new_name)
    file_name = new_ext ? `${file_stem(old_file_name)}${new_ext}` : old_file_name
    if (attachment_name_taken_in(story.attachments, file_name, old_file_name)) {
      throw new ApiError(409, '已有同名附件')
    }
  }
  else {
    // Keep the replacement in the same folder as the file it replaces.
    file_name = attachment_path_join(attachment_folder_of(old_file_name), new_name)
    if (attachment_name_taken_in(story.attachments, file_name, old_file_name)) {
      file_name = suffixed_attachment_name(file_name, file_extension(file_name))
    }
  }

  const old_keys = await get_scope_object_keys(story_id, [old_file_name])
  // A replacement always lands on a fresh object; the old one is deleted after.
  const object_key = `content/att/${crypto.randomUUID()}`
  const etag = await put_object(object_key, file_data, upload.type || null)
  const version = etag ?? String(Date.now())

  // Rewrite markdown/cover references only when the final name changed.
  const markdown = file_name === old_file_name
    ? story.markdown
    : rename_attachment_references(story.markdown, old_file_name, file_name)
  const renamed_cover = story.cover === old_file_name ? file_name : (story.cover ?? '')
  const cover_version = cover_version_from(story.attachments, renamed_cover, { file_name, version })
  // An in-place replacement of the cover file rewrites no references but the etag.
  const cover_object_rewritten = renamed_cover !== '' && renamed_cover === file_name

  try {
    if (markdown !== story.markdown || renamed_cover !== (story.cover ?? '') || cover_object_rewritten) {
      await db.execute('UPDATE content_stories SET markdown = ?, cover = ?, cover_version = ? WHERE id = ?', [markdown, renamed_cover, cover_version, story_id])
    }
    await update_attachment_row_object(story_id, old_file_name, {
      file_name,
      object_key,
      mime_type: upload.type || null,
      file_size: file_data.length,
      version,
    })
  }
  catch (ex) {
    await delete_object(object_key).catch(() => {})
    throw ex
  }

  await Promise.all(old_keys.map(key => delete_object(key).catch(() => {})))

  publish_refresh({ resource: sync_resource('content_story', story_id) })
  const row = await get_scope_attachment(story_id, file_name)
  if (! row)
    throw new ApiError(500, '附件写入失败，请重试')
  return row
}
