import type { ContentTask, ContentTaskItem, ContentTaskItemStatus, ContentTaskKind, ContentTaskStatus } from '@shared/types/content'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { runtime_config } from '@shared/config'

const config = runtime_config()

/**
 * Attachment task storage (docs/content-task-refactor.md §3/§5). A task is one
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
  /** A failed task (e.g. interrupted mid-flight) can be re-queued for resume. */
  failed: ['queued'],
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

export interface ContentTaskWithItems {
  task: ContentTask
  items: ContentTaskItem[]
}

export interface ContentTaskItemInput {
  path: string
  action: string
  bytes_total?: number
}

/**
 * Creates a task and its items in one transaction. The caller (preflight +
 * createTask API) has already validated the payload; this layer only persists.
 */
export async function create_task(input: {
  scope_id: number
  kind: ContentTaskKind
  payload: Record<string, unknown>
  items: ContentTaskItemInput[]
  actor_id: number | null
  client_id: string | null
}): Promise<ContentTaskWithItems> {
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    const [result] = await connection.execute<ResultSetHeader>(
      'INSERT INTO content_tasks (scope_id, kind, payload, actor_id, client_id) VALUES (?, ?, CAST(? AS JSON), ?, ?)',
      [input.scope_id, input.kind, JSON.stringify(input.payload), input.actor_id, input.client_id],
    )
    const task_id = Number(result.insertId)
    for (const item of input.items) {
      await connection.execute(
        'INSERT INTO content_task_items (task_id, path, action, bytes_total) VALUES (?, ?, ?, ?)',
        [task_id, item.path, item.action, item.bytes_total ?? 0],
      )
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
    [scope_id, config.app.content.task.retentionHours],
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

/** The statuses list_scope_tasks treats as live; exported for the runner's sweeps. */
export function is_terminal_task_status(status: ContentTaskStatus) {
  return terminal_statuses.includes(status)
}
