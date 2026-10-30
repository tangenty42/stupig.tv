import type { AuthUser } from '@server/types/auth'
import type { ContentDraftSnapshot, ContentDraftSummary, DraftCommand, DraftLease, DraftReceipt, DraftResult } from '@shared/types/content-draft'
import type { Connection, RowDataPacket } from 'mysql2/promise'
import type { DraftRow } from './draft.repository'
import { createHash, randomBytes } from 'node:crypto'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { wire_resource } from '@server/lib/sync-channel'
import { draft_lease_ms } from '@shared/content-draft'
import { story_markdown_template } from '@shared/content-markdown'
import { settings } from '@shared/settings'
import { require_draft_actor } from './draft-auth.service'
import { draft_title } from './draft-summary'
import { database_now, draft_select } from './draft.repository'
import { lock_title_namespace, replay_locked_references } from './reference-history.service'
import { create_story, delete_story, update_story } from './story.service'
import { enqueue_content_refresh } from './sync-outbox.repository'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function same_holder(row: DraftRow, actor: AuthUser, lease?: DraftLease) {
  return !! lease && Number(row.lease_actor_id) === actor.id && Number(row.lease_session_id) === actor.session_id
    && row.lease_page_id === lease.page_id && Number(row.lease_epoch) === lease.epoch && row.lease_token_hash === hash(lease.token)
}

async function snapshot(connection: Connection, row: DraftRow, actor: AuthUser, lease?: DraftLease): Promise<ContentDraftSnapshot> {
  const now = await database_now(connection)
  const remaining = Math.max(0, Number(row.until_ms ?? 0) - now)
  return {
    id: row.id, story_id: row.story_id === null ? null : Number(row.story_id), markdown: row.markdown,
    draft_revision: Number(row.draft_revision), namespace_revision: Number(row.namespace_revision), title_revision: Number(row.title_revision),
    published_main_revision: row.published_main_revision === null ? null : Number(row.published_main_revision),
    unpublished_changes: Boolean(row.unpublished_changes),
    lease_epoch: Number(row.lease_epoch), occupied: remaining > 0, owned: remaining > 0 && same_holder(row, actor, lease),
    lease_remaining_ms: remaining, updated_at: new Date(row.updated_at).toISOString(), channel: wire_resource(`content_draft:${row.id}`),
  }
}

async function read_row(connection: Connection, id: string, read_only = false) {
  const [rows] = await connection.execute<DraftRow[]>(`${draft_select} WHERE d.id = ? FOR ${read_only ? 'SHARE' : 'UPDATE'}`, [id])
  if (! rows[0])
    throw new ApiError(404, '云端草稿不存在或已被删除')
  return rows[0]
}

/** Deadlock retries retain the exact command identity and payload. */
async function transaction<T>(action: (connection: Connection) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt ++) {
    const connection = await db.getConnection()
    try {
      await connection.beginTransaction()
      const result = await action(connection)
      await connection.commit()
      return result
    }
    catch (error) {
      await connection.rollback()
      if (attempt < 2 && (error as { code?: string }).code === 'ER_LOCK_DEADLOCK')
        continue
      throw error
    }
    finally { connection.release() }
  }
}

async function lock_draft(connection: Connection, id: string, exclusive: boolean, lightweight = false, read_only = false) {
  // The id->story binding is immutable except first publication; the title lock
  // stabilizes that transition before deciding which content rows to lock.
  const title = lightweight ? null : await lock_title_namespace(connection, exclusive)
  const [bindings] = await connection.execute<RowDataPacket[]>('SELECT story_id FROM content_story_drafts WHERE id = ?', [id])
  if (! bindings[0])
    throw new ApiError(404, '云端草稿不存在或已被删除')
  const story_id = bindings[0].story_id
  if (! lightweight && story_id !== null)
    await connection.execute(`SELECT id FROM content_stories WHERE id = ? FOR ${read_only ? 'SHARE' : 'UPDATE'}`, [story_id])
  return { row: await read_row(connection, id, read_only), title }
}

export async function get_draft(actor: AuthUser, input: { id?: string, story_id?: number, lease?: DraftLease }): Promise<DraftResult> {
  return transaction(async (connection) => {
    let id = input.id
    if (! id) {
      await lock_title_namespace(connection)
      const [rows] = await connection.execute<RowDataPacket[]>('SELECT id FROM content_story_drafts WHERE story_id = ?', [input.story_id ?? null])
      id = rows[0]?.id
    }
    if (! id)
      throw new ApiError(404, '云端草稿不存在，请先核对数据库迁移')
    const { row } = await lock_draft(connection, id, false, false, true)
    await require_draft_actor(connection, actor)
    return { snapshot: await snapshot(connection, row, actor, input.lease) }
  })
}

export async function list_drafts(actor: AuthUser, after = '', limit = 30) {
  return transaction(async (connection) => {
    await require_draft_actor(connection, actor)
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id, story_id, LEFT(markdown, 4096) AS prefix, CHAR_LENGTH(markdown) <= 4096 AS complete, updated_at FROM content_story_drafts WHERE (story_id IS NULL OR unpublished_changes = 1) AND id > ? ORDER BY id LIMIT ${limit + 1}`, [after])
    const items: ContentDraftSummary[] = rows.slice(0, limit).map(row => ({ id: String(row.id), story_id: row.story_id === null ? null : Number(row.story_id), title: draft_title(String(row.prefix), Boolean(row.complete)), updated_at: new Date(row.updated_at).toISOString() }))
    return { items, next: rows.length > limit ? String(rows[limit - 1]!.id) : null, channel: wire_resource('content_drafts:all') }
  })
}

export async function create_draft(actor: AuthUser, request_id: string): Promise<DraftResult> {
  return transaction(async (connection) => {
    const title = await lock_title_namespace(connection)
    await require_draft_actor(connection, actor)
    const id = randomBytes(16).toString('hex')
    const markdown = story_markdown_template(new Date().toISOString().slice(0, 10).replaceAll('-', '/'))
    await connection.execute(`INSERT INTO content_story_drafts (id, create_request_id, markdown, title_revision, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id`, [id, request_id, markdown, title.revision, actor.id, actor.id])
    const [rows] = await connection.execute<DraftRow[]>(`${draft_select} WHERE d.created_by = ? AND d.create_request_id = ? FOR UPDATE`, [actor.id, request_id])
    const row = rows[0]!
    if (row.id === id)
      await enqueue_content_refresh(connection, ['content_drafts:all'])
    return { snapshot: await snapshot(connection, row, actor) }
  })
}

export async function acquire_draft(actor: AuthUser, input: { id: string, expected_epoch: number, page_id: string, token: string }): Promise<DraftResult> {
  return transaction(async (connection) => {
    const { row } = await lock_draft(connection, input.id, false)
    await require_draft_actor(connection, actor)
    const now = await database_now(connection)
    const candidate = { page_id: input.page_id, token: input.token, epoch: input.expected_epoch + 1 }
    if (Number(row.until_ms ?? 0) > now || Number(row.lease_epoch) !== input.expected_epoch)
      return { snapshot: await snapshot(connection, row, actor, candidate) }
    await connection.execute(`UPDATE content_story_drafts SET lease_epoch = lease_epoch + 1, lease_actor_id = ?, lease_session_id = ?, lease_page_id = ?, lease_token_hash = ?,
      lease_until = TIMESTAMPADD(MICROSECOND, ?, CURRENT_TIMESTAMP(3)), last_command_seq = 0, last_command_hash = NULL, last_command_result = NULL WHERE id = ?`,
    [actor.id, actor.session_id, input.page_id, hash(input.token), draft_lease_ms() * 1000, input.id])
    await enqueue_content_refresh(connection, [`content_draft:${input.id}`])
    return { snapshot: await snapshot(connection, await read_row(connection, input.id), actor, candidate) }
  })
}

export async function command_draft(actor: AuthUser, input: DraftCommand): Promise<DraftResult> {
  return transaction(async (connection) => {
    const lightweight = input.kind === 'sync' && input.markdown === undefined
    const { row, title } = await lock_draft(connection, input.id, ['publish', 'delete', 'reset'].includes(input.kind), lightweight)
    await require_draft_actor(connection, actor)
    const fingerprint = hash(JSON.stringify(input))
    const holder = same_holder(row, actor, input.lease)
    const reply = async (receipt: DraftReceipt) => ({ receipt, snapshot: await snapshot(connection, await read_row(connection, input.id), actor, input.lease) })
    // A released/expired holder may learn its last result, never renew from it.
    if (holder && Number(row.last_command_seq) === input.seq && row.last_command_hash === fingerprint && row.last_command_result) {
      const receipt = typeof row.last_command_result === 'string' ? JSON.parse(row.last_command_result) : row.last_command_result
      return reply(receipt as DraftReceipt)
    }
    if (! holder || Number(row.until_ms ?? 0) <= await database_now(connection))
      return reply({ seq: input.seq, kind: input.kind, ok: false, error: 'lease_lost', message: '编辑权已变更，请重新连接' })
    if (input.seq !== Number(row.last_command_seq) + 1)
      return reply({ seq: input.seq, kind: input.kind, ok: false, error: 'command_order', message: '命令顺序已变化，请重新核对云端草稿' })
    let receipt: DraftReceipt = { seq: input.seq, kind: input.kind, ok: true, story_id: row.story_id }
    await connection.query('SAVEPOINT draft_effects')
    try {
      if (input.markdown !== undefined) {
        if (Buffer.byteLength(input.markdown, 'utf8') > settings.app.content.story.markdownMaxBytes)
          throw new ApiError(413, '正文超过大小限制')
        const replay = await replay_locked_references(connection, Number(row.story_id ?? 0), input.markdown, input, title!)
        const review = hash(JSON.stringify([row.id, input.lease.epoch, input.markdown, input.base_namespace_revision, input.base_title_revision, replay.namespace_revision, replay.title_revision]))
        if ((replay.baseline_unavailable.namespace || replay.baseline_unavailable.title) && input.confirm_reference_history !== review) {
          receipt = { ... receipt, ok: false, error: 'reference_review_required', message: '引用历史不可用，请核对后继续保存', review_token: review }
        }
        else {
          await connection.execute(`UPDATE content_story_drafts SET markdown = ?, namespace_revision = ?, title_revision = ?, draft_revision = draft_revision + 1,
            updated_by = ?, updated_at = CURRENT_TIMESTAMP(3), unpublished_changes = NOT EXISTS (SELECT 1 FROM content_stories s WHERE s.id = content_story_drafts.story_id AND BINARY s.markdown = BINARY ?) WHERE id = ?`, [replay.markdown, replay.namespace_revision, replay.title_revision, actor.id, replay.markdown, input.id])
          await enqueue_content_refresh(connection, [`content_draft:${input.id}`, 'content_drafts:all'])
        }
      }
      if (receipt.ok && ['publish', 'reset'].includes(input.kind) && input.expected_revision !== Number(row.draft_revision))
        receipt = { ... receipt, ok: false, error: 'snapshot_changed', message: '云端草稿已变化，请重新核对后操作' }
      if (receipt.ok && input.kind === 'publish') {
        if (! row.story_id) {
          const story_id = await create_story(actor.id, row.markdown, true, row.title_revision, undefined, { connection, title: title! })
          await connection.execute('UPDATE content_story_drafts SET story_id = ?, namespace_revision = 0, published_main_revision = 1, unpublished_changes = 0, draft_revision = draft_revision + 1 WHERE id = ?', [story_id, input.id])
          receipt = { ... receipt, story_id, main_revision: 1 }
        }
        else {
          const [mains] = await connection.execute<RowDataPacket[]>('SELECT revision FROM content_stories WHERE id = ? FOR UPDATE', [row.story_id])
          if (Number(mains[0]!.revision) !== Number(row.published_main_revision))
            throw new ApiError(409, '正式正文与草稿发布基线不一致，请联系管理员')
          const result = await update_story(Number(row.story_id), row.markdown, Number(row.published_main_revision), true, { base_namespace_revision: Number(row.namespace_revision), base_title_revision: Number(row.title_revision) }, undefined, { connection, title: title! })
          await connection.execute('UPDATE content_story_drafts SET published_main_revision = ?, unpublished_changes = 0, draft_revision = draft_revision + 1 WHERE id = ?', [result.revision, input.id])
          receipt = { ... receipt, main_revision: result.revision }
        }
      }
      if (receipt.ok && input.kind === 'reset') {
        const [mains] = row.story_id ? await connection.execute<RowDataPacket[]>('SELECT markdown, revision, namespace_revision FROM content_stories WHERE id = ?', [row.story_id]) : [[]]
        await connection.execute(`UPDATE content_story_drafts SET markdown = ?, published_main_revision = ?, namespace_revision = ?, title_revision = ?,
          draft_revision = draft_revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP(3), unpublished_changes = ? WHERE id = ?`,
        [mains[0]?.markdown ?? story_markdown_template(new Date().toISOString().slice(0, 10).replaceAll('-', '/')), mains[0]?.revision ?? null, mains[0]?.namespace_revision ?? 0, title!.revision, actor.id, mains[0] ? 0 : 1, input.id])
      }
      if (receipt.ok && input.kind === 'delete') {
        if (row.story_id)
          await delete_story(Number(row.story_id), actor.id, { connection, title: title! })
        else
          await connection.execute('DELETE FROM content_story_drafts WHERE id = ?', [input.id])
        await enqueue_content_refresh(connection, [`content_draft:${input.id}`, 'content_drafts:all'])
        if (Number(row.until_ms ?? 0) <= await database_now(connection))
          throw new ApiError(409, '编辑租约已过期，请核对云端草稿')
        await require_draft_actor(connection, actor)
        return { snapshot: null, receipt }
      }
    }
    catch (error) {
      if (! (error instanceof ApiError) || ! [400, 409, 413].includes(error.statusCode))
        throw error
      await connection.query('ROLLBACK TO SAVEPOINT draft_effects')
      receipt = { ... receipt, ok: false, error: 'validation_failed', message: error.message }
    }
    if (Number(row.until_ms ?? 0) <= await database_now(connection))
      throw new ApiError(409, '编辑租约已过期，请核对云端草稿')
    await require_draft_actor(connection, actor)
    await connection.execute(`UPDATE content_story_drafts SET last_command_seq = ?, last_command_hash = ?, last_command_result = CAST(? AS JSON),
      lease_until = ${receipt.ok && input.kind === 'release' ? 'NULL' : 'TIMESTAMPADD(MICROSECOND, ?, CURRENT_TIMESTAMP(3))'} WHERE id = ?`,
    [input.seq, fingerprint, JSON.stringify(receipt), ... (receipt.ok && input.kind === 'release' ? [] : [draft_lease_ms() * 1000]), input.id])
    if (receipt.ok && input.kind !== 'sync')
      await enqueue_content_refresh(connection, [`content_draft:${input.id}`, 'content_drafts:all'])
    return reply(receipt)
  })
}
