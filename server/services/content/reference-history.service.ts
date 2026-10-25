import type { ContentReferenceBaseline, ContentReferenceChange, ContentReferenceJournal, ContentReferenceRewriteResult } from '@shared/types/content-reference'
import type { Connection, RowDataPacket } from 'mysql2/promise'
import type { WorkspaceChange } from './workspace-change'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { attachment_cover_url } from '@server/services/content-attachments.service'
import { rewrite_attachment_path, rewrite_content_refs } from '@shared/content-markdown'
import { replay_content_references } from '@shared/content-reference-replay'
import { settings } from '@shared/settings'

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
interface JournalRow extends RowDataPacket {
  revision: number
  changes: ContentReferenceChange[] | string
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
  const changes: ContentReferenceChange[] = []
  let changed = nodes.length !== before.nodes.length
  for (const old of before.nodes) {
    const node = current.get(Number(old.id))
    if (! node || node.file_name !== old.file_name) {
      // Legacy explicit folder merges absorb folder rows. Their references
      // still follow the accepted move instead of becoming deletion warnings.
      const merged_path = old.is_folder ? rewrite_attachment_path(old.file_name, { attachments: folder_moves.map(move => ({ ... move, is_folder: true })) }) : old.file_name
      changes.push({ node_id: Number(old.id), from: old.file_name, to: node?.file_name ?? (merged_path !== old.file_name ? merged_path : null), is_folder: Boolean(old.is_folder) })
      changed = true
    }
    if (node && (node.object_key !== old.object_key || node.version !== old.version || node.is_private !== old.is_private || node.storage_bucket !== old.storage_bucket || node.storage_provider !== old.storage_provider || node.oss_version_id !== old.oss_version_id || node.node_revision !== old.node_revision || node.encryption_key !== old.encryption_key))
      changed = true
  }
  for (const move of folder_moves) {
    if (! changes.some(change => change.from === move.from && change.is_folder))
      changes.push({ node_id: Number(before.nodes.find(node => node.file_name === move.from)?.id ?? 0), from: move.from, to: move.to, is_folder: true })
  }
  if (! changed)
    return {}
  const step = { attachments: changes.flatMap(change => change.to === null ? [] : [{ from: change.from, to: change.to, is_folder: change.is_folder }]) }
  const [stories] = await connection.execute<RowDataPacket[]>('SELECT markdown, cover, cover_version FROM content_stories WHERE id = ? FOR UPDATE', [before.story_id])
  const story = stories[0]!
  const markdown = rewrite_content_refs(String(story.markdown), [step])
  const cover = rewrite_attachment_path(String(story.cover ?? ''), step)
  const cover_version = nodes.find(node => ! node.is_folder && node.file_name === cover)?.version ?? null
  const cover_key = nodes.find(node => ! node.is_folder && node.file_name === cover)?.object_key ?? null
  const old_cover_key = before.nodes.find(node => ! node.is_folder && node.file_name === story.cover)?.object_key ?? null
  const body_changed = markdown !== story.markdown || cover !== story.cover || cover_version !== story.cover_version || cover_key !== old_cover_key
  // URL identity and visibility also affect list/detail covers, without necessarily
  // rewriting stored Markdown or changing the existing updated_at policy.
  const cover_changed = attachment_cover_url(String(story.cover ?? ''), before.nodes) !== attachment_cover_url(cover, nodes)
  if (body_changed)
    await connection.execute('UPDATE content_stories SET markdown = ?, cover = ?, cover_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [markdown, cover, cover_version, before.story_id])
  await connection.execute('UPDATE content_stories SET namespace_revision = namespace_revision + 1, updated_at = updated_at WHERE id = ?', [before.story_id])
  await connection.execute('INSERT INTO content_reference_journals (scope_id, revision, changes) VALUES (?, ?, CAST(? AS JSON))', [before.story_id, before.revision + 1, JSON.stringify(changes)])
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
  if (change)
    await connection.execute('INSERT INTO content_reference_journals (scope_id, revision, changes) VALUES (0, ?, CAST(? AS JSON))', [revision + 1, JSON.stringify([change])])
}

async function journal_since(connection: Connection, scope_id: number, baseline: number | null, current: number, floor: number) {
  const unavailable = baseline === null || baseline < floor || baseline > current
  if (unavailable)
    return { unavailable, journals: [] as ContentReferenceJournal[] }
  const [rows] = await connection.execute<JournalRow[]>('SELECT revision, changes FROM content_reference_journals WHERE scope_id = ? AND revision > ? ORDER BY revision', [scope_id, baseline])
  return { unavailable, journals: rows.map(row => ({ revision: Number(row.revision), changes: typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes })) }
}

/** Caller holds title lock, then scope lock, throughout replay and (optional) save. */
export async function replay_locked_references(connection: Connection, story_id: number, markdown: string, baseline: ContentReferenceBaseline, title: { revision: number, floor: number }): Promise<ContentReferenceRewriteResult> {
  const [stories] = await connection.execute<RowDataPacket[]>('SELECT namespace_revision, namespace_floor FROM content_stories WHERE id = ? FOR UPDATE', [story_id])
  if (! stories[0])
    throw new ApiError(404, '档案不存在或已被删除')
  const namespace_revision = Number(stories[0].namespace_revision)
  const attachments = await journal_since(connection, story_id, baseline.base_namespace_revision, namespace_revision, Number(stories[0].namespace_floor))
  const titles = await journal_since(connection, 0, baseline.base_title_revision, title.revision, title.floor)
  const [nodes] = await connection.execute<RowDataPacket[]>('SELECT id, file_name FROM content_story_attachments WHERE story_id = ?', [story_id])
  const [catalog] = await connection.execute<RowDataPacket[]>('SELECT id, title FROM content_stories')
  const replayed = replay_content_references(markdown, {
    attachments: attachments.journals, titles: titles.journals,
    attachment_targets: nodes.map(row => ({ id: Number(row.id), name: String(row.file_name) })),
    title_targets: catalog.map(row => ({ id: Number(row.id), name: String(row.title) })),
  })
  return {
    markdown: replayed.deleted_reference ? markdown : replayed.markdown,
    changes: replayed.deleted_reference ? [] : replayed.changes,
    diagnostics: replayed.diagnostics,
    ... (replayed.deleted_reference ? { confirmation: { markdown: replayed.markdown, changes: replayed.changes } } : {}),
    // A dangling deleted reference must retain its tombstone until reviewed or
    // removed, otherwise a later same-name creation would silently retarget it.
    base_namespace_revision: attachments.unavailable || replayed.deleted_reference ? baseline.base_namespace_revision : namespace_revision,
    base_title_revision: titles.unavailable || replayed.deleted_reference ? baseline.base_title_revision : title.revision,
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
    const [stories] = await connection.execute<RowDataPacket[]>('SELECT markdown FROM content_stories WHERE id = ? FOR UPDATE', [story_id])
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

/** Floors advance in the same transaction as pruning, so old baselines never guess. */
export async function prune_reference_journals() {
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    await lock_title_namespace(connection, true)
    const [expired] = await connection.execute<RowDataPacket[]>('SELECT scope_id, MAX(revision) AS revision FROM content_reference_journals WHERE created_at < TIMESTAMPADD(DAY, -?, CURRENT_TIMESTAMP) GROUP BY scope_id ORDER BY scope_id', [settings.app.content.reference.journalRetentionDays])
    for (const row of expired) {
      if (Number(row.scope_id) === 0)
        await connection.execute('UPDATE content_title_namespace SET revision_floor = GREATEST(revision_floor, ?) WHERE id = 1', [row.revision])
      else
        await connection.execute('UPDATE content_stories SET namespace_floor = GREATEST(namespace_floor, ?), updated_at = updated_at WHERE id = ?', [row.revision, row.scope_id])
      await connection.execute('DELETE FROM content_reference_journals WHERE scope_id = ? AND revision <= ?', [row.scope_id, row.revision])
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
}
