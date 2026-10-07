import type { AuthUser } from '@server/types/auth'
import type { ContentMarkdownConfig, ContentStoryMeta } from '@shared/content-markdown'
import type { ContentAttachmentBatchResult, ContentBatchSkipped, ContentOperationKind, ContentStoryAttachment, ContentStoryDetail, ContentUploadSignRequest } from '@shared/types/content'
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { extname } from 'node:path'
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectCommand, ListPartsCommand, PutObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3'
import { ApiError } from '@server/errors/ApiError'
import { decrypt_attachment, encrypt_attachment } from '@server/lib/attachment-crypto'
import { db } from '@server/lib/db'
import { acquire_operation_lock, get_operation_lock, release_operation_lock } from '@server/lib/operation-lock'
import { random_file_token } from '@server/lib/random'
import { copy_object, delete_object_best_effort, get_object, head_object, put_object, signed_object_url } from '@server/lib/storage'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { create_folder_rows, delete_attachment_rows, delete_folder_rows, delete_rows_by_ids, delete_story_attachment_rows, get_scope_attachment, get_scope_object_keys, get_story_object_keys, insert_attachment_row, list_cover_urls, list_folder_subtree_rows, list_scope_attachments, list_scope_encryption_keys, list_scope_file_rows, list_scope_folders, list_scope_paths, list_scope_rows, rename_attachment_row, rename_row_by_id, update_attachment_row_encryption, update_attachment_row_object } from '@server/services/content-attachments.service'
import { runtime_config } from '@shared/config'
import { attachment_ancestor_folders, attachment_base_name, attachment_download_name, attachment_folder_of, attachment_mime_type, attachment_name_conflict_message, attachment_path_join, attachment_path_taken, attachment_path_violation, decrypted_attachment_name, encrypted_attachment_suffix, extract_attachment_names, extract_story_reference_titles, is_encrypted_attachment, link_file_name_byte_length, normalized_attachment_extension, parse_story_markdown, redactable_attachment_mime, rename_attachment_references, rename_story_references, sanitize_attachment_file_name, sanitize_attachment_path, sanitize_attachment_segment } from '@shared/content-markdown'
import { has_private_content, redact_private_content } from '@shared/content-private'
import { build_html_diagnostics, html_lint_line } from '@shared/html-lint'
import { has_permission } from '@shared/permissions'

const config = runtime_config()

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
  title_max_length: config.app.content.story.titleMaxLength,
  label_max_bytes: config.app.content.story.labelMaxBytes,
  desc_max_bytes: config.app.content.story.descMaxBytes,
  cover_max_bytes: config.app.content.story.coverMaxBytes,
  markdown_max_bytes: config.app.content.story.markdownMaxBytes,
} satisfies ContentMarkdownConfig

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
  await get_story(input.story_id)

  const common = { Bucket: config.oss.bucket, Key: input.key }
  let command
  let return_key = false
  if (input.method === 'PUT' && input.upload_id && input.part_number) {
    command = new UploadPartCommand({ ... common, UploadId: input.upload_id, PartNumber: input.part_number })
  }
  else if (input.method === 'PUT') {
    command = new PutObjectCommand({ ... common, ContentType: input.content_type || undefined })
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

/** RFC 5987 ext-value: encodeURIComponent minus the few characters it leaves bare. */
function rfc5987_ext_value(value: string) {
  return encodeURIComponent(value).replace(/['()*!]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Signs a short-lived object GET that saves the attachment under its row name.
 *
 * The object itself is public but nameless (a uuid key, no stored
 * Content-Disposition), so the name rides on the signature's
 * `response-content-disposition` override — the browser then saves the file
 * under it while the host keeps streaming the bytes.
 */
export async function sign_attachment_download(story_id: number, file_name: string) {
  await get_story(story_id)
  const rows = await list_scope_file_rows(story_id, [file_name])
  const row = rows[0]
  if (! row)
    throw new ApiError(404, '附件不存在或已被删除')
  // The object at the row's key is ciphertext; naming it after the plaintext
  // would hand out a corrupt file. Encrypted rows download through the
  // client-side decrypt path, never through this signature.
  if (row.encryption_key !== null)
    throw new ApiError(400, '加密的附件请在页面中下载')

  const url = await signed_object_url(new GetObjectCommand({
    Bucket: config.oss.bucket,
    Key: row.object_key!,
    ResponseContentDisposition: `attachment; filename*=UTF-8''${rfc5987_ext_value(attachment_download_name(row.file_name))}`,
  }), config.app.content.download.urlTtlSeconds)
  return { url }
}

export async function confirm_attachment_upload(story_id: number, key: string, raw_file_name: string) {
  assert_content_upload_key(story_id, key)
  const object = await head_object(key)
  const base_name = sanitize_attachment_path(raw_file_name, config.app.content.link.fileNameMaxBytes)
  // A signed upload can outlive its story, so the scope is revalidated here.
  await get_story(story_id)
  const file_name = resolve_attachment_name(base_name, await list_scope_paths(story_id), 'suffix')
  const target_key = `content/att/${crypto.randomUUID()}`
  const etag = await copy_object(key, target_key)
  await delete_object_best_effort(key)
  const version = etag ?? object.etag ?? String(Date.now())
  try {
    await insert_attachment_row({
      story_id,
      file_name,
      object_key: target_key,
      mime_type: attachment_mime_type(file_name),
      file_size: object.size,
      version,
    })
  }
  catch (ex) {
    await delete_object_best_effort(target_key)
    throw ex
  }

  await materialize_attachment_folders(story_id, file_name)
  await publish_attachment_change(story_id)
  const row = await get_scope_attachment(story_id, file_name)
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

/**
 * A file landing inside a folder makes that folder a row of its own.
 *
 * Folders otherwise exist only implicitly, through the files under them, so an
 * uploaded folder would disappear the moment its last file was deleted or moved
 * out — taking the structure the author uploaded with it. Recording the folder
 * when it first receives a file is what makes "every folder has a row" hold, so
 * no later operation has to invent one. Existing rows are kept, so a second
 * file in the same folder (or a re-upload) costs nothing.
 *
 * A directory that is empty to begin with still cannot arrive this way: a
 * picker yields no files for it, which is what 新建文件夹 is for.
 */
async function materialize_attachment_folders(story_id: number, file_name: string) {
  const ancestors = attachment_ancestor_folders(file_name)
  if (ancestors.length)
    await create_folder_rows(story_id, ancestors)
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

// Identifies the viewer a story payload was rendered for; echoed back as
// base_viewer_key so the version check below can tell "story unchanged" from
// "viewer changed" — a guest's redacted copy and a privileged full copy share
// the same updated_at.
function story_viewer_key(viewer: AuthUser | null | undefined) {
  return viewer === undefined
    ? 'internal'
    : `${viewer?.id ?? 'anon'}:${has_permission(viewer, 'content_private', 'read')}`
}

export async function get_story(id: number): Promise<ContentStoryDetail>
export async function get_story(id: number, base: undefined, viewer: AuthUser | null): Promise<ContentStoryDetail>
export async function get_story(id: number, base: { updated_at: string, viewer_key: string }, viewer: AuthUser | null): Promise<ContentStoryDetail | null>
export async function get_story(id: number, base?: { updated_at: string, viewer_key: string }, viewer?: AuthUser | null): Promise<ContentStoryDetail | null> {
  const viewer_key = story_viewer_key(viewer)
  if (base && base.viewer_key === viewer_key) {
    const [versions] = await db.execute<RowDataPacket[]>(
      'SELECT updated_at FROM content_stories WHERE id = ?',
      [id],
    )
    const version = versions[0]
    if (! version) {
      throw new ApiError(404, '档案不存在或已被删除')
    }
    if (new Date(version.updated_at).getTime() === new Date(base.updated_at).getTime()) {
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
  // The per-file decryption keys ship only to viewers who may read private
  // content; everyone else learns that a file is encrypted, never its key.
  if (viewer && has_permission(viewer, 'content_private', 'read')) {
    const keys = await list_scope_encryption_keys(story.id)
    if (keys.size) {
      for (const attachment of attachments) {
        const key = keys.get(attachment.file_name)
        if (key)
          attachment.encryption_key = key
      }
    }
  }
  const has_private = has_private_content(story.markdown)
  // viewer === undefined: internal call, full markdown. viewer === null or a
  // user without the content_private permission: private elements stripped.
  const markdown = viewer !== undefined && ! has_permission(viewer, 'content_private', 'read')
    ? redact_private_content(story.markdown)
    : story.markdown
  return {
    id: story.id,
    title: story.title,
    labels: parse_labels(story.label),
    event_precision: story.event_precision,
    event_dates: parse_event_dates(story.event_dates),
    markdown,
    has_private,
    attachments,
    folders: await list_scope_folders(story.id),
    created_at: story.created_at,
    updated_at: story.updated_at,
    revision: story.revision,
    viewer_key,
    operation_lock: await get_operation_lock(story.id),
    ... format_desc_cover(story, attachments.find(item => item.file_name === story.cover)?.url ?? null),
  }
}

/** Serialize the story's event entries into the JSON array stored on the row. */
function story_event_dates(meta: ContentStoryMeta) {
  const dates = meta.event_entries.map(entry => event_row_date(meta.event_precision, entry))
  dates.sort((a, b) => a.localeCompare(b))
  return JSON.stringify(dates)
}

export async function create_story(created_by: number, markdown: string, can_private: boolean) {
  if (! can_private && has_private_content(markdown)) {
    throw new ApiError(403, '内容包含机密内容，你没有机密内容的编辑权限')
  }
  const existing_titles = await existing_story_titles(0)
  const meta = parse_or_throw(markdown, existing_titles)
  await ensure_unique_title(meta.title, 0)

  const [result] = await db.execute<ResultSetHeader>(
    'INSERT INTO content_stories (title, label, description, cover, cover_label, event_precision, event_dates, related_story_ids, markdown, created_by) VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?)',
    [meta.title, meta.labels.join(' '), meta.desc ?? '', meta.cover ?? '', meta.cover_label ?? '', meta.event_precision, story_event_dates(meta), await resolve_related_story_ids(markdown, 0), markdown, created_by],
  )
  const story_id = Number(result.insertId)

  publish_refresh({ resource: sync_resource('content_stories', 'all') })
  return story_id
}

/**
 * Saves the markdown and permanently deletes the attachments listed in
 * `delete_files` (trash bin confirmation flow). Returns the accepted file
 * names for callers that need to confirm a requested deletion occurred.
 */
export async function update_story(id: number, markdown: string, delete_files: string[], base_revision: number, can_private: boolean) {
  const story = await get_story(id)
  // Old markdown checked too: an editor without the private permission must
  // not silently delete private elements by saving over them.
  if (! can_private && (has_private_content(markdown) || has_private_content(story.markdown))) {
    throw new ApiError(403, '内容包含机密内容，你没有机密内容的编辑权限')
  }
  const existing_titles = await existing_story_titles(id)
  const meta = parse_or_throw(markdown, existing_titles)
  await ensure_unique_title(meta.title, id)

  const referenced = new Set(extract_attachment_names(markdown))
  const known_files = new Set(story.attachments.map(a => a.file_name))

  const accepted_deletes: string[] = []
  const skipped: ContentBatchSkipped[] = []
  for (const file_name of new Set(delete_files)) {
    if (! known_files.has(file_name)) {
      skipped.push({ file_name, reason: '附件不存在或已被删除' })
      continue
    }
    if (referenced.has(file_name)) {
      skipped.push({ file_name, reason: '已被正文引用' })
      continue
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
  await Promise.all(delete_keys.map(key => delete_object_best_effort(key)))
  return { succeeded: accepted_deletes, skipped }
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
  await Promise.all(object_keys.map(key => delete_object_best_effort(key)))
}

/** Attachment files and explicit folders of a story's scope. */
async function attachment_scope_payload(story_id: number) {
  return {
    attachments: await list_scope_attachments(story_id),
    folders: await list_scope_folders(story_id),
    operation_lock: await get_operation_lock(story_id),
  }
}

function publish_attachment_refresh(story_id: number) {
  publish_refresh({ resource: sync_resource('content_story', story_id) })
}

/**
 * Announces a finished attachment change.
 *
 * `content_stories.updated_at` is the token subscribers pass as `base_updated_at`
 * to skip refetching an unchanged story, and attachment rows live in their own
 * table — so a change that leaves the story row alone (an upload, a folder, a
 * rename of an unreferenced file) has to bump it here, or every connected client
 * would keep rendering the attachment list it already had. The bump also
 * reorders the story list, which sorts by it.
 */
async function publish_attachment_change(story_id: number) {
  await db.execute('UPDATE content_stories SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [story_id])
  publish_attachment_refresh(story_id)
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
async function with_attachment_lock<T>(story_id: number, kind: ContentOperationKind, fn: () => Promise<T>): Promise<T> {
  const lock = await acquire_operation_lock(story_id, kind)
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

/** Persists a folder (and missing ancestors) in a scope. */
export async function create_folder(story_id: number, folder: string) {
  await with_attachment_lock(story_id, 'folder_create', async () => {
    await get_story(story_id)
    // A name is one path for both kinds: a file already answering to it — or
    // holding contents that make the name a folder in its own right — keeps the
    // folder from existing under it.
    const folder_path = resolve_attachment_name(folder, await list_scope_paths(story_id), 'reject')
    await create_folder_rows(story_id, [... attachment_ancestor_folders(folder_path), folder_path])
    await publish_attachment_change(story_id)
  })
  // Read after the lock is released, so the payload reports the scope as idle
  // instead of echoing the caller's own finished operation back as in flight.
  return attachment_scope_payload(story_id)
}

/** Removes a folder row subtree; files beneath make it a 409. */
export async function delete_folder(story_id: number, folder: string) {
  await with_attachment_lock(story_id, 'folder_delete', async () => {
    await get_story(story_id)
    await delete_folder_rows(story_id, folder)
    await publish_attachment_change(story_id)
  })
  return attachment_scope_payload(story_id)
}

/**
 * Moves/renames a folder: every row of its subtree (files, subfolders and the
 * source folder row itself — no empty folder is left behind) gets the new
 * prefix; story markdown/cover references follow. A folder row landing where a
 * folder already exists merges into it (dropping `a/a` onto the root yields
 * `a`, not a conflict); files still refuse a taken path with a 409.
 */
export async function move_folder(story_id: number, source_folder: string, new_folder: string) {
  if (new_folder === source_folder)
    return attachment_scope_payload(story_id)
  if (new_folder.startsWith(`${source_folder}/`))
    throw new ApiError(400, '不能移动到文件夹自身内部')

  await with_attachment_lock(story_id, 'move', async () => {
    const story = await get_story(story_id)

    const connection = await db.getConnection()
    try {
      await connection.beginTransaction()
      // Planned inside the transaction: the listing, the collision checks and
      // the rewrite must not be separated by another writer.
      const subtree = await list_folder_subtree_rows(story_id, source_folder, connection)
      if (! subtree.length)
        throw new ApiError(404, '文件夹不存在或已被删除')
      const subtree_ids = new Set(subtree.map(row => row.id))
      const remaining = (await list_scope_rows(story_id, connection)).filter(row => ! subtree_ids.has(row.id))
      const remaining_folders = new Set(remaining.filter(row => row.is_folder).map(row => row.file_name.toLowerCase()))
      const remaining_files = new Set(remaining.filter(row => ! row.is_folder).map(row => row.file_name.toLowerCase()))
      const remaining_paths = remaining.map(row => row.file_name)

      const renames: { old_file_name: string, new_file_name: string }[] = []
      const moves: { id: number, new_file_name: string }[] = []
      const merged: number[] = []
      // The destination has to be a legal name in its own right (the `.good`
      // check applies to folders too); landing on a folder that already answers
      // to it is the documented merge, so that conflict is allowed here and the
      // per-row checks below decide the rest.
      const destination = resolve_attachment_name(new_folder, remaining_paths, 'merge')
      for (const row of subtree) {
        const new_file_name = `${destination}${row.file_name.slice(source_folder.length)}`
        if (row.is_folder) {
          const lower = new_file_name.toLowerCase()
          if (remaining_folders.has(lower))
            merged.push(row.id)
          else if (remaining_files.has(lower))
            throw new ApiError(409, attachment_name_conflict_message)
          else
            moves.push({ id: row.id, new_file_name })
        }
        else {
          // Derived from the row, so it may carry the `.good` marker: only its
          // availability is checked, never its legality.
          assert_attachment_name_available(new_file_name, remaining_paths)
          moves.push({ id: row.id, new_file_name })
          renames.push({ old_file_name: row.file_name, new_file_name })
        }
      }

      // Two-phase rename: a destination may still be another subtree row's
      // source (moving onto an ancestor path, e.g. a/a → a), and the unique
      // index forbids holding that name even mid-batch. The transaction keeps
      // a failure between the loops from stranding rows under `.mvtmp-` names.
      for (const row of subtree)
        await rename_row_by_id(row.id, `.mvtmp-${crypto.randomUUID()}`, connection)
      await delete_rows_by_ids(merged, connection)
      for (const move of moves)
        await rename_row_by_id(move.id, move.new_file_name, connection)
      // The destination becomes a folder of its own, ancestors included. Files
      // otherwise carry a folder's existence implicitly, so renaming onto a
      // path no row answers to would leave the renamed folder to vanish as soon
      // as its last file moved away. Existing rows are kept, so a merge is free.
      if (moves.some(move => move.new_file_name.startsWith(`${destination}/`)))
        await create_folder_rows(story_id, [... attachment_ancestor_folders(destination), destination], connection)
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

    await publish_attachment_change(story_id)
  })
  return attachment_scope_payload(story_id)
}

/** Rebuilds a taken file name with a random suffix before the extension, keeping the byte cap and folder prefix. */
function suffixed_attachment_name(file_name: string, ext: string) {
  const base = attachment_base_name(file_name)
  const stem = ext ? base.slice(0, - ext.length) : base
  const suffix = `-${random_file_token()}`
  const stem_limit = config.app.content.link.fileNameMaxBytes - link_file_name_byte_length(suffix) - link_file_name_byte_length(ext)
  // The stem is not a file name — the extension is appended separately and
  // already lowercased by the caller — so this cleans the segment only.
  return attachment_path_join(attachment_folder_of(file_name), `${sanitize_attachment_segment(stem, Math.max(stem_limit, 1))}${suffix}${ext}`)
}

/**
 * How an operation wants a name the scope already holds to be handled:
 * `suffix` is an upload or a fresh name stepping aside with a random suffix,
 * `reject` a rename or a new folder refusing with a 409, and `merge` a folder
 * move landing on the folder that already answers to the name.
 */
type AttachmentNameConflict = 'suffix' | 'reject' | 'merge'

/**
 * The one gate every attachment path passes through, so legality is decided in
 * a single place instead of once per operation. It answers all three questions
 * — illegal characters, the reserved `.good` suffix, and whether the scope
 * already holds the name — built on the shared rules in `content-markdown.ts`
 * so the editor cannot disagree with the server about what is legal.
 *
 * For a name the author supplies: an upload, a rename, a replacement, a folder.
 * A name the server *derives* from a row it already holds goes through
 * `assert_attachment_name_available` instead — see there.
 *
 * The conflict policy is the caller's, because it genuinely differs by
 * operation; everything scope-independent is a 400 the author has to fix.
 * Returns the name to store, which is the given one unless it was suffixed.
 */
function resolve_attachment_name(
  name: string,
  existing: Iterable<string>,
  on_taken: AttachmentNameConflict,
  ignore_path: string | null = null,
) {
  assert_attachment_name_legal(name)
  if (! attachment_path_taken(existing, name, ignore_path))
    return name
  if (on_taken === 'reject')
    throw new ApiError(409, attachment_name_conflict_message)
  if (on_taken === 'merge')
    return name
  return suffixed_attachment_name(name, extname(attachment_base_name(name)).toLowerCase())
}

/** The scope-independent half: a name no author may type, whichever door it arrives by. */
function assert_attachment_name_legal(name: string) {
  const violation = attachment_path_violation(name)
  if (violation)
    throw new ApiError(400, violation)
}

/**
 * The conflict half, for a name the server derived from a row it already holds:
 * a file following its renamed folder, or a move into another folder.
 *
 * Such a name is legal by construction — and may carry the `.good` marker,
 * which only the encrypt step may append but which the scope already holds — so
 * only its availability is open to question. Sending it through the legality
 * check refused every legitimate move of an encrypted file, which is how a
 * folder holding one became impossible to rename.
 */
function assert_attachment_name_available(name: string, existing: Iterable<string>, ignore_path: string | null = null) {
  if (attachment_path_taken(existing, name, ignore_path))
    throw new ApiError(409, attachment_name_conflict_message)
}

/**
 * A file rename, where only the editable stem is the author's.
 *
 * The `.good` marker is the row's own state, not part of the name being edited
 * (see `split_attachment_editable_name`), so it is checked as state rather than
 * as a name: it may neither appear nor disappear here, since a rename swaps no
 * object and a row whose name and encryption disagreed would render ciphertext
 * as if it were plaintext. 加密/取消加密 are the operations that own that
 * transition. Legality therefore applies to the name with the marker stripped.
 */
function resolve_renamed_attachment_name(old_file_name: string, new_file_name: string, existing: Iterable<string>) {
  // The extension is normalized before the guards: lowering it after the
  // encryption-marker check could flip a legal `a.png.GOOD` into the reserved
  // `.good` marker the check had just cleared. The marker-aware normalizer
  // reaches the plaintext extension underneath an existing `.good`.
  const normalized = normalized_attachment_extension(new_file_name)
  if (is_encrypted_attachment(old_file_name) !== is_encrypted_attachment(normalized))
    throw new ApiError(400, `不能通过重命名增删 ${encrypted_attachment_suffix} 后缀`)
  assert_attachment_name_legal(decrypted_attachment_name(normalized))
  assert_attachment_name_available(normalized, existing, old_file_name)
  return normalized
}

export async function delete_attachment(story_id: number, file_name: string, markdown: string, base_revision: number, can_private: boolean) {
  return await with_attachment_lock(story_id, 'delete', async () => {
    const result = await update_story(story_id, markdown, [file_name], base_revision, can_private)
    if (! result.succeeded.includes(file_name)) {
      throw new ApiError(404, '附件不存在或已被删除')
    }
  })
}

export async function encrypt_attachments(story_id: number, file_names: string[]) {
  return await transform_attachment_encryption(story_id, 'encrypt', file_names)
}

export async function decrypt_attachments(story_id: number, file_names: string[]) {
  return await transform_attachment_encryption(story_id, 'decrypt', file_names)
}

/** Magic bytes of the formats the 删减版 editor can hand back, for a cheap payload check. */
function sniff_image_mime(data: Uint8Array) {
  const starts_with = (... bytes: number[]) => bytes.every((byte, index) => data[index] === byte)
  if (starts_with(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
    return 'image/png'
  if (starts_with(0xFF, 0xD8, 0xFF))
    return 'image/jpeg'
  if (starts_with(0x42, 0x4D))
    return 'image/bmp'
  if (starts_with(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50)
    return 'image/webp'
  return null
}

/**
 * Stores the public 删减版 of an encrypted image: a new plaintext attachment
 * named like the encrypted file without its `.good` suffix, holding the
 * redacted bitmap the editor exported. The twin keeps the source format, so a
 * GIF (or any format the canvas cannot re-encode) is refused rather than
 * silently transcoded, and the name is never taken over — an existing twin is
 * a conflict the caller has to resolve, since replacing it would be a silent
 * edit of a file that may already be published.
 */
export async function create_abridged_attachment(story_id: number, source_file_name: string, input: FormData) {
  return await with_attachment_lock(story_id, 'redact', async () => {
    const [source] = await list_scope_file_rows(story_id, [source_file_name])
    if (! source)
      throw new ApiError(404, '附件不存在或已被删除')
    if (! source.encryption_key || ! is_encrypted_attachment(source.file_name))
      throw new ApiError(400, '只有已加密的图片才能创建删减版')
    const file_name = decrypted_attachment_name(source.file_name)
    const mime_type = redactable_attachment_mime(file_name)
    if (! mime_type)
      throw new ApiError(400, '该图片格式不支持创建删减版')

    const upload = get_form_file(input, 'file')
    const file_data = Buffer.from(await upload.arrayBuffer())
    // The exported bytes must match the name they land under; the client sends
    // no type of its own, so this is the only check the payload gets.
    if (sniff_image_mime(file_data) !== mime_type)
      throw new ApiError(400, '删减版内容与文件格式不符')

    const existing = await list_scope_paths(story_id)
    // The twin keeps the source's plaintext name, so it can never itself carry
    // the `.good` suffix; the guard is here so this path answers to the same
    // rules as every other name, including a folder in the way.
    resolve_attachment_name(file_name, existing, 'reject')

    const object_key = `content/att/${crypto.randomUUID()}`
    const etag = await put_object(object_key, file_data, mime_type)
    const version = etag ?? String(Date.now())
    try {
      await insert_attachment_row({
        story_id,
        file_name,
        object_key,
        mime_type,
        file_size: file_data.length,
        version,
      })
    }
    catch (ex) {
      await delete_object_best_effort(object_key)
      throw ex
    }

    await publish_attachment_change(story_id)
    const row = await get_scope_attachment(story_id, file_name)
    if (! row)
      throw new ApiError(500, '附件写入失败，请重试')
    return row
  })
}

/**
 * Encrypts or decrypts attachments in place: downloads each object, uploads
 * the transformed bytes under a fresh object key, and swaps the row's name
 * (`.good` suffix on/off), object and key in one transaction — references are
 * rewritten like a rename. The OSS transfers run outside the transaction
 * (they can outlive a lease); old objects are deleted only after the commit.
 */
async function transform_attachment_encryption(story_id: number, kind: 'encrypt' | 'decrypt', file_names: string[]): Promise<ContentAttachmentBatchResult> {
  return await with_attachment_lock(story_id, kind, async () => {
    const rows = await list_scope_file_rows(story_id, file_names)
    const by_name = new Map(rows.map(row => [row.file_name, row]))
    const skipped: ContentBatchSkipped[] = []
    const ordered = [... new Set(file_names)].flatMap((name) => {
      const row = by_name.get(name)
      if (! row) {
        skipped.push({ file_name: name, reason: '附件不存在或已被删除' })
        return []
      }
      return [row]
    })
    const encrypting = kind === 'encrypt'
    const targets = ordered.filter((row) => {
      // A row qualifies only when its state differs from the goal: encrypt
      // takes plaintext rows, decrypt takes `.good` rows.
      if (encrypting !== is_encrypted_attachment(row.file_name))
        return true
      skipped.push({ file_name: row.file_name, reason: encrypting ? '已加密' : '未加密' })
      return false
    })
    if (! targets.length) {
      publish_attachment_refresh(story_id)
      const attachments = (await get_story(story_id)).attachments
      return { attachments, succeeded: [], skipped }
    }
    if (encrypting) {
      const max_bytes = config.app.content.encrypt.maxSizeMb * 1024 * 1024
      for (const row of [... targets]) {
        if (Number(row.file_size) > max_bytes) {
          skipped.push({ file_name: row.file_name, reason: '文件太大' })
          targets.splice(targets.indexOf(row), 1)
        }
      }
    }

    // The new display names must be free (a decrypt can land on a plaintext name).
    // Deliberately not `resolve_attachment_name`: encrypting is the one operation
    // whose whole purpose is to produce a `.good` name, so the intrinsic rule
    // that reserves the suffix must not apply here — only the conflict does.
    const planned = targets.map(row => ({
      row,
      new_file_name: encrypting ? `${row.file_name}${encrypted_attachment_suffix}` : decrypted_attachment_name(row.file_name),
    }))
    const moving_away = new Set(planned.map(plan => plan.row.file_name.toLowerCase()))
    const remaining = (await list_scope_paths(story_id)).filter(path => ! moving_away.has(path.toLowerCase()))
    const available: typeof planned = []
    for (const plan of planned) {
      const destinations = available.map(item => item.new_file_name)
      if (attachment_path_taken([... remaining, ... destinations], plan.new_file_name)) {
        skipped.push({ file_name: plan.row.file_name, reason: attachment_name_conflict_message })
        continue
      }
      available.push(plan)
    }
    planned.splice(0, planned.length, ... available)

    if (! planned.length) {
      publish_attachment_refresh(story_id)
      const attachments = (await get_story(story_id)).attachments
      return { attachments, succeeded: [], skipped }
    }

    const processed: { row: (typeof planned)[number]['row'], new_file_name: string, object_key: string, version: string, encryption_key: string | null, file_size: number }[] = []
    try {
      for (const plan of planned) {
        const source = await get_object(plan.row.object_key!)
        const object_key = `content/att/${crypto.randomUUID()}`
        if (encrypting) {
          const { key, data } = encrypt_attachment(source)
          const version = await put_object(object_key, data, null)
          processed.push({ ... plan, object_key, version: version ?? '', encryption_key: key, file_size: data.length })
        }
        else {
          if (! plan.row.encryption_key)
            throw new ApiError(409, '附件缺少密钥，无法解密')
          let data: Uint8Array
          try {
            data = decrypt_attachment(source, plan.row.encryption_key)
          }
          catch {
            throw new ApiError(409, `附件解密失败：${plan.row.file_name}`)
          }
          const version = await put_object(object_key, data, plan.row.mime_type)
          processed.push({ ... plan, object_key, version: version ?? '', encryption_key: null, file_size: data.length })
        }
      }
    }
    catch (ex) {
      await Promise.all(processed.map(item => delete_object_best_effort(item.object_key)))
      throw ex
    }

    const connection = await db.getConnection()
    try {
      await connection.beginTransaction()
      for (const item of processed) {
        await update_attachment_row_encryption(item.row.id, {
          file_name: item.new_file_name,
          object_key: item.object_key,
          file_size: item.file_size,
          version: item.version,
          encryption_key: item.encryption_key,
        }, connection)
      }
      await rewrite_story_attachment_refs(connection, story_id, processed.map(item => ({ old_file_name: item.row.file_name, new_file_name: item.new_file_name })))
      await connection.commit()
    }
    catch (ex) {
      await connection.rollback()
      await Promise.all(processed.map(item => delete_object_best_effort(item.object_key)))
      throw ex
    }
    finally {
      connection.release()
    }
    for (const item of processed)
      await delete_object_best_effort(item.row.object_key!)
    await publish_attachment_change(story_id)
    const attachments = (await get_story(story_id)).attachments
    return {
      attachments,
      succeeded: processed.map(item => item.row.file_name),
      skipped,
    }
  })
}

/**
 * Moves an attachment into a folder (or back to root when `target_folder` is
 * null): a row update plus the story's markdown/cover reference rewrite.
 */
export async function move_attachment(story_id: number, file_name: string, target_folder: string | null) {
  return await with_attachment_lock(story_id, 'move', async () => {
    const story = await get_story(story_id)
    const attachments = story.attachments
    const attachment = attachments.find(item => item.file_name === file_name)
    if (! attachment)
      throw new ApiError(404, '附件不存在或已被删除')

    const new_file_name = attachment_path_join(target_folder, attachment_base_name(file_name))
    if (new_file_name === file_name)
      return attachment

    // Only the folder changes, so the name is the row's own — an encrypted
    // file's `.good` marker rides along rather than being re-validated.
    assert_attachment_name_available(new_file_name, await list_scope_paths(story_id))

    const connection = await db.getConnection()
    try {
      await connection.beginTransaction()
      await rename_attachment_row(story_id, file_name, new_file_name, connection)
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

    await publish_attachment_change(story_id)
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
export async function move_attachments(story_id: number, moves: AttachmentMove[]): Promise<ContentAttachmentBatchResult> {
  return await with_attachment_lock(story_id, 'move', async () => {
    const story = await get_story(story_id)
    const attachments = story.attachments
    const by_name = new Map(attachments.map(item => [item.file_name, item]))

    const planned: { attachment: ContentStoryAttachment, old_file_name: string, new_file_name: string }[] = []
    const skipped: ContentBatchSkipped[] = []
    for (const move of moves) {
      const attachment = by_name.get(move.file_name)
      if (! attachment) {
        skipped.push({ file_name: move.file_name, reason: '附件不存在或已被删除' })
        continue
      }
      const new_file_name = attachment_path_join(move.target_folder, attachment_base_name(move.file_name))
      if (new_file_name !== move.file_name)
        planned.push({ attachment, old_file_name: move.file_name, new_file_name })
    }

    if (! planned.length) {
      publish_attachment_refresh(story_id)
      return { attachments, succeeded: [], skipped }
    }

    // A destination must not collide with anything that still exists after the
    // batch — files and folders alike — and two moves in the same batch must not
    // land on the same name. The batch's own sources are excluded: a chained
    // move (a→b, b→c) frees the name it vacates.
    const moved_away = new Set(planned.map(plan => plan.old_file_name.toLowerCase()))
    const remaining = (await list_scope_paths(story_id)).filter(path => ! moved_away.has(path.toLowerCase()))
    const destinations = new Set<string>()
    const available: typeof planned = []
    for (const plan of planned) {
      const lower = plan.new_file_name.toLowerCase()
      if (destinations.has(lower)) {
        skipped.push({ file_name: plan.old_file_name, reason: attachment_name_conflict_message })
        continue
      }
      destinations.add(lower)
      // The batch's own sources are already excluded from `remaining`, so the
      // guard sees exactly the names that survive it. Only the folder changes,
      // so the row's own name (and any `.good` marker on it) is not re-validated.
      try {
        assert_attachment_name_available(plan.new_file_name, remaining)
      }
      catch (error) {
        if (error instanceof ApiError && error.statusCode === 409) {
          skipped.push({ file_name: plan.old_file_name, reason: attachment_name_conflict_message })
          continue
        }
        throw error
      }
      available.push(plan)
    }
    planned.splice(0, planned.length, ... available)

    if (! planned.length) {
      publish_attachment_refresh(story_id)
      return { attachments, succeeded: [], skipped }
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

    await publish_attachment_change(story_id)
    const result_attachments = (await get_story(story_id)).attachments
    return {
      attachments: result_attachments,
      succeeded: planned.map(plan => plan.old_file_name),
      skipped,
    }
  })
}

export async function rename_attachment(story_id: number, old_file_name: string, new_file_name: string) {
  return await with_attachment_lock(story_id, 'rename', async () => {
    const story = await get_story(story_id)
    const attachments = story.attachments
    const attachment = attachments.find(item => item.file_name === old_file_name)
    if (! attachment) {
      throw new ApiError(404, '附件不存在或已被删除')
    }
    if (old_file_name === new_file_name) {
      return attachment
    }
    // The renamed file is excluded from its own conflict check.
    const file_name = resolve_renamed_attachment_name(old_file_name, new_file_name, await list_scope_paths(story_id))

    const connection = await db.getConnection()
    try {
      await connection.beginTransaction()
      await rename_attachment_row(story_id, old_file_name, file_name, connection)
      await rewrite_story_attachment_refs(connection, story.id, [{ old_file_name, new_file_name: file_name }])
      await connection.commit()
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
    finally {
      connection.release()
    }

    await publish_attachment_change(story_id)
    const row = await get_scope_attachment(story_id, file_name)
    return row ?? { ... attachment, file_name }
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
  key: string,
  raw_file_name: string,
  content_type: string | null,
  mode: 'keep-name' | 'new-name',
) {
  assert_content_upload_key(story_id, key)
  const story = await get_story(story_id)
  const attachments = story.attachments
  const attachment = attachments.find(item => item.file_name === old_file_name)
  if (! attachment) {
    throw new ApiError(404, '附件不存在或已被删除')
  }
  // A replacement swaps the object but not the row's key, so replacing an
  // encrypted file would leave a key on plaintext bytes: the client would try
  // to decrypt readable content and the file would end up unopenable. Leaving
  // the encrypted state is 取消加密's job, not a file swap's.
  if (attachment.is_encrypted)
    throw new ApiError(409, '已加密的附件不能替换，请先取消加密')

  const object = await head_object(key)
  const new_name = sanitize_attachment_file_name(raw_file_name || 'file', config.app.content.link.fileNameMaxBytes)
  // The scope's files and folders share one path space, so a replacement has to
  // clear both before it can take a name.
  const existing = await list_scope_paths(story_id)

  // Resolve the replacement file name. `keep-name` reuses the old stem but
  // adopts the new file's extension; `new-name` uses the new file's name fully.
  // Both go through the shared guard: the incoming extension is the one piece
  // of the name the uploader controls, so `.good` has to be refused here too.
  let file_name: string
  if (mode === 'keep-name') {
    const new_ext = file_extension(new_name)
    file_name = resolve_attachment_name(
      new_ext ? `${file_stem(old_file_name)}${new_ext}` : old_file_name,
      existing,
      'reject',
      old_file_name,
    )
  }
  else {
    // Keep the replacement in the same folder as the file it replaces.
    file_name = resolve_attachment_name(
      attachment_path_join(attachment_folder_of(old_file_name), new_name),
      existing,
      'suffix',
      old_file_name,
    )
  }

  const old_keys = await get_scope_object_keys(story_id, [old_file_name])
  // A replacement always lands on a fresh object; the old one is deleted after.
  const object_key = `content/att/${crypto.randomUUID()}`
  const etag = await copy_object(key, object_key)
  await delete_object_best_effort(key)
  const version = etag ?? object.etag ?? String(Date.now())

  try {
    // Rewrite markdown/cover references only when the final name changed.
    const markdown = file_name === old_file_name
      ? story.markdown
      : rename_attachment_references(story.markdown, old_file_name, file_name)
    const renamed_cover = story.cover === old_file_name ? file_name : (story.cover ?? '')
    const cover_version = cover_version_from(story.attachments, renamed_cover, { file_name, version })
    // An in-place replacement of the cover file rewrites no references but the etag.
    const cover_object_rewritten = renamed_cover !== '' && renamed_cover === file_name
    if (markdown !== story.markdown || renamed_cover !== (story.cover ?? '') || cover_object_rewritten) {
      await db.execute('UPDATE content_stories SET markdown = ?, cover = ?, cover_version = ? WHERE id = ?', [markdown, renamed_cover, cover_version, story.id])
    }
    await update_attachment_row_object(story_id, old_file_name, {
      file_name,
      object_key,
      mime_type: content_type || attachment_mime_type(file_name),
      file_size: object.size,
      version,
    })
  }
  catch (ex) {
    await delete_object_best_effort(object_key)
    throw ex
  }

  await Promise.all(old_keys.map(key => delete_object_best_effort(key)))

  await publish_attachment_change(story_id)
  const row = await get_scope_attachment(story_id, file_name)
  if (! row)
    throw new ApiError(500, '附件写入失败，请重试')
  return row
}
