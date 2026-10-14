import type { ContentTask, ContentTaskItem, ContentTaskItemStatus, ContentTaskKind, ContentTaskProgressSnapshot, ContentTaskResolution, ContentTaskState, ContentTaskStatus } from '@shared/types/content'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { isDeepStrictEqual } from 'node:util'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { publish_task_snapshot } from '@server/lib/sync'
import { settings } from '@shared/settings'

/**
 * Attachment task storage (docs/old/content-task-refactor.md §3/§5). A task is one
 * user-level operation (a batch drop, one drag move, a multi-select encrypt…)
 * decomposed into items at creation; the runner drives the status machine and
 * the path locks (lib/operation-lock) give mutual exclusion. This module owns
 * only persistence and state transitions — scheduling lives in task-runner.
 */

interface TaskRow extends RowDataPacket {
  id: number
  scope_id: number
  kind: string
  status: string
  /** mysql2 returns JSON columns as objects; a raw string arrives when the driver leaves it unparsed. */
  payload: string | Record<string, unknown>
  actor_id: number | null
  client_id: string | null
  error: string | null
  heartbeat_at: string | null
  created_at: string
  updated_at: string
}

interface TaskItemRow extends RowDataPacket {
  paused_at?: string | null
  control_version?: number | string
  retry_of_item_id?: number | null
  superseded_at?: string | null
  id: number
  task_id: number
  path: string
  action: string
  status: string
  bytes_done: number | string
  bytes_total: number | string
  staging_key: string | null
  upload_id: string | null
  part_size: number | string | null
  result: string | Record<string, unknown> | null
}

/** Legal task status transitions — the single source of truth the runner and API share. */
export const content_task_transitions = {
  queued: ['running', 'cancelled'],
  running: ['paused', 'cancelling', 'done', 'failed'],
  paused: ['queued', 'cancelled'],
  cancelling: ['cancelled', 'failed'],
  done: [],
  /** A failed task can be re-queued for resume, or written off by cancelling it. */
  failed: ['queued', 'cancelled'],
  cancelled: [],
} as const satisfies Record<ContentTaskStatus, readonly ContentTaskStatus[]>

const terminal_statuses: readonly ContentTaskStatus[] = ['done', 'failed', 'cancelled']

function parse_json_column<T extends Record<string, unknown>>(value: string | T | null): T | null {
  if (value === null)
    return null
  return (typeof value === 'string' ? JSON.parse(value) : value) as T
}

function format_task(row: TaskRow): ContentTask {
  return {
    id: Number(row.id),
    scope_id: Number(row.scope_id),
    kind: row.kind as ContentTaskKind,
    status: row.status as ContentTaskStatus,
    payload: parse_json_column(row.payload) ?? {},
    actor_id: row.actor_id === null ? null : Number(row.actor_id),
    client_id: row.client_id,
    error: row.error,
    heartbeat_at: row.heartbeat_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function format_task_item(row: TaskItemRow): ContentTaskItem {
  return {
    paused_at: row.paused_at ?? null,
    control_version: Number(row.control_version ?? 0),
    retry_of_item_id: row.retry_of_item_id == null ? null : Number(row.retry_of_item_id),
    superseded_at: row.superseded_at ?? null,
    id: Number(row.id),
    task_id: Number(row.task_id),
    path: row.path,
    action: row.action,
    status: row.status as ContentTaskItemStatus,
    bytes_done: Number(row.bytes_done),
    bytes_total: Number(row.bytes_total),
    staging_key: row.staging_key,
    upload_id: row.upload_id,
    part_size: row.part_size === null ? null : Number(row.part_size),
    result: parse_json_column(row.result),
  }
}

export type ContentTaskWithItems = ContentTaskState

/** The wire form of a task for sync events: only what a progress display needs. */
export function task_snapshot(state: ContentTaskState): ContentTaskProgressSnapshot {
  return {
    task_id: state.task.id,
    scope_id: state.task.scope_id,
    status: state.task.status,
    items: state.items.map((item) => {
      const resolution = (item.result?.resolve ?? item.result?.resolution) as ContentTaskResolution | undefined
      const display_path = typeof item.result?.display_path === 'string' ? item.result.display_path : null
      return {
        paused_at: item.paused_at ?? null,
        control_version: item.control_version ?? 0,
        retry_of_item_id: item.retry_of_item_id ?? null,
        superseded_at: item.superseded_at ?? null,
        id: item.id,
        path: resolution?.from ?? display_path ?? item.path,
        status: item.status,
        bytes_done: item.bytes_done,
        bytes_total: item.bytes_total,
        resolution: item.result?.resolve as ContentTaskResolution | null ?? null,
        reason: typeof item.result?.reason === 'string' ? item.result.reason : null,
      }
    }),
  }
}

export interface ContentTaskItemInput {
  path: string
  action: string
  bytes_total?: number
  status?: ContentTaskItemStatus
  result?: Record<string, unknown> | null
}

export interface ContentTaskResolutionUpdate {
  item_id: number
  path: string
  status: ContentTaskItemStatus
  result: Record<string, unknown> | null
}

/**
 * Creates a task and its items in one transaction. The caller (preflight +
 * createTask API) has already validated the payload; this layer only persists.
 */
export async function create_task(input: {
  retry?: { task_id: number, item_id: number, base_payload: Record<string, unknown> }
  scope_id: number
  kind: ContentTaskKind
  payload: Record<string, unknown>
  items: ContentTaskItemInput[]
  actor_id: number | null
  client_id: string | null
  status?: ContentTaskStatus
}): Promise<ContentTaskWithItems> {
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    if (input.retry) {
      // Always lock task before item, matching resume, cancel and retention deletion.
      const [old_tasks] = await connection.execute<TaskRow[]>('SELECT * FROM content_tasks WHERE id = ? FOR UPDATE', [input.retry.task_id])
      const old_task = old_tasks[0]
      if (! old_task || Number(old_task.scope_id) !== input.scope_id || old_task.kind !== input.kind)
        throw new ApiError(404, '原任务不存在或已过期')
      const [old_items] = await connection.execute<TaskItemRow[]>('SELECT * FROM content_task_items WHERE task_id = ? FOR UPDATE', [input.retry.task_id])
      const old_item = old_items.find(item => Number(item.id) === input.retry!.item_id)
      if (! old_item)
        throw new ApiError(404, '原任务项不存在或已过期')
      const [successors] = await connection.execute<TaskItemRow[]>('SELECT * FROM content_task_items WHERE retry_of_item_id = ?', [input.retry.item_id])
      if (successors[0]) {
        await connection.commit()
        const existing = await get_task(Number(successors[0].task_id))
        if (! existing)
          throw new ApiError(409, '重试任务已过期，请刷新')
        return existing
      }
      if (old_item.superseded_at || old_item.status !== 'failed' || ! ['done', 'failed'].includes(old_task.status))
        throw new ApiError(409, '该任务项不能重新创建，请刷新后继续当前任务')
      if (old_task.kind === 'upload' && old_item.staging_key)
        throw new ApiError(409, '该上传仍可续传，请继续原任务')
      if (! isDeepStrictEqual(parse_json_column(old_task.payload), input.retry.base_payload) || input.items.length !== 1)
        throw new ApiError(409, '原任务内容已变化，请刷新后重试')
    }
    const [result] = await connection.execute<ResultSetHeader>(
      'INSERT INTO content_tasks (scope_id, kind, status, payload, actor_id, client_id) VALUES (?, ?, ?, CAST(? AS JSON), ?, ?)',
      [input.scope_id, input.kind, input.status ?? 'queued', JSON.stringify(input.payload), input.actor_id, input.client_id],
    )
    const task_id = Number(result.insertId)
    for (const item of input.items) {
      await connection.execute(
        'INSERT INTO content_task_items (task_id, path, action, status, bytes_total, result, retry_of_item_id) VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?)',
        [task_id, item.path, item.action, item.status ?? 'pending', item.bytes_total ?? 0, item.result ? JSON.stringify(item.result) : null, input.retry?.item_id ?? null],
      )
    }
    if (input.retry) {
      await connection.execute('UPDATE content_task_items SET superseded_at = CURRENT_TIMESTAMP WHERE id = ? AND task_id = ?', [input.retry.item_id, input.retry.task_id])
    }
    await connection.commit()
    const created = await get_task(task_id)
    if (! created)
      throw new ApiError(500, '任务写入失败，请重试')
    return created
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally {
    connection.release()
  }
}

export async function get_task(task_id: number): Promise<ContentTaskWithItems | null> {
  const [rows] = await db.execute<TaskRow[]>(
    'SELECT * FROM content_tasks WHERE id = ?',
    [task_id],
  )
  const row = rows[0]
  if (! row)
    return null
  return { task: format_task(row), items: await list_task_items(task_id) }
}

export async function get_retry_task(item_id: number) {
  const [rows] = await db.execute<TaskItemRow[]>('SELECT * FROM content_task_items WHERE retry_of_item_id = ?', [item_id])
  return rows[0] ? get_task(Number(rows[0].task_id)) : null
}

/** Serialize pause/resume with cancel, retry and retention on the task row. */
export async function set_transfer_paused(task_id: number, item_id: number, paused: boolean) {
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    const [tasks] = await connection.execute<TaskRow[]>('SELECT * FROM content_tasks WHERE id = ? FOR UPDATE', [task_id])
    const task = tasks[0]
    if (! task)
      throw new ApiError(404, '任务不存在或已过期')
    const [items] = await connection.execute<TaskItemRow[]>('SELECT * FROM content_task_items WHERE task_id = ? FOR UPDATE', [task_id])
    const item = items.find(item => Number(item.id) === item_id)
    if (! item || ! ['upload', 'replace', 'redact'].includes(item.action))
      throw new ApiError(404, '上传任务项不存在')
    if (item.superseded_at || item.status !== 'active' || ! ['running', 'paused', 'failed'].includes(task.status))
      throw new ApiError(409, '任务项已结束，请刷新')
    if (items.some(item => format_task_item(item).result?.resolve))
      throw new ApiError(409, '请先处理待确认的名称')
    if (!! item.paused_at !== paused) {
      await connection.execute(
        `UPDATE content_task_items SET paused_at = ${paused ? 'CURRENT_TIMESTAMP' : 'NULL'}, control_version = control_version + 1 WHERE id = ? AND task_id = ?`,
        [item_id, task_id],
      )
      item.paused_at = paused ? 'paused' : null
    }
    const unfinished = items.filter(item => ['pending', 'active'].includes(item.status) && ! item.superseded_at)
    const next_status = paused
      ? unfinished.length && unfinished.every(item => item.paused_at) ? 'paused' : task.status
      : task.status === 'paused' || task.status === 'failed' ? 'queued' : task.status
    if (next_status !== task.status)
      await connection.execute('UPDATE content_tasks SET status = ?, error = NULL WHERE id = ?', [next_status, task_id])
    if (next_status === 'paused')
      await connection.execute('DELETE FROM content_locks WHERE task_id = ?', [task_id])
    await connection.commit()
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally {
    connection.release()
  }
  const state = await get_task(task_id)
  if (! state)
    throw new ApiError(404, '任务不存在或已过期')
  return state
}

/** Finishing a sibling must not overwrite a concurrent continue command. */
export async function pause_task_if_all_items_paused(task_id: number) {
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE content_tasks SET status = 'paused' WHERE id = ? AND status = 'running'
       AND EXISTS (SELECT 1 FROM content_task_items WHERE task_id = ? AND status IN ('pending','active') AND superseded_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM content_task_items WHERE task_id = ? AND status IN ('pending','active') AND superseded_at IS NULL AND paused_at IS NULL)`,
      [task_id, task_id, task_id],
    )
    if (result.affectedRows)
      await connection.execute('DELETE FROM content_locks WHERE task_id = ?', [task_id])
    await connection.commit()
    return !! result.affectedRows
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally {
    connection.release()
  }
}

async function list_task_items(task_id: number) {
  const [rows] = await db.execute<TaskItemRow[]>(
    'SELECT * FROM content_task_items WHERE task_id = ? ORDER BY id',
    [task_id],
  )
  return rows.map(format_task_item)
}

/**
 * Every task of the scope worth showing: non-terminal ones, plus terminal ones
 * still inside the retention window (the resume/audit window). Older terminal
 * rows are the sweeper's business, not the UI's.
 */
export async function list_scope_tasks(scope_id: number): Promise<ContentTaskWithItems[]> {
  const [rows] = await db.execute<TaskRow[]>(
    `SELECT * FROM content_tasks
     WHERE scope_id = ? AND (
       status NOT IN ('done', 'failed', 'cancelled')
       OR updated_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     )
     ORDER BY id`,
    [scope_id, settings.app.content.task.retentionHours],
  )
  return with_items(rows)
}

/** Every queued task across all scopes, FIFO — the runner's dispatch queue. */
export async function list_queued_tasks(limit = 100): Promise<ContentTaskWithItems[]> {
  const [rows] = await db.execute<TaskRow[]>(
    'SELECT * FROM content_tasks WHERE status = \'queued\' ORDER BY id LIMIT ?',
    [limit],
  )
  return with_items(rows)
}

async function with_items(rows: TaskRow[]): Promise<ContentTaskWithItems[]> {
  if (! rows.length)
    return []
  const ids = rows.map(row => Number(row.id))
  const [item_rows] = await db.execute<TaskItemRow[]>(
    `SELECT * FROM content_task_items WHERE task_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    ids,
  )
  const items_by_task = new Map<number, ContentTaskItem[]>()
  for (const item of item_rows.map(format_task_item)) {
    const list = items_by_task.get(item.task_id) ?? []
    list.push(item)
    items_by_task.set(item.task_id, list)
  }
  return rows.map(row => ({
    task: format_task(row),
    items: items_by_task.get(Number(row.id)) ?? [],
  }))
}

/**
 * Moves a task along the state machine. The legal pre-states derive from
 * content_task_transitions, and the UPDATE is conditional on them, so a stale
 * caller (task already moved on) gets a 409 instead of silently rewinding it.
 */
export async function transition_task(task_id: number, to: ContentTaskStatus, patch: { error?: string | null } = {}) {
  const from = (Object.keys(content_task_transitions) as ContentTaskStatus[])
    .filter(status => (content_task_transitions[status] as readonly ContentTaskStatus[]).includes(to))
  if (! from.length)
    throw new ApiError(409, `任务不能进入 ${to} 状态`)
  const [result] = await db.execute<ResultSetHeader>(
    `UPDATE content_tasks SET status = ?, error = ? WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`,
    [to, patch.error ?? null, task_id, ... from],
  )
  if (! result.affectedRows)
    throw new ApiError(409, '任务状态已变化，请刷新后重试')
}

/** Runner liveness: only a running task may heartbeat; a 0-row update means it moved on (cancelled/swept). */
export async function heartbeat_task(task_id: number) {
  const [result] = await db.execute<ResultSetHeader>(
    'UPDATE content_tasks SET heartbeat_at = NOW() WHERE id = ? AND status = \'running\'',
    [task_id],
  )
  if (! result.affectedRows)
    throw new ApiError(409, '任务状态已变化，请刷新后重试')
}

/** Pushes the task's live state to subscribers without making them refetch. */
export async function publish_task_state(task_id: number) {
  const state = await get_task(task_id)
  if (state)
    publish_task_snapshot(task_snapshot(state))
}

/** Partial per-item update, always scoped by task so a stale runner cannot touch another task's items. */
export async function update_task_item(task_id: number, item_id: number, patch: {
  status?: ContentTaskItemStatus
  bytes_done?: number
  staging_key?: string | null
  upload_id?: string | null
  part_size?: number | null
  result?: Record<string, unknown> | null
}) {
  const sets: string[] = []
  const params: (string | number | null)[] = []
  if (patch.status !== undefined) {
    sets.push('status = ?')
    params.push(patch.status)
  }
  if (patch.bytes_done !== undefined) {
    sets.push('bytes_done = ?')
    params.push(patch.bytes_done)
  }
  if (patch.staging_key !== undefined) {
    sets.push('staging_key = ?')
    params.push(patch.staging_key)
  }
  if (patch.upload_id !== undefined) {
    sets.push('upload_id = ?')
    params.push(patch.upload_id)
  }
  if (patch.part_size !== undefined) {
    sets.push('part_size = ?')
    params.push(patch.part_size)
  }
  if (patch.result !== undefined) {
    sets.push('result = CAST(? AS JSON)')
    params.push(patch.result === null ? null : JSON.stringify(patch.result))
  }
  if (! sets.length)
    return
  params.push(item_id, task_id)
  await db.execute(
    `UPDATE content_task_items SET ${sets.join(', ')} WHERE id = ? AND task_id = ?`,
    params,
  )
}

/** Applies resolve choices and resumes the task atomically after its last choice. */
export async function apply_task_resolutions(task_id: number, payload: Record<string, unknown>, updates: ContentTaskResolutionUpdate[], base_payload: Record<string, unknown>) {
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    const [tasks] = await connection.execute<(TaskRow & RowDataPacket)[]>(
      'SELECT * FROM content_tasks WHERE id = ? FOR UPDATE',
      [task_id],
    )
    const task = tasks[0]
    if (! task)
      throw new ApiError(404, '任务不存在或已被删除')
    if (task.status !== 'paused')
      throw new ApiError(409, '任务已不在待处理状态，请刷新后重试')
    // Choices were computed from a snapshot before taking the row lock. A
    // different device may have resolved another item meanwhile; never write
    // its old paths back over the newly committed payload.
    if (! isDeepStrictEqual(parse_json_column(task.payload) ?? {}, base_payload))
      throw new ApiError(409, '任务内容已变化，请刷新后重试')

    const [item_rows] = await connection.execute<TaskItemRow[]>(
      'SELECT * FROM content_task_items WHERE task_id = ? FOR UPDATE',
      [task_id],
    )
    const update_by_id = new Map(updates.map(update => [update.item_id, update]))
    for (const row of item_rows) {
      const update = update_by_id.get(Number(row.id))
      if (! update)
        continue
      const current = format_task_item(row)
      if (! current.result || ! current.result.resolve)
        throw new ApiError(409, '待处理项已变化，请刷新后重试')
      await connection.execute(
        'UPDATE content_task_items SET path = ?, status = ?, result = CAST(? AS JSON) WHERE id = ? AND task_id = ?',
        [update.path, update.status, update.result === null ? null : JSON.stringify(update.result), update.item_id, task_id],
      )
    }
    if (update_by_id.size !== updates.length || [... update_by_id.keys()].some(id => ! item_rows.some(row => Number(row.id) === id)))
      throw new ApiError(404, '任务项不存在或已被删除')

    const unresolved = item_rows.some((row) => {
      const update = update_by_id.get(Number(row.id))
      const result = update ? update.result : format_task_item(row).result
      return !! result?.resolve
    })
    const all_terminal = item_rows.every((row) => {
      const status = update_by_id.get(Number(row.id))?.status ?? row.status
      return ['done', 'skipped', 'failed'].includes(status)
    })
    // Finish a fully skipped task under the same lock; there is no work for
    // the runner, and queued → done is not a legal runner transition.
    const next_status = unresolved ? 'paused' : all_terminal ? 'done' : 'queued'
    await connection.execute(
      'UPDATE content_tasks SET payload = CAST(? AS JSON), status = ? WHERE id = ? AND status = \'paused\'',
      [JSON.stringify(payload), next_status, task_id],
    )
    await connection.commit()
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally {
    connection.release()
  }
  const result = await get_task(task_id)
  if (! result)
    throw new ApiError(404, '任务不存在或已被删除')
  return result
}

/** The statuses list_scope_tasks treats as live; exported for the runner's sweeps. */
export function is_terminal_task_status(status: ContentTaskStatus) {
  return terminal_statuses.includes(status)
}

/** Every task that reached a terminal state before the retention window opened. */
export async function list_expired_tasks(): Promise<number[]> {
  const [rows] = await db.execute<TaskRow[]>(
    `SELECT id FROM content_tasks
     WHERE status IN ('done', 'failed', 'cancelled')
       AND updated_at < DATE_SUB(NOW(), INTERVAL ? HOUR)
     ORDER BY id LIMIT 500`,
    [settings.app.content.task.retentionHours],
  )
  return rows.map(row => Number(row.id))
}

/**
 * Drops a finished task and its items. The DELETE is guarded on the status, so
 * a task that was re-queued for resume between the caller's read and this call
 * is left alone (and its items with it) — the caller must not discard a stage it
 * no longer owns.
 */
export async function delete_finished_task(task_id: number) {
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    const [result] = await connection.execute<ResultSetHeader>(
      'DELETE FROM content_tasks WHERE id = ? AND status IN (\'done\', \'failed\', \'cancelled\')',
      [task_id],
    )
    if (! result.affectedRows) {
      await connection.commit()
      return false
    }
    await connection.execute('DELETE FROM content_task_items WHERE task_id = ?', [task_id])
    await connection.commit()
    return true
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally {
    connection.release()
  }
}
