import type { AuthUser } from '@server/types/auth'
import type { ContentMarkdownConfig, ContentStoryMeta } from '@shared/content-markdown'
import type { ContentStoryAttachment, ContentStoryBody } from '@shared/types/content'
import type { ContentReferenceBaseline } from '@shared/types/content-reference'
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { createHash } from 'node:crypto'
import { ApiError } from '@server/errors/ApiError'
import { ReferenceSafetyError } from '@server/errors/ReferenceSafetyError'
import { db } from '@server/lib/db'
import { delete_story_attachment_rows, get_story_object_keys, list_cover_presentations } from '@server/services/content-attachments.service'
import { parse_story_markdown } from '@shared/content-markdown'
import { has_private_content, redact_private_content } from '@shared/content-private'
import { content_name_key, format_story_ref } from '@shared/content-reference'
import { build_html_diagnostics, html_lint_line } from '@shared/html-lint'
import { has_permission } from '@shared/permissions'
import { settings } from '@shared/settings'
import { sync_resource } from '@shared/types/sync'
import { enqueue_object_retirement } from './object-retirement.repository'
import { lock_title_namespace, record_title_change, replay_locked_references } from './reference-history.service'
import { enqueue_content_refresh } from './sync-outbox.repository'
import { require_workspace_actor } from './workspace-auth.service'
import { active_reservations, ensure_workspace_root } from './workspace.repository'

export interface StoryTransaction {
  connection: Connection
  title: { revision: number, floor: number }
}

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

/** Current story catalog for content:// diagnostics, excluding the edited story. */
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

function format_desc_cover(story: Pick<StoryRow, 'description' | 'cover' | 'cover_label' | 'cover_version'>, presentation?: { url: string, image: ContentStoryAttachment['image'] }) {
  return {
    desc: story.description || null,
    cover: story.cover || null,
    cover_label: story.cover_label || null,
    cover_version: story.cover ? story.cover_version : null,
    // Root-relative object URL for a local-attachment cover; null for external covers.
    cover_url: story.cover ? presentation?.url ?? null : null,
    cover_image: story.cover ? presentation?.image : undefined,
  }
}

/** ETag for a cover pointing at a local attachment; the just-written object's etag wins over the pre-op listing. */
export function cover_version_from(attachments: ContentStoryAttachment[], cover: string, written?: { file_name: string, version: string | null }) {
  if (! cover)
    return null
  if (written && cover === written.file_name)
    return written.version
  return attachments.find(item => content_name_key(item.file_name) === content_name_key(cover))?.version ?? null
}

export async function list_stories() {
  const [stories] = await db.execute<StoryRow[]>(
    'SELECT id, title, label, description, cover, cover_label, cover_version, event_precision, event_dates, created_at, updated_at FROM content_stories ORDER BY updated_at DESC',
  )
  const cover_urls = await list_cover_presentations(stories.flatMap(story => story.cover ? [{ story_id: story.id, file_name: story.cover }] : []))
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
    ... format_desc_cover(story, cover_urls.get(`${story.id}:${story.cover}`)),
  }))
}

// Identifies the permission projection included in representation_version.
// Clients echo base_representation_version; updated_at alone cannot distinguish
// a guest's redacted copy from a privileged full copy.
function story_viewer_key(viewer: AuthUser | null | undefined) {
  return viewer === undefined
    ? 'internal'
    : `${viewer?.id ?? 'anon'}:${has_permission(viewer, 'content_private', 'read')}`
}

/** Hash the viewer's actual representation; hidden source bytes never enter guest hashes. */
function format_story_body(story: StoryRow, viewer: AuthUser | null, presentation: { url: string, image: ContentStoryAttachment['image'] } | undefined, title_revision: number): ContentStoryBody {
  const private_readable = has_permission(viewer, 'content_private', 'read')
  const body = {
    id: story.id, title: story.title, labels: parse_labels(story.label),
    event_precision: story.event_precision, event_dates: parse_event_dates(story.event_dates),
    markdown: private_readable ? story.markdown : redact_private_content(story.markdown),
    has_private: has_private_content(story.markdown), private_readable,
    revision: story.revision, created_at: story.created_at, updated_at: story.updated_at,
    viewer_key: story_viewer_key(viewer), ... format_desc_cover(story, presentation),
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
    const covers = await list_cover_presentations(story.cover ? [{ story_id: id, file_name: story.cover }] : [], connection)
    const body = format_story_body(story, viewer, covers.get(`${id}:${story.cover}`), title.revision)
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

function reference_review_token(story_id: number, markdown: string, body_revision: number | null, baseline: ContentReferenceBaseline, namespace_revision: number, title_revision: number) {
  return createHash('sha256').update(JSON.stringify([story_id, markdown, body_revision, baseline.base_namespace_revision, baseline.base_title_revision, namespace_revision, title_revision])).digest('hex')
}

export async function create_story(created_by: number, markdown: string, can_private: boolean, base_title_revision: number | null = null, confirm_reference_history?: string, transaction?: StoryTransaction) {
  if (! can_private && has_private_content(markdown)) {
    throw new ApiError(403, '内容包含机密内容，你没有机密内容的编辑权限')
  }
  const owned_connection = transaction ? null : await db.getConnection()
  const connection = transaction?.connection ?? owned_connection!
  let story_id: number
  try {
    if (! transaction)
      await connection.beginTransaction()
    const title = transaction?.title ?? await lock_title_namespace(connection, true)
    const baseline = { base_namespace_revision: 0, base_title_revision }
    const replayed = await replay_locked_references(connection, 0, markdown, baseline, title)
    const review_token = reference_review_token(0, markdown, null, baseline, replayed.namespace_revision, title.revision)
    if (replayed.baseline_unavailable.title && confirm_reference_history !== review_token)
      throw new ReferenceSafetyError('引用历史不可用，请核对当前引用后再保存', 'REF_HISTORY_UNAVAILABLE', review_token)
    markdown = replayed.markdown
    const meta = parse_or_throw(markdown, await existing_story_titles(0, connection))
    await ensure_unique_title(meta.title, 0, connection)
    const [result] = await connection.execute<ResultSetHeader>(
      'INSERT INTO content_stories (title, label, description, cover, cover_label, event_precision, event_dates, markdown, created_by) VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)',
      [meta.title, meta.labels.join(' '), meta.desc ?? '', meta.cover ?? '', meta.cover_label ?? '', meta.event_precision, story_event_dates(meta), markdown, created_by],
    )
    story_id = Number(result.insertId)
    await ensure_workspace_root(connection, story_id)
    // Creation advances catalog freshness without remapping an existing title.
    await record_title_change(connection, title.revision, { node_id: story_id, from: null, to: format_story_ref(meta.title) })
    await enqueue_content_refresh(connection, [sync_resource('content_stories', 'all'), sync_resource('content_titles', 'all')])
    if (! transaction)
      await connection.commit()
  }
  catch (error) {
    if (! transaction)
      await connection.rollback()
    throw error
  }
  finally {
    owned_connection?.release()
  }

  return story_id
}

/** Save under title then scope locks; mechanical changes never consume body revisions. */
export async function update_story(id: number, markdown: string, base_revision: number, can_private: boolean, baseline: ContentReferenceBaseline = { base_namespace_revision: null, base_title_revision: null }, confirm_reference_history?: string, transaction?: StoryTransaction) {
  const owned_connection = transaction ? null : await db.getConnection()
  const connection = transaction?.connection ?? owned_connection!
  const rewritten_referrers: number[] = []
  let result
  let title_changed = false
  let exclusive_title_lock = Boolean(transaction)
  const submitted_markdown = markdown
  try {
    while (true) {
      markdown = submitted_markdown
      if (! transaction)
        await connection.beginTransaction()
      const title_namespace = transaction?.title ?? await lock_title_namespace(connection, exclusive_title_lock)
      const [rows] = await connection.execute<StoryRow[]>('SELECT * FROM content_stories WHERE id = ? FOR UPDATE', [id])
      const story = rows[0]
      if (! story)
        throw new ApiError(404, '档案不存在或已被删除')
      if (story.revision !== base_revision)
        throw new ApiError(409, '档案已被其他编辑更新，请先处理版本冲突')
      if (! can_private && (has_private_content(markdown) || has_private_content(story.markdown)))
        throw new ApiError(403, '内容包含机密内容，你没有机密内容的编辑权限')
      const replayed = await replay_locked_references(connection, id, markdown, baseline, title_namespace)
      const review_token = reference_review_token(id, submitted_markdown, base_revision, baseline, replayed.namespace_revision, title_namespace.revision)
      if ((replayed.baseline_unavailable.namespace || replayed.baseline_unavailable.title) && confirm_reference_history !== review_token)
        throw new ReferenceSafetyError('引用历史不可用，请核对当前引用后再保存', 'REF_HISTORY_UNAVAILABLE', review_token)
      markdown = replayed.markdown
      const meta = parse_or_throw(markdown, await existing_story_titles(id, connection))
      // Ordinary saves share the title lock. A rename retries from scratch with
      // an exclusive lock, never upgrading a shared lock while holding scope rows.
      if (story.title !== meta.title && ! exclusive_title_lock) {
        if (! transaction)
          await connection.rollback()
        exclusive_title_lock = true
        continue
      }
      await ensure_unique_title(meta.title, id, connection)
      const [attachments] = await connection.execute<RowDataPacket[]>('SELECT file_name, version FROM content_story_attachments WHERE story_id = ? AND is_folder = 0', [id])
      await connection.execute(
        'UPDATE content_stories SET title = ?, label = ?, description = ?, cover = ?, cover_label = ?, cover_version = ?, event_precision = ?, event_dates = CAST(? AS JSON), markdown = ?, revision = revision + 1 WHERE id = ?',
        [meta.title, meta.labels.join(' '), meta.desc ?? '', meta.cover ?? '', meta.cover_label ?? '', attachments.find(row => content_name_key(String(row.file_name)) === content_name_key(meta.cover ?? ''))?.version ?? null, meta.event_precision, story_event_dates(meta), markdown, id],
      )
      let title_revision = title_namespace.revision
      if (story.title !== meta.title) {
        title_changed = true
        const rewritten = await record_title_change(connection, title_revision, { node_id: id, from: format_story_ref(story.title), to: format_story_ref(meta.title) })
        title_revision ++
        rewritten_referrers.push(... rewritten.map(row => row.id))
        markdown = rewritten.find(row => row.id === id)?.markdown ?? markdown
      }
      result = { markdown, revision: base_revision + 1, namespace_revision: replayed.namespace_revision, title_revision, baseline_unavailable: replayed.baseline_unavailable, diagnostics: replayed.diagnostics }
      await enqueue_content_refresh(connection, [
        sync_resource('content_stories', 'all'), sync_resource('content_story', id),
        ... (title_changed ? [sync_resource('content_titles', 'all')] : []),
        ... rewritten_referrers.map(referrer_id => sync_resource('content_story', referrer_id)),
      ])
      if (! transaction)
        await connection.commit()
      break
    }
  }
  catch (error) {
    if (! transaction)
      await connection.rollback()
    throw error
  }
  finally {
    owned_connection?.release()
  }
  return result!
}

/** Deletes the story row and its attachment directory. */
export async function delete_story(id: number, actor_id: number, transaction?: StoryTransaction) {
  const owned_connection = transaction ? null : await db.getConnection()
  const connection = transaction?.connection ?? owned_connection!
  let object_keys: Awaited<ReturnType<typeof get_story_object_keys>> = []
  try {
    if (! transaction)
      await connection.beginTransaction()
    const titles = transaction?.title ?? await lock_title_namespace(connection, true)
    const [stories] = await connection.execute<StoryRow[]>('SELECT * FROM content_stories WHERE id = ? FOR UPDATE', [id])
    if (! stories[0])
      throw new ApiError(404, '档案不存在或已被删除')
    const [private_files] = await connection.execute<RowDataPacket[]>('SELECT id FROM content_story_attachments WHERE story_id = ? AND is_private = 1 LIMIT 1', [id])
    await require_workspace_actor(actor_id, has_private_content(stories[0].markdown) || private_files.length > 0, connection)
    const { rows: active, expired_sessions } = await active_reservations(connection, id)
    if (active.length)
      throw new ApiError(409, '档案还有未完成的上传，请先取消或完成')
    object_keys = await get_story_object_keys(id, connection)
    if (object_keys.some(object => object.provider !== 'aliyun'))
      throw new ApiError(503, '档案附件尚未完成迁移')
    for (const object of object_keys)
      await enqueue_object_retirement(connection, object.key, id, 'story-delete')
    await record_title_change(connection, titles.revision, { node_id: id, from: format_story_ref(stories[0].title), to: null })
    await delete_story_attachment_rows(id, connection)
    await connection.execute('DELETE FROM content_stories WHERE id = ?', [id])
    await connection.execute('DELETE FROM content_reference_journals WHERE scope_id = ?', [id])
    await enqueue_content_refresh(connection, [
      sync_resource('content_stories', 'all'), sync_resource('content_story', id),
      sync_resource('content_titles', 'all'), sync_resource('content_attachments', id),
      ... (expired_sessions.length ? [sync_resource('content_uploads', id), ... expired_sessions.map(session => sync_resource('content_upload_session', session))] : []),
    ])
    if (! transaction)
      await connection.commit()
  }
  catch (error) {
    if (! transaction)
      await connection.rollback()
    throw error
  }
  finally {
    owned_connection?.release()
  }
}
