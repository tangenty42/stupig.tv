import type { ContentStoryMeta } from '@shared/content-markdown'
import type { ContentStoryAttachment, ContentStoryDetail, ContentStorySummary } from '@shared/types/content'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { link, unlink } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { attachment_url_path, extract_attachment_names, parse_story_markdown, rename_attachment_references } from '@shared/content-markdown'

interface StoryRow extends RowDataPacket {
  id: number
  title: string
  rating: number
  event_precision: 'day' | 'month'
  /** JSON array of 'YYYY-MM-DD' strings; month-precision stories use the first of the month. */
  event_dates: string | string[]
  markdown: string
  created_at: string
  updated_at: string
}

interface StoryAttachmentRow extends RowDataPacket {
  file_name: string
  mime_type: string | null
  file_size: number
}

const blocked_attachment_ext = new Set(['.html', '.htm', '.svg', '.xml', '.js', '.mjs', '.xhtml'])

function parse_or_throw(markdown: string): ContentStoryMeta {
  const { meta, issues } = parse_story_markdown(markdown)
  if (! meta) {
    throw new ApiError(400, issues[0]?.message ?? '档案格式不正确')
  }
  return meta
}

function event_row_date(precision: 'day' | 'month', entry: string): string {
  return precision === 'month' ? `${entry}-01` : entry
}

/** mysql2 returns a JSON column as a string; normalize to a sorted string array. */
function parse_event_dates(value: string | string[]): string[] {
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

function format_attachment(story_id: number, row: { file_name: string, mime_type: string | null, file_size: number }): ContentStoryAttachment {
  return {
    file_name: row.file_name,
    mime_type: row.mime_type,
    file_size: Number(row.file_size),
    is_image: (row.mime_type ?? '').startsWith('image/'),
    url: attachment_url_path(story_id, row.file_name),
  }
}

export async function list_stories(): Promise<ContentStorySummary[]> {
  const [stories] = await db.execute<StoryRow[]>(
    'SELECT id, title, rating, event_precision, event_dates, created_at, updated_at FROM content_stories ORDER BY updated_at DESC',
  )

  return stories.map(story => ({
    id: story.id,
    title: story.title,
    rating: story.rating,
    event_precision: story.event_precision,
    event_dates: parse_event_dates(story.event_dates),
    created_at: story.created_at,
    updated_at: story.updated_at,
  }))
}

export async function get_story(id: number): Promise<ContentStoryDetail> {
  const [stories] = await db.execute<StoryRow[]>(
    'SELECT id, title, rating, event_precision, event_dates, markdown, created_at, updated_at FROM content_stories WHERE id = ?',
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
    rating: story.rating,
    event_precision: story.event_precision,
    event_dates: parse_event_dates(story.event_dates),
    markdown: story.markdown,
    attachments: attachments.map(row => format_attachment(story.id, row)),
    created_at: story.created_at,
    updated_at: story.updated_at,
  }
}

/** Serialize the story's event entries into the JSON array stored on the row. */
function story_event_dates(meta: ContentStoryMeta): string {
  const dates = meta.event_entries.map(entry => event_row_date(meta.event_precision, entry))
  dates.sort((a, b) => a.localeCompare(b))
  return JSON.stringify(dates)
}

export async function create_story(created_by: number, markdown: string): Promise<number> {
  const meta = parse_or_throw(markdown)

  const [result] = await db.execute<ResultSetHeader>(
    'INSERT INTO content_stories (title, rating, event_precision, event_dates, markdown, created_by) VALUES (?, ?, ?, CAST(? AS JSON), ?, ?)',
    [meta.title, meta.rating, meta.event_precision, story_event_dates(meta), markdown, created_by],
  )
  const story_id = Number(result.insertId)

  publish_refresh({ resource: sync_resource('content_stories', 'all') })
  return story_id
}

/**
 * Saves the markdown and permanently deletes the attachments listed in
 * `delete_files` (trash bin confirmation flow). Returns the file names that
 * were accepted for deletion so the route can remove them from disk.
 */
export async function update_story(id: number, markdown: string, delete_files: string[]): Promise<string[]> {
  const story = await get_story(id)
  const meta = parse_or_throw(markdown)

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

  await db.execute(
    'UPDATE content_stories SET title = ?, rating = ?, event_precision = ?, event_dates = CAST(? AS JSON), markdown = ? WHERE id = ?',
    [meta.title, meta.rating, meta.event_precision, story_event_dates(meta), markdown, id],
  )

  for (const file_name of accepted_deletes) {
    await db.execute(
      'DELETE FROM content_story_attachments WHERE story_id = ? AND file_name = ?',
      [id, file_name],
    )
  }

  publish_refresh({ resource: sync_resource('content_stories', 'all') })
  publish_refresh({ resource: sync_resource('content_story', id) })
  return accepted_deletes
}

/** Deletes the story row (events/attachments cascade). Returns attachment file names for disk cleanup. */
export async function delete_story(id: number): Promise<string[]> {
  const story = await get_story(id)
  await db.execute('DELETE FROM content_stories WHERE id = ?', [id])

  publish_refresh({ resource: sync_resource('content_stories', 'all') })
  publish_refresh({ resource: sync_resource('content_story', id) })
  return story.attachments.map(a => a.file_name)
}

export async function add_attachment(story_id: number, file_name: string, mime_type: string | null, file_size: number): Promise<ContentStoryAttachment> {
  await get_story(story_id)

  await db.execute(
    'INSERT INTO content_story_attachments (story_id, file_name, mime_type, file_size) VALUES (?, ?, ?, ?)',
    [story_id, file_name, mime_type, file_size],
  )

  publish_refresh({ resource: sync_resource('content_story', story_id) })
  return format_attachment(story_id, { file_name, mime_type, file_size })
}

/** True when a story already has an attachment with this file name. */
export async function attachment_name_taken(story_id: number, file_name: string): Promise<boolean> {
  const [rows] = await db.execute<RowDataPacket[]>(
    'SELECT 1 AS taken FROM content_story_attachments WHERE story_id = ? AND file_name = ? LIMIT 1',
    [story_id, file_name],
  )
  return rows.length > 0
}

export async function rename_attachment(story_id: number, old_file_name: string, new_file_name: string, static_root: string): Promise<ContentStoryAttachment> {
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
  if (blocked_attachment_ext.has(extname(new_file_name).toLowerCase())) {
    throw new ApiError(415, '不支持该类型的文件名')
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
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    await connection.execute(
      'UPDATE content_story_attachments SET file_name = ? WHERE story_id = ? AND file_name = ?',
      [new_file_name, story_id, old_file_name],
    )
    if (markdown !== story.markdown) {
      await connection.execute('UPDATE content_stories SET markdown = ? WHERE id = ?', [markdown, story_id])
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
  return format_attachment(story_id, { ...attachment, file_name: new_file_name })
}
