import type { AuthUser } from '@server/types/auth'
import type { ContentMarkdownConfig, ContentStoryMeta } from '@shared/content-markdown'
import type { ContentStoryAttachment, ContentStoryBody } from '@shared/types/content'
import type { ContentReferenceBaseline } from '@shared/types/content-reference'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { createHash } from 'node:crypto'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { delete_story_attachment_rows, get_story_object_keys, list_cover_urls } from '@server/services/content-attachments.service'
import { extract_story_reference_titles, parse_story_markdown, rename_story_references } from '@shared/content-markdown'
import { has_private_content, redact_private_content } from '@shared/content-private'
import { build_html_diagnostics, html_lint_line } from '@shared/html-lint'
import { has_permission } from '@shared/permissions'
import { settings } from '@shared/settings'
import { sync_resource } from '@shared/types/sync'
import { enqueue_object_retirement } from './object-retirement.repository'
import { lock_title_namespace, record_title_change, replay_locked_references } from './reference-history.service'
import { enqueue_content_refresh } from './sync-outbox.repository'
import { require_workspace_actor } from './workspace-auth.service'
import { active_reservations, ensure_workspace_root } from './workspace.repository'

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
  namespace_revision: number
}

interface StoryReferrerRow extends RowDataPacket {
  id: number
  markdown: string
}

const content_markdown_config = {
  title_max_length: settings.app.content.story.titleMaxLength,
  label_max_bytes: settings.app.content.story.labelMaxBytes,
  desc_max_bytes: settings.app.content.story.descMaxBytes,
  cover_max_bytes: settings.app.content.story.coverMaxBytes,
  markdown_max_bytes: settings.app.content.story.markdownMaxBytes,
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
async function existing_story_titles(exclude_id: number, executor = db as Pick<typeof db, 'execute'>) {
  const [rows] = await executor.execute<RowDataPacket[]>(
    'SELECT id, title FROM content_stories WHERE id != ?',
    [exclude_id],
  )
  return rows.map(row => ({ id: Number(row.id), title: String(row.title) }))
}

/** Rejects duplicate titles (case-insensitive, matching the table's unique index). */
async function ensure_unique_title(title: string, exclude_id: number, executor = db as Pick<typeof db, 'execute'>) {
  const [rows] = await executor.execute<RowDataPacket[]>(
    'SELECT id FROM content_stories WHERE title = ? AND id != ? LIMIT 1',
    [title, exclude_id],
  )
  if (rows.length) {
    throw new ApiError(409, `标题『${title}』已被使用，请换一个标题`)
  }
}

const max_related_story_refs = 200

/** Resolve `[](@title)` references in the markdown to story ids (excluding self), as a JSON array. */
async function resolve_related_story_ids(markdown: string, exclude_id: number, executor = db as Pick<typeof db, 'execute'>) {
  const titles = extract_story_reference_titles(markdown).slice(0, max_related_story_refs)
  if (! titles.length) {
    return '[]'
  }
  const placeholders = titles.map(() => '?').join(',')
  const [rows] = await executor.execute<RowDataPacket[]>(
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
  const [title_versions] = await db.execute<RowDataPacket[]>('SELECT revision FROM content_title_namespace WHERE id = 1')

  return stories.map(story => ({
    id: story.id,
    title: story.title,
    title_revision: Number(title_versions[0]?.revision ?? 0),
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

/** Hash the viewer's actual representation; hidden source bytes never enter guest hashes. */
function format_story_body(story: StoryRow, viewer: AuthUser | null, cover_url: string | null, title_revision: number): ContentStoryBody {
  const private_readable = has_permission(viewer, 'content_private', 'read')
  const body = {
    id: story.id, title: story.title, labels: parse_labels(story.label),
    event_precision: story.event_precision, event_dates: parse_event_dates(story.event_dates),
    markdown: private_readable ? story.markdown : redact_private_content(story.markdown),
    has_private: has_private_content(story.markdown), private_readable,
    revision: story.revision, created_at: story.created_at, updated_at: story.updated_at,
    viewer_key: story_viewer_key(viewer), ... format_desc_cover(story, cover_url),
  }
  return {
    ... body,
    // Namespace/title tokens belong to their own resources, not body freshness.
    namespace_revision: Number(story.namespace_revision), title_revision,
    representation_version: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  }
}

export async function get_story_body(id: number, viewer: AuthUser | null, base_representation_version?: string) {
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    const title = await lock_title_namespace(connection)
    const [rows] = await connection.execute<StoryRow[]>('SELECT * FROM content_stories WHERE id = ? FOR SHARE', [id])
    const story = rows[0]
    if (! story)
      throw new ApiError(404, '档案不存在或已被删除')
    const covers = await list_cover_urls(story.cover ? [{ story_id: id, file_name: story.cover }] : [], connection)
    const body = format_story_body(story, viewer, covers.get(`${id}:${story.cover}`) ?? null, title.revision)
    await connection.commit()
    return body.representation_version === base_representation_version ? null : body
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally {
    connection.release()
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
  const connection = await db.getConnection()
  let story_id: number
  try {
    await connection.beginTransaction()
    const title = await lock_title_namespace(connection, true)
    const meta = parse_or_throw(markdown, await existing_story_titles(0, connection))
    await ensure_unique_title(meta.title, 0, connection)
    const [result] = await connection.execute<ResultSetHeader>(
      'INSERT INTO content_stories (title, label, description, cover, cover_label, event_precision, event_dates, related_story_ids, markdown, created_by) VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?)',
      [meta.title, meta.labels.join(' '), meta.desc ?? '', meta.cover ?? '', meta.cover_label ?? '', meta.event_precision, story_event_dates(meta), await resolve_related_story_ids(markdown, 0, connection), markdown, created_by],
    )
    story_id = Number(result.insertId)
    await ensure_workspace_root(connection, story_id)
    // Creation advances catalog freshness without remapping an existing title.
    await record_title_change(connection, title.revision)
    await enqueue_content_refresh(connection, [sync_resource('content_stories', 'all'), sync_resource('content_titles', 'all')])
    await connection.commit()
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally {
    connection.release()
  }

  return story_id
}

/** Save under title then scope locks; mechanical changes never consume body revisions. */
export async function update_story(id: number, markdown: string, base_revision: number, can_private: boolean, baseline: ContentReferenceBaseline = { base_namespace_revision: null, base_title_revision: null }) {
  const connection = await db.getConnection()
  const rewritten_referrers: number[] = []
  let result
  let title_changed = false
  let exclusive_title_lock = false
  const submitted_markdown = markdown
  try {
    while (true) {
      markdown = submitted_markdown
      await connection.beginTransaction()
      const title_namespace = await lock_title_namespace(connection, exclusive_title_lock)
      const [rows] = await connection.execute<StoryRow[]>('SELECT * FROM content_stories WHERE id = ? FOR UPDATE', [id])
      const story = rows[0]
      if (! story)
        throw new ApiError(404, '档案不存在或已被删除')
      if (story.revision !== base_revision)
        throw new ApiError(409, '档案已被其他编辑更新，请先处理版本冲突')
      if (! can_private && (has_private_content(markdown) || has_private_content(story.markdown)))
        throw new ApiError(403, '内容包含机密内容，你没有机密内容的编辑权限')
      const replayed = await replay_locked_references(connection, id, markdown, baseline, title_namespace)
      const replaced = replayed.diagnostics.filter(item => item.reason === 'replaced')
      if (replaced.length) {
        throw new ApiError(409, '引用目标已被删除并同名重建，请确认引用后再保存', {
          code: 'REF_TARGET_REPLACED',
          details: { namespace_revision: replayed.namespace_revision, title_revision: replayed.title_revision, references: replaced.map(item => ({ ... item, reason: 'replaced' as const })) },
        })
      }
      markdown = replayed.confirmation?.markdown ?? replayed.markdown
      const meta = parse_or_throw(markdown, await existing_story_titles(id, connection))
      // Ordinary saves share the title lock. A rename retries from scratch with
      // an exclusive lock, never upgrading a shared lock while holding scope rows.
      if (story.title !== meta.title && ! exclusive_title_lock) {
        await connection.rollback()
        exclusive_title_lock = true
        continue
      }
      await ensure_unique_title(meta.title, id, connection)
      const [attachments] = await connection.execute<RowDataPacket[]>('SELECT file_name, version FROM content_story_attachments WHERE story_id = ? AND is_folder = 0', [id])
      const related = await resolve_related_story_ids(markdown, id, connection)
      await connection.execute(
        'UPDATE content_stories SET title = ?, label = ?, description = ?, cover = ?, cover_label = ?, cover_version = ?, event_precision = ?, event_dates = CAST(? AS JSON), related_story_ids = CAST(? AS JSON), markdown = ?, revision = revision + 1 WHERE id = ?',
        [meta.title, meta.labels.join(' '), meta.desc ?? '', meta.cover ?? '', meta.cover_label ?? '', attachments.find(row => row.file_name === meta.cover)?.version ?? null, meta.event_precision, story_event_dates(meta), related, markdown, id],
      )
      let title_revision = title_namespace.revision
      if (story.title !== meta.title) {
        title_changed = true
        await record_title_change(connection, title_revision, { node_id: id, from: story.title, to: meta.title })
        title_revision ++
        const [referrers] = await connection.execute<StoryReferrerRow[]>('SELECT id, markdown FROM content_stories WHERE JSON_CONTAINS(related_story_ids, ?) AND id != ? ORDER BY id FOR UPDATE', [String(id), id])
        for (const referrer of referrers) {
          const rewritten = rename_story_references(referrer.markdown, story.title, meta.title)
          if (rewritten !== referrer.markdown) {
            await connection.execute('UPDATE content_stories SET markdown = ? WHERE id = ?', [rewritten, referrer.id])
            rewritten_referrers.push(referrer.id)
          }
        }
      }
      result = { markdown, revision: base_revision + 1, namespace_revision: replayed.namespace_revision, title_revision, baseline_unavailable: replayed.baseline_unavailable, diagnostics: replayed.diagnostics }
      await enqueue_content_refresh(connection, [
        sync_resource('content_stories', 'all'), sync_resource('content_story', id),
        ... (title_changed ? [sync_resource('content_titles', 'all')] : []),
        ... rewritten_referrers.map(referrer_id => sync_resource('content_story', referrer_id)),
      ])
      await connection.commit()
      break
    }
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally {
    connection.release()
  }
  return result!
}

/** Deletes the story row and its attachment directory. */
export async function delete_story(id: number, actor_id: number) {
  const connection = await db.getConnection()
  let object_keys: Awaited<ReturnType<typeof get_story_object_keys>> = []
  try {
    await connection.beginTransaction()
    const titles = await lock_title_namespace(connection, true)
    const [stories] = await connection.execute<StoryRow[]>('SELECT * FROM content_stories WHERE id = ? FOR UPDATE', [id])
    if (! stories[0])
      throw new ApiError(404, '档案不存在或已被删除')
    const [private_files] = await connection.execute<RowDataPacket[]>('SELECT id FROM content_story_attachments WHERE story_id = ? AND is_private = 1 LIMIT 1', [id])
    await require_workspace_actor(actor_id, has_private_content(stories[0].markdown) || private_files.length > 0, connection)
    const { rows: active, expired_sessions } = await active_reservations(connection, id)
    if (active.length)
      throw new ApiError(409, '档案还有未完成的上传，请先取消或完成')
    const [referrers] = await connection.execute<RowDataPacket[]>('SELECT id, title FROM content_stories WHERE JSON_CONTAINS(related_story_ids, ?) AND id != ? ORDER BY id FOR UPDATE', [String(id), id])
    if (referrers.length)
      throw new ApiError(409, `仍有档案引用本档案：${referrers.map(row => String(row.title)).join('、')}`)
    object_keys = await get_story_object_keys(id, connection)
    if (object_keys.some(object => object.provider !== 'aliyun'))
      throw new ApiError(503, '档案附件尚未完成迁移')
    for (const object of object_keys)
      await enqueue_object_retirement(connection, object.key, id, 'story-delete')
    await record_title_change(connection, titles.revision, { node_id: id, from: stories[0].title, to: null })
    await delete_story_attachment_rows(id, connection)
    await connection.execute('DELETE FROM content_stories WHERE id = ?', [id])
    await connection.execute('DELETE FROM content_reference_journals WHERE scope_id = ?', [id])
    await enqueue_content_refresh(connection, [
      sync_resource('content_stories', 'all'), sync_resource('content_story', id),
      sync_resource('content_titles', 'all'), sync_resource('content_attachments', id),
      ... (expired_sessions.length ? [sync_resource('content_uploads', id), ... expired_sessions.map(session => sync_resource('content_upload_session', session))] : []),
    ])
    await connection.commit()
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally {
    connection.release()
  }
}
