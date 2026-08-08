import type { ContentMarkdownConfig, ContentStoryMeta } from '@shared/content-markdown'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { link, mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { attachment_url_path, extract_attachment_names, extract_story_reference_titles, parse_story_markdown, rename_attachment_references, sanitize_attachment_file_name } from '@shared/content-markdown'
import { env } from '@shared/env'

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
}

interface StoryReferrerRow extends RowDataPacket {
  id: number
  markdown: string
}

interface StoryAttachmentRow extends RowDataPacket {
  file_name: string
  mime_type: string | null
  file_size: number
}

interface StoryVersionRow extends RowDataPacket {
  updated_at: string | Date
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
    throw new ApiError(409, `标题「${title}」已被使用，请换一个标题`)
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

function format_attachment(story_id: number, row: { file_name: string, mime_type: string | null, file_size: number }) {
  return {
    file_name: row.file_name,
    mime_type: row.mime_type,
    file_size: Number(row.file_size),
    is_image: (row.mime_type ?? '').startsWith('image/'),
    url: attachment_url_path(story_id, row.file_name),
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

export async function get_story(id: number) {
  const [stories] = await db.execute<StoryRow[]>(
    'SELECT id, title, label, description, cover, cover_label, event_precision, event_dates, markdown, created_at, updated_at FROM content_stories WHERE id = ?',
    [id],
  )
  const story = stories[0]
  if (! story) {
    throw new ApiError(404, '档案不存在或已被删除')
  }

  const [attachments] = await db.execute<StoryAttachmentRow[]>(
    'SELECT file_name, mime_type, file_size FROM content_story_attachments WHERE story_id = ? ORDER BY id',
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
}

/**
 * Saves the markdown and permanently deletes the attachments listed in
 * `delete_files` (trash bin confirmation flow). Returns the accepted file
 * names for callers that need to confirm a requested deletion occurred.
 */
export async function update_story(id: number, markdown: string, delete_files: string[], base_updated_at: string, static_root: string) {
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
    const [version_rows] = await connection.execute<StoryVersionRow[]>(
      'SELECT updated_at FROM content_stories WHERE id = ? FOR UPDATE',
      [id],
    )
    const current_version = version_rows[0]
    if (! current_version) {
      throw new ApiError(404, '档案不存在或已被删除')
    }
    if (new Date(current_version.updated_at).getTime() !== new Date(base_updated_at).getTime()) {
      throw new ApiError(409, '档案已被其他编辑更新，请先处理版本冲突')
    }

    await connection.execute(
      'UPDATE content_stories SET title = ?, label = ?, description = ?, cover = ?, cover_label = ?, event_precision = ?, event_dates = CAST(? AS JSON), related_story_ids = CAST(? AS JSON), markdown = ? WHERE id = ?',
      [meta.title, meta.labels.join(' '), meta.desc ?? '', meta.cover ?? '', meta.cover_label ?? '', meta.event_precision, story_event_dates(meta), related_story_ids, markdown, id],
    )

    // A title change must cascade into stories that `@`-referenced the old title.
    if (old_title !== new_title) {
      const [referrers] = await connection.execute<StoryReferrerRow[]>(
        'SELECT id, markdown FROM content_stories WHERE JSON_CONTAINS(related_story_ids, ?) AND id != ?',
        [String(id), id],
      )
      for (const referrer of referrers) {
        // TODO: This is a naive string replacement; it could be improved to only replace valid `[](@title)` references, not arbitrary text that happens to match.
        const rewritten = referrer.markdown.replaceAll(`(@${old_title})`, `(@${new_title})`)
        if (rewritten !== referrer.markdown) {
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
  // Orphan files live under content/0/ until claimed by a created story.
  return format_attachment(story_id ?? 0, { file_name, mime_type, file_size })
}

/** True when a story (or the orphan pool when null) already has this file name. */
export async function attachment_name_taken(story_id: number | null, file_name: string) {
  const [rows] = await db.execute<RowDataPacket[]>(
    'SELECT 1 AS taken FROM content_story_attachments WHERE story_id <=> ? AND file_name = ? LIMIT 1',
    [story_id, file_name],
  )
  return rows.length > 0
}

/** Lists unclaimed (story_id NULL) attachments staged under content/0/. */
export async function list_orphan_attachments() {
  const [attachments] = await db.execute<StoryAttachmentRow[]>(
    'SELECT file_name, mime_type, file_size FROM content_story_attachments WHERE story_id IS NULL ORDER BY id',
  )
  return attachments.map(row => format_attachment(0, row))
}

export async function upload_attachment(story_id: number | null, input: FormData, get_options: () => AttachmentUploadOptions) {
  const upload = get_form_file(input, 'file')
  const file_data = Buffer.from(await upload.arrayBuffer())
  const options = get_options()

  if (file_data.length > options.max_size_mb * 1024 * 1024) {
    throw new ApiError(413, `文件太大了，不能超过 ${options.max_size_mb} MB`)
  }

  const ext = extname(upload.name ?? '').toLowerCase()

  let file_name = sanitize_attachment_file_name(upload.name ?? 'file', env.CONTENT_LINK_FILE_NAME_MAX_BYTES)
  if (await attachment_name_taken(story_id, file_name)) {
    const stem = ext ? file_name.slice(0, - ext.length) : file_name
    file_name = `${stem}-${Date.now().toString(36)}${ext}`
  }

  const attachment = await add_attachment(story_id, file_name, upload.type || null, file_data.length)
  const dir = join(options.static_root, 'content', String(story_id ?? 0))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, file_name), file_data)
  return attachment
}

/** Deletes an unclaimed (story_id NULL) attachment and its staged file. */
export async function delete_orphan_attachment(file_name: string, static_root: string) {
  const [result] = await db.execute<ResultSetHeader>(
    'DELETE FROM content_story_attachments WHERE story_id IS NULL AND file_name = ?',
    [file_name],
  )
  if (! result.affectedRows)
    throw new ApiError(404, '附件不存在或已被删除')

  await unlink(join(static_root, 'content', '0', file_name)).catch(() => {})
}

export async function delete_attachment(story_id: number, file_name: string, markdown: string, base_updated_at: string, static_root: string) {
  const deleted_files = await update_story(story_id, markdown, [file_name], base_updated_at, static_root)
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
  if (story.attachments.some(item => item.file_name === new_file_name)) {
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
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    await connection.execute(
      'UPDATE content_story_attachments SET file_name = ? WHERE story_id = ? AND file_name = ?',
      [new_file_name, story_id, old_file_name],
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
  return format_attachment(story_id, { ... attachment, file_name: new_file_name })
}
