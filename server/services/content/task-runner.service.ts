import type { RowDataPacket } from 'mysql2/promise'
import type { ContentTaskWithItems } from './task.service'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { log_error } from '@server/lib/log'
import { acquire_path_locks, release_path_locks } from '@server/lib/operation-lock'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { runtime_config } from '@shared/config'
import { execute_task, task_lock_paths } from './task-operations.service'
import { get_task, is_terminal_task_status, list_queued_tasks, transition_task } from './task.service'

const config = runtime_config()

/**
 * The attachment task runner (docs/content-task-refactor.md §5): an in-process
 * loop that dispatches queued tasks FIFO. Tasks hold path locks for their
 * whole execution; a contended task stays queued and is retried on the next
 * tick — it is never failed for contention inside the timeout window.
 *
 * Two entry points share one dispatch path:
 * - `run_task_synchronously` — request-driven (legacy endpoints): dispatch
 *   inline so the caller gets the outcome (or the executor's ApiError) now;
 * - the interval tick / `kick_task_runner` — sweeps interrupted tasks and
 *   dispatches anything still queued.
 *
 * Phase-1 kinds are pure DB operations, so inline dispatch always finishes
 * within the request. Transfer kinds (phase 2) drive the heartbeat/renewal
 * path that pure-DB execution does not need.
 */

let timer: ReturnType<typeof setInterval> | null = null
let ticking = false

export function start_task_runner() {
  if (timer)
    return
  timer = setInterval(() => {
    void tick()
  }, config.app.content.task.sweepIntervalSeconds * 1000)
  // The interval must not keep the process alive on its own (tests, CLI runs).
  timer.unref?.()
}

export function stop_task_runner() {
  if (timer)
    clearInterval(timer)
  timer = null
}

/** Runs a dispatch+expiration pass; called on an interval and after every task creation. */
export function kick_task_runner() {
  void tick()
}

/**
 * Drives one queued task: take its path locks, run the executor, release. A
 * lock conflict leaves the task queued for the next tick. Executor errors mark
 * the task failed and are rethrown so a synchronous caller gets the original
 * ApiError; the tick path logs them instead.
 */
export async function dispatch_task(task_id: number) {
  const current = await get_task(task_id)
  if (! current || current.task.status !== 'queued')
    return
  const { task, items } = current
  const paths = task_lock_paths(task.kind, task.payload)
  const acquired = await acquire_path_locks(task.scope_id, paths, task.id, task.kind)
  if (! acquired.acquired)
    return
  const lock = acquired.lock
  try {
    try {
      await transition_task(task.id, 'running')
    }
    catch {
      // Another dispatcher (tick vs inline) took it; the winner owns execution.
      return
    }
    try {
      await execute_task(task, items)
      await transition_task(task.id, 'done')
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The task may have moved on (cancelled mid-flight); then that wins.
      await transition_task(task.id, 'failed', { error: message }).catch(() => {})
      throw error
    }
  }
  finally {
    // A release failure only leaves the lease to lapse into the sweeper.
    await release_path_locks(lock).catch(() => {})
    publish_refresh({ resource: sync_resource('content_story_tasks', task.scope_id) })
  }
}

/**
 * Runs a task inline for a request that needs the outcome now. Mirrors the old
 * scope-locked calls exactly: executor errors propagate with their status, and
 * a task that could not start (its paths are locked by another task) is the
 * same 409 the scope lock used to produce.
 */
export async function run_task_synchronously(task_id: number): Promise<ContentTaskWithItems> {
  await dispatch_task(task_id)
  const result = await get_task(task_id)
  if (! result || ! is_terminal_task_status(result.task.status))
    throw new ApiError(409, '操作冲突，请稍后再试')
  return result
}

async function tick() {
  if (ticking)
    return
  ticking = true
  try {
    await sweep_expired_locks()
    await fail_stale_queued_tasks()
    for (const { task } of await list_queued_tasks()) {
      try {
        await dispatch_task(task.id)
      }
      catch (error) {
        log_error('content task failed', {
          task_id: task.id,
          kind: task.kind,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  finally {
    ticking = false
  }
}

/**
 * Expired task locks mean the holder died mid-operation (request crash,
 * deploy). The task is marked failed (interrupted) so it never wedges in
 * 'running', then the sweeper's purge frees the paths. Resume re-queues it.
 */
async function sweep_expired_locks() {
  const [rows] = await db.execute<RowDataPacket[]>(
    'SELECT DISTINCT scope_id, task_id FROM content_locks WHERE expires_at < NOW() AND task_id IS NOT NULL',
  )
  for (const row of rows) {
    await transition_task(Number(row.task_id), 'failed', { error: '任务中断，请重试' }).catch(() => {})
  }
  await db.execute('DELETE FROM content_locks WHERE expires_at < NOW()')
}

/** Queued beyond the timeout (locks never freed up): fail with the conflict text the UI already knows. */
async function fail_stale_queued_tasks() {
  const [rows] = await db.execute<RowDataPacket[]>(
    'SELECT id FROM content_tasks WHERE status = \'queued\' AND created_at < DATE_SUB(NOW(), INTERVAL ? SECOND)',
    [config.app.content.task.queuedTimeoutSeconds],
  )
  for (const row of rows) {
    await transition_task(Number(row.id), 'failed', { error: '操作冲突，请稍后再试' }).catch(() => {})
  }
}
