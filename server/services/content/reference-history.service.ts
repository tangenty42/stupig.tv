import type { ContentReferenceBaseline, ContentReferenceChange, ContentReferenceRewriteResult } from '@shared/types/content-reference'
import type { Connection, RowDataPacket } from 'mysql2/promise'
import type { WorkspaceChange } from './workspace-change'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { attachment_cover_url } from '@server/services/content-attachments.service'
import { rewrite_attachment_path } from '@shared/content-markdown'
import { content_name_key, format_attachment_ref, parse_content_ref } from '@shared/content-reference'
import { replay_content_references, replay_reference_destination } from '@shared/content-reference-replay'
import { rewrite_cloud_drafts } from './draft.repository'
import { append_reference_journal, reference_journals_since } from './reference-journal.repository'

interface NamespaceRow extends RowDataPacket {
  revision: number
  revision_floor: number
}
interface NamespaceNode extends RowDataPacket {
  id: number
  file_name: string
  is_folder: number
  object_key: string | null
  version: string
  is_private: number
  storage_bucket: 'public' | 'private'
  storage_provider?: 'legacy' | 'aliyun'
  oss_version_id?: string | null
  node_revision?: number
  encryption_key?: string | null
}

export async function get_title_reference_version() {
  const [rows] = await db.execute<NamespaceRow[]>('SELECT revision, revision_floor FROM content_title_namespace WHERE id = 1')
  if (! rows[0])
    throw new ApiError(503, '引用历史尚未初始化，请先执行数据库迁移')
  return { title_revision: Number(rows[0].revision) }
}

/** Always acquire this before story/scope row locks in title/save operations. */
export async function lock_title_namespace(connection: Connection, exclusive = false) {
  const [rows] = await connection.execute<NamespaceRow[]>(
    `SELECT revision, revision_floor FROM content_title_namespace WHERE id = 1 FOR ${exclusive ? 'UPDATE' : 'SHARE'}`,
  )
  if (! rows[0])
    throw new ApiError(503, '引用历史尚未初始化，请先执行数据库迁移')
  return { revision: Number(rows[0].revision), floor: Number(rows[0].revision_floor) }
}

export async function begin_namespace_change(connection: Connection, story_id: number) {
  const [stories] = await connection.execute<RowDataPacket[]>(
    'SELECT namespace_revision FROM content_stories WHERE id = ? FOR UPDATE', [story_id],
  )
  if (! stories[0])
    throw new ApiError(404, '档案不存在或已被删除')
  const [nodes] = await connection.execute<NamespaceNode[]>(
    'SELECT id, file_name, is_folder, object_key, version, is_private, storage_bucket, storage_provider, oss_version_id, node_revision, encryption_key, redacted_avif_key, redacted_jpeg_key, redacted_revision FROM content_story_attachments WHERE story_id = ? ORDER BY id FOR UPDATE', [story_id],
  )
  return { story_id, revision: Number(stories[0].namespace_revision), nodes }
}

/** Snapshot deltas omit temporary paths; a whole batch is one simultaneous step. */
export async function finish_namespace_change(connection: Connection, before: Awaited<ReturnType<typeof begin_namespace_change>>, folder_moves: { from: string, to: string }[] = []): Promise<WorkspaceChange> {
  const [nodes] = await connection.execute<NamespaceNode[]>(
    'SELECT id, file_name, is_folder, object_key, version, is_private, storage_bucket, storage_provider, oss_version_id, node_revision, encryption_key, redacted_avif_key, redacted_jpeg_key, redacted_revision FROM content_story_attachments WHERE story_id = ? ORDER BY id FOR UPDATE', [before.story_id],
  )
  const current = new Map(nodes.map(node => [Number(node.id), node]))
  const previous_ids = new Set(before.nodes.map(node => Number(node.id)))
  const changes: ContentReferenceChange[] = []
  let changed = nodes.length !== before.nodes.length
  for (const old of before.nodes) {
    const node = current.get(Number(old.id))
    if (! node || node.file_name !== old.file_name) {
      // Legacy explicit folder merges absorb folder rows. Their references
      // still follow the accepted move instead of becoming deletion warnings.
      const merged_path = old.is_folder ? rewrite_attachment_path(old.file_name, { attachments: folder_moves.map(move => ({ ... move, is_folder: true })) }) : old.file_name
      const next = node?.file_name ?? (merged_path !== old.file_name ? merged_path : null)
      changes.push({ node_id: Number(old.id), from: format_attachment_ref(old.file_name), to: next === null ? null : format_attachment_ref(next), is_folder: Boolean(old.is_folder) })
      changed = true
    }
    if (node && (node.object_key !== old.object_key || node.version !== old.version || node.is_private !== old.is_private || node.storage_bucket !== old.storage_bucket || node.storage_provider !== old.storage_provider || node.oss_version_id !== old.oss_version_id || node.node_revision !== old.node_revision || node.encryption_key !== old.encryption_key))
      changed = true
  }
  for (const node of nodes) {
    if (node.file_name && ! previous_ids.has(Number(node.id)))
      changes.push({ node_id: Number(node.id), from: null, to: format_attachment_ref(node.file_name), is_folder: Boolean(node.is_folder) })
  }
  for (const move of folder_moves) {
    if (! changes.some(change => change.from === format_attachment_ref(move.from) && change.is_folder))
      changes.push({ node_id: Number(before.nodes.find(node => node.file_name === move.from)?.id ?? 0), from: format_attachment_ref(move.from), to: format_attachment_ref(move.to), is_folder: true })
  }
  if (! changed)
    return {}
  const journal = { revision: before.revision + 1, changes }
  await append_reference_journal(connection, before.story_id, journal.revision, changes)
  const [stories] = await connection.execute<RowDataPacket[]>('SELECT markdown, cover, cover_version FROM content_stories WHERE id = ? FOR UPDATE', [before.story_id])
  const story = stories[0]!
  const markdown = replay_content_references(String(story.markdown), {
    attachments: [journal], titles: [], attachment_targets: nodes.map(node => ({ id: Number(node.id), name: node.file_name })), title_targets: [],
  }).markdown
  const cover_ref = parse_content_ref(replay_reference_destination(format_attachment_ref(String(story.cover ?? '')), [journal]))
  const cover = cover_ref && 'path' in cover_ref ? cover_ref.path : String(story.cover ?? '')
  const cover_node = nodes.find(node => ! node.is_folder && content_name_key(node.file_name) === content_name_key(cover))
  const cover_version = cover_node?.version ?? null
  const cover_key = cover_node?.object_key ?? null
  const old_cover_key = before.nodes.find(node => ! node.is_folder && content_name_key(node.file_name) === content_name_key(String(story.cover)))?.object_key ?? null
  const body_changed = markdown !== story.markdown || cover !== story.cover || cover_version !== story.cover_version || cover_key !== old_cover_key
  // URL identity and visibility also affect list/detail covers, without necessarily
  // rewriting stored Markdown or changing the existing updated_at policy.
  const cover_changed = attachment_cover_url(String(story.cover ?? ''), before.nodes) !== attachment_cover_url(cover, nodes)
  if (body_changed)
    await connection.execute('UPDATE content_stories SET markdown = ?, cover = ?, cover_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [markdown, cover, cover_version, before.story_id])
  await connection.execute('UPDATE content_stories SET namespace_revision = namespace_revision + 1, updated_at = updated_at WHERE id = ?', [before.story_id])
  await rewrite_cloud_drafts(connection, before.story_id, journal)
  // Saved reference rewrites touch updated_at, which is displayed and sorts the list.
  return { attachments: true, ... (body_changed || cover_changed ? { story: true, stories: true } : {}) }
}

export async function with_namespace_change<T>(story_id: number, mutate: (connection: Connection) => Promise<T>) {
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    const before = await begin_namespace_change(connection, story_id)
    const result = await mutate(connection)
    await finish_namespace_change(connection, before)
    await connection.commit()
    return result
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally {
    connection.release()
  }
}

export async function record_title_change(connection: Connection, revision: number, change?: ContentReferenceChange) {
  await connection.execute('UPDATE content_title_namespace SET revision = revision + 1 WHERE id = 1')
  const changes = change ? [change] : []
  await append_reference_journal(connection, 0, revision + 1, changes)
  const rewritten: { id: number, markdown: string }[] = []
  if (! change?.from || ! change.to) {
    await rewrite_cloud_drafts(connection, 0, { revision: revision + 1, changes })
    return rewritten
  }
  // Main was current at the locked previous revision. Scan all sources: a
  // reference may have been saved before its target existed.
  const [stories] = await connection.execute<RowDataPacket[]>('SELECT id, markdown FROM content_stories ORDER BY id FOR UPDATE')
  for (const story of stories) {
    const markdown = replay_content_references(String(story.markdown), {
      attachments: [], titles: [{ revision: revision + 1, changes }], attachment_targets: [], title_targets: [],
    }).markdown
    if (markdown !== story.markdown) {
      await connection.execute('UPDATE content_stories SET markdown = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [markdown, story.id])
      rewritten.push({ id: Number(story.id), markdown })
    }
  }
  await rewrite_cloud_drafts(connection, 0, { revision: revision + 1, changes })
  return rewritten
}

/** Caller holds title lock, then scope lock, throughout replay and (optional) save. */
export async function replay_locked_references(connection: Connection, story_id: number, markdown: string, baseline: ContentReferenceBaseline, title: { revision: number, floor: number }): Promise<ContentReferenceRewriteResult> {
  const [stories] = story_id === 0
    ? [[{ namespace_revision: 0, namespace_floor: 0 }]]
    : await connection.execute<RowDataPacket[]>('SELECT namespace_revision, namespace_floor FROM content_stories WHERE id = ? FOR UPDATE', [story_id])
  if (! stories[0])
    throw new ApiError(404, '档案不存在或已被删除')
  const namespace_revision = Number(stories[0].namespace_revision)
  const attachments = story_id === 0
    ? { unavailable: false, journals: [] }
    : await reference_journals_since(connection, story_id, baseline.base_namespace_revision, namespace_revision, Number(stories[0].namespace_floor))
  const titles = await reference_journals_since(connection, 0, baseline.base_title_revision, title.revision, title.floor)
  const [nodes] = story_id === 0 ? [[]] : await connection.execute<RowDataPacket[]>('SELECT id, file_name FROM content_story_attachments WHERE story_id = ?', [story_id])
  const [catalog] = await connection.execute<RowDataPacket[]>('SELECT id, title FROM content_stories')
  const replayed = replay_content_references(markdown, {
    attachments: attachments.journals, titles: titles.journals,
    attachment_targets: nodes.map(row => ({ id: Number(row.id), name: String(row.file_name) })),
    title_targets: catalog.map(row => ({ id: Number(row.id), name: String(row.title) })),
  })
  return {
    markdown: replayed.markdown,
    changes: replayed.changes,
    diagnostics: replayed.diagnostics,
    base_namespace_revision: attachments.unavailable ? baseline.base_namespace_revision : namespace_revision,
    base_title_revision: titles.unavailable ? baseline.base_title_revision : title.revision,
    namespace_revision, title_revision: title.revision,
    baseline_unavailable: { namespace: attachments.unavailable, title: titles.unavailable },
  }
}

export async function rewrite_draft_references(story_id: number, markdown: string, baseline: ContentReferenceBaseline, can_private: boolean) {
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    const title = await lock_title_namespace(connection)
    // Reuse save's private guard: a redacted viewer must not operate on hidden bytes.
    const [stories] = story_id === 0
      ? [[{ markdown: '' }]]
      : await connection.execute<RowDataPacket[]>('SELECT markdown FROM content_stories WHERE id = ? FOR UPDATE', [story_id])
    if (! stories[0])
      throw new ApiError(404, '档案不存在或已被删除')
    if (! can_private) {
      const { has_private_content } = await import('@shared/content-private')
      if (has_private_content(markdown) || has_private_content(String(stories[0].markdown)))
        throw new ApiError(403, '你没有机密内容的编辑权限')
    }
    const result = await replay_locked_references(connection, story_id, markdown, baseline, title)
    await connection.commit()
    return result
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally {
    connection.release()
  }
}
