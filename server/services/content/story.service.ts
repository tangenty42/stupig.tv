import type { AuthUser } from '@server/types/auth'
import type { ContentMarkdownConfig, ContentStoryMeta } from '@shared/content-markdown'
import type { ContentBatchSkipped, ContentStoryAttachment, ContentStoryDetail } from '@shared/types/content'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { get_operation_lock } from '@server/lib/operation-lock'
import { delete_object_best_effort } from '@server/lib/storage'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { delete_attachment_rows, delete_story_attachment_rows, get_scope_object_keys, get_story_object_keys, list_cover_urls, list_scope_attachments, list_scope_encryption_keys, list_scope_folders } from '@server/services/content-attachments.service'
import { runtime_config } from '@shared/config'
import { extract_attachment_names, extract_story_reference_titles, parse_story_markdown, rename_story_references } from '@shared/content-markdown'
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
export function cover_version_from(attachments: ContentStoryAttachment[], cover: string, written?: { file_name: string, version: string | null }) {
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
