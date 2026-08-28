import type { ContentMarkdownConfig, ContentStoryMeta } from '@shared/content-markdown'
import type { ContentStoryDetail } from '@shared/types/content'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { link, mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { random_file_token } from '@server/lib/random'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { attachment_url_path, extract_attachment_names, extract_story_reference_titles, link_file_name_byte_length, parse_story_markdown, rename_attachment_references, rename_story_references, sanitize_attachment_file_name } from '@shared/content-markdown'
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

interface StoryAttachmentRow extends RowDataPacket {
  file_name: string
  mime_type: string | null
  file_size: number
  version: string
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
  static_root: string
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

function new_attachment_version() {
  return random_file_token()
}

function format_attachment(story_id: number, row: { file_name: string, mime_type: string | null, file_size: number, version: string }) {
  return {
    file_name: row.file_name,
    mime_type: row.mime_type,
    file_size: Number(row.file_size),
    version: row.version,
    is_image: (row.mime_type ?? '').startsWith('image/'),
    // `?version=` cache-busts replaced/renamed files so browsers re-fetch them.
    url: `${attachment_url_path(story_id, row.file_name)}?version=${row.version}`,
  }
}

function parse_labels(value: string) {
  return value.split(/\s+/).filter(Boolean)
}

function format_desc_cover(story: Pick<StoryRow, 'description' | 'cover' | 'cover_label'>) {
  return { desc: story.description || null, cover: story.cover || null, cover_label: story.cover_label || null }
}

export async function list_stories() {
  const [stories] = await db.execute<StoryRow[]>(
    'SELECT id, title, label, description, cover, cover_label, event_precision, event_dates, created_at, updated_at FROM content_stories ORDER BY updated_at DESC',
  )

  return stories.map(story => ({
    id: story.id,
    title: story.title,
    labels: parse_labels(story.label),
    event_precision: story.event_precision,
    event_dates: parse_event_dates(story.event_dates),
    created_at: story.created_at,
    updated_at: story.updated_at,
    ... format_desc_cover(story),
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
    'SELECT id, title, label, description, cover, cover_label, event_precision, event_dates, markdown, created_at, updated_at, revision FROM content_stories WHERE id = ?',
    [id],
  )
  const story = stories[0]
  if (! story) {
    throw new ApiError(404, '档案不存在或已被删除')
  }

  const [attachments] = await db.execute<StoryAttachmentRow[]>(
    'SELECT file_name, mime_type, file_size, version FROM content_story_attachments WHERE story_id = ? ORDER BY id',
    [id],
  )

  return {
    id: story.id,
    title: story.title,
    labels: parse_labels(story.label),
    event_precision: story.event_precision,
    event_dates: parse_event_dates(story.event_dates),
    markdown: story.markdown,
    attachments: attachments.map(row => format_attachment(story.id, row)),
    created_at: story.created_at,
    updated_at: story.updated_at,
    revision: story.revision,
    ... format_desc_cover(story),
  }
}

/** Serialize the story's event entries into the JSON array stored on the row. */
function story_event_dates(meta: ContentStoryMeta) {
  const dates = meta.event_entries.map(entry => event_row_date(meta.event_precision, entry))
  dates.sort((a, b) => a.localeCompare(b))
  return JSON.stringify(dates)
}

export async function create_story(created_by: number, markdown: string, claim_files: string[], static_root: string) {
  const existing_titles = await existing_story_titles(0)
  const meta = parse_or_throw(markdown, existing_titles)
  await ensure_unique_title(meta.title, 0)

  const [result] = await db.execute<ResultSetHeader>(
    'INSERT INTO content_stories (title, label, description, cover, cover_label, event_precision, event_dates, related_story_ids, markdown, created_by) VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?)',
    [meta.title, meta.labels.join(' '), meta.desc ?? '', meta.cover ?? '', meta.cover_label ?? '', meta.event_precision, story_event_dates(meta), await resolve_related_story_ids(markdown, 0), markdown, created_by],
  )
  const story_id = Number(result.insertId)

  if (claim_files.length)
    await claim_attachments(story_id, claim_files, static_root)

  publish_refresh({ resource: sync_resource('content_stories', 'all') })
  return story_id
}

/** Adopts orphan attachments (story_id NULL, staged under content/0/) into a story. */
async function claim_attachments(story_id: number, file_names: string[], static_root: string) {
  const claimed: string[] = []
  for (const file_name of new Set(file_names)) {
    const [result] = await db.execute<ResultSetHeader>(
      'UPDATE content_story_attachments SET story_id = ? WHERE story_id IS NULL AND file_name = ?',
      [story_id, file_name],
    )
    if (result.affectedRows)
      claimed.push(file_name)
  }
  if (! claimed.length)
    return

  const staging_dir = join(static_root, 'content', '0')
  const story_dir = join(static_root, 'content', String(story_id))
  await mkdir(story_dir, { recursive: true })
  await Promise.all(claimed.map(file_name =>
    rename(join(staging_dir, file_name), join(story_dir, file_name)).catch(() => {}),
  ))
  publish_refresh({ resource: sync_resource('content_story', story_id) })
  publish_refresh({ resource: sync_resource('content_orphan_attachments', 'all') })
}

/**
 * Saves the markdown and permanently deletes the attachments listed in
 * `delete_files` (trash bin confirmation flow). Returns the accepted file
 * names for callers that need to confirm a requested deletion occurred.
 */
export async function update_story(id: number, markdown: string, delete_files: string[], base_revision: number, static_root: string) {
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
      'UPDATE content_stories SET title = ?, label = ?, description = ?, cover = ?, cover_label = ?, event_precision = ?, event_dates = CAST(? AS JSON), related_story_ids = CAST(? AS JSON), markdown = ?, revision = revision + 1 WHERE id = ?',
      [meta.title, meta.labels.join(' '), meta.desc ?? '', meta.cover ?? '', meta.cover_label ?? '', meta.event_precision, story_event_dates(meta), related_story_ids, markdown, id],
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

    for (const file_name of accepted_deletes) {
      await connection.execute(
        'DELETE FROM content_story_attachments WHERE story_id = ? AND file_name = ?',
        [id, file_name],
      )
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

  await Promise.all(accepted_deletes.map(file_name =>
    unlink(join(static_root, 'content', String(id), file_name)).catch(() => {}),
  ))
  return accepted_deletes
}

/** Deletes the story row and its attachment directory. */
export async function delete_story(id: number, static_root: string) {
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

  await db.execute('DELETE FROM content_stories WHERE id = ?', [id])

  publish_refresh({ resource: sync_resource('content_stories', 'all') })
  publish_refresh({ resource: sync_resource('content_story', id) })
  await rm(join(static_root, 'content', String(id)), { recursive: true, force: true }).catch(() => {})
}

export async function add_attachment(story_id: number | null, file_name: string, mime_type: string | null, file_size: number) {
  if (story_id !== null)
    await get_story(story_id)

  await db.execute(
    'INSERT INTO content_story_attachments (story_id, file_name, mime_type, file_size) VALUES (?, ?, ?, ?)',
    [story_id, file_name, mime_type, file_size],
  )

  if (story_id !== null)
    publish_refresh({ resource: sync_resource('content_story', story_id) })
  else
    publish_refresh({ resource: sync_resource('content_orphan_attachments', 'all') })
  // Orphan files live under content/0/ until claimed by a created story.
  return format_attachment(story_id ?? 0, { file_name, mime_type, file_size, version: new_attachment_version() })
}

/** True when a story (or the orphan pool when null) already has this file name. */
export async function attachment_name_taken(story_id: number | null, file_name: string) {
  const [rows] = await db.execute<RowDataPacket[]>(
    'SELECT 1 AS taken FROM content_story_attachments WHERE story_id <=> ? AND file_name = ? LIMIT 1',
    [story_id, file_name],
  )
  return rows.length > 0
}

/**
 * True when ANOTHER attachment row in the story already holds this name. Done
 * in SQL because the unique index's utf8mb4_unicode_ci collation is
 * case-insensitive — a JS `===` check misses case-variant conflicts and the
 * row dies at the DB with a raw duplicate-entry error.
 */
async function attachment_name_conflicts(story_id: number, file_name: string, ignore_file_name: string) {
  const [rows] = await db.execute<RowDataPacket[]>(
    'SELECT 1 AS conflict FROM content_story_attachments WHERE story_id = ? AND file_name = ? AND file_name <> ? LIMIT 1',
    [story_id, file_name, ignore_file_name],
  )
  return rows.length > 0
}

/** Lists unclaimed (story_id NULL) attachments staged under content/0/. */
export async function list_orphan_attachments() {
  const [attachments] = await db.execute<StoryAttachmentRow[]>(
    'SELECT file_name, mime_type, file_size, version FROM content_story_attachments WHERE story_id IS NULL ORDER BY id',
  )
  return attachments.map(row => format_attachment(0, row))
}

/** True for a MySQL duplicate-key violation (errno 1062). */
function is_duplicate_key_error(error: unknown) {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ER_DUP_ENTRY'
}

/** Rebuilds a taken file name with a random suffix before the extension, keeping the byte cap. */
function suffixed_attachment_name(file_name: string, ext: string) {
  const stem = ext ? file_name.slice(0, - ext.length) : file_name
  const suffix = `-${random_file_token()}`
  const stem_limit = env.CONTENT_LINK_FILE_NAME_MAX_BYTES - link_file_name_byte_length(suffix) - link_file_name_byte_length(ext)
  return `${sanitize_attachment_file_name(stem, Math.max(stem_limit, 1))}${suffix}${ext}`
}

export async function upload_attachment(story_id: number | null, input: FormData, get_options: () => AttachmentUploadOptions) {
  const upload = get_form_file(input, 'file')
  const file_data = Buffer.from(await upload.arrayBuffer())
  const options = get_options()

  if (file_data.length > options.max_size_mb * 1024 * 1024) {
    throw new ApiError(413, `文件太大了，不能超过 ${options.max_size_mb} MB`)
  }

  const ext = extname(upload.name ?? '').toLowerCase()

  const base_name = sanitize_attachment_file_name(upload.name ?? 'file', env.CONTENT_LINK_FILE_NAME_MAX_BYTES)
  let file_name = base_name
  if (await attachment_name_taken(story_id, file_name)) {
    file_name = suffixed_attachment_name(base_name, ext)
  }

  // The unique index is the final guard: a same-name upload racing past the
  // pre-check (or a suffix collision) retries with a fresh random suffix.
  for (let attempt = 1; ; attempt ++) {
    try {
      const attachment = await add_attachment(story_id, file_name, upload.type || null, file_data.length)
      const dir = join(options.static_root, 'content', String(story_id ?? 0))
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, file_name), file_data)
      return attachment
    }
    catch (error) {
      if (attempt >= 3 || ! is_duplicate_key_error(error)) {
        throw error
      }
      file_name = suffixed_attachment_name(base_name, ext)
    }
  }
}

/** Deletes an unclaimed (story_id NULL) attachment and its staged file. */
export async function delete_orphan_attachment(file_name: string, static_root: string) {
  const [result] = await db.execute<ResultSetHeader>(
    'DELETE FROM content_story_attachments WHERE story_id IS NULL AND file_name = ?',
    [file_name],
  )
  if (! result.affectedRows)
    throw new ApiError(404, '附件不存在或已被删除')

  publish_refresh({ resource: sync_resource('content_orphan_attachments', 'all') })
  await unlink(join(static_root, 'content', '0', file_name)).catch(() => {})
}

export async function delete_attachment(story_id: number, file_name: string, markdown: string, base_revision: number, static_root: string) {
  const deleted_files = await update_story(story_id, markdown, [file_name], base_revision, static_root)
  if (! deleted_files.includes(file_name)) {
    throw new ApiError(404, '附件不存在或已被删除')
  }
}

export async function rename_attachment(story_id: number, old_file_name: string, new_file_name: string, static_root: string) {
  const story = await get_story(story_id)
  const attachment = story.attachments.find(item => item.file_name === old_file_name)
  if (! attachment) {
    throw new ApiError(404, '附件不存在或已被删除')
  }
  if (old_file_name === new_file_name) {
    return attachment
  }
  if (await attachment_name_conflicts(story_id, new_file_name, old_file_name)) {
    throw new ApiError(409, '已有同名附件')
  }

  const dir = join(static_root, 'content', String(story_id))
  const old_path = join(dir, old_file_name)
  const new_path = join(dir, new_file_name)

  try {
    await link(old_path, new_path)
  }
  catch (ex) {
    const code = (ex as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new ApiError(404, '附件文件不存在，无法重命名')
    }
    if (code === 'EEXIST') {
      throw new ApiError(409, '存储目录中已有同名文件')
    }
    throw ex
  }

  const markdown = rename_attachment_references(story.markdown, old_file_name, new_file_name)
  // The front matter cover may reference the renamed file (bare name or ![](name)).
  const renamed_cover = story.cover === old_file_name ? new_file_name : (story.cover ?? '')
  // Fresh random version so the renamed URL cache-busts too.
  const next_version = new_attachment_version()
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    await connection.execute(
      'UPDATE content_story_attachments SET file_name = ?, version = ? WHERE story_id = ? AND file_name = ?',
      [new_file_name, next_version, story_id, old_file_name],
    )
    if (markdown !== story.markdown || renamed_cover !== (story.cover ?? '')) {
      await connection.execute('UPDATE content_stories SET markdown = ?, cover = ? WHERE id = ?', [markdown, renamed_cover, story_id])
    }
    await connection.commit()
  }
  catch (ex) {
    await connection.rollback()
    await unlink(new_path).catch(() => {})
    throw ex
  }
  finally {
    connection.release()
  }

  await unlink(old_path).catch((ex) => {
    console.error(`Unable to remove renamed attachment source ${old_path}:`, ex)
  })

  publish_refresh({ resource: sync_resource('content_story', story_id) })
  return format_attachment(story_id, { ... attachment, file_name: new_file_name, version: next_version })
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
    if (await attachment_name_conflicts(story_id, file_name, old_file_name)) {
      throw new ApiError(409, '已有同名附件')
    }
  }
  else {
    file_name = new_name
    if (await attachment_name_conflicts(story_id, file_name, old_file_name)) {
      file_name = suffixed_attachment_name(file_name, file_extension(file_name))
    }
  }

  const dir = join(options.static_root, 'content', String(story_id))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, file_name), file_data)

  // Rewrite markdown/cover references only when the final name changed.
  const markdown = file_name === old_file_name
    ? story.markdown
    : rename_attachment_references(story.markdown, old_file_name, file_name)
  const renamed_cover = story.cover === old_file_name ? file_name : (story.cover ?? '')
  // Fresh random version so the replaced URL cache-busts too.
  const next_version = new_attachment_version()

  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    await connection.execute(
      'UPDATE content_story_attachments SET file_name = ?, mime_type = ?, file_size = ?, version = ? WHERE story_id = ? AND file_name = ?',
      [file_name, upload.type || null, file_data.length, next_version, story_id, old_file_name],
    )
    if (markdown !== story.markdown || renamed_cover !== (story.cover ?? '')) {
      await connection.execute('UPDATE content_stories SET markdown = ?, cover = ? WHERE id = ?', [markdown, renamed_cover, story_id])
    }
    await connection.commit()
  }
  catch (ex) {
    await connection.rollback()
    // Only remove a file we wrote to a new path; an in-place overwrite must
    // keep its content (the DB row still references that name).
    if (file_name !== old_file_name) {
      await unlink(join(dir, file_name)).catch(() => {})
    }
    throw ex
  }
  finally {
    connection.release()
  }

  if (file_name !== old_file_name) {
    await unlink(join(dir, old_file_name)).catch(() => {})
  }

  publish_refresh({ resource: sync_resource('content_story', story_id) })
  return format_attachment(story_id, {
    file_name,
    mime_type: upload.type || null,
    file_size: file_data.length,
    version: next_version,
  })
}
