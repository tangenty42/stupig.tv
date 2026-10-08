import type { ContentOperationKind, ContentOperationLock, ContentPathLock, ContentTaskKind } from '@shared/types/content'
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { runtime_config } from '@shared/config'
import { attachment_path_conflicts } from '@shared/content-markdown'

const config = runtime_config()

// Scope-level mutual exclusion for content attachment structure changes. The
// lock is a single row per scope (`story_id`) carrying a lease, which gives
// two properties the in-memory guards of a single browser tab cannot: it is
// shared across tabs/users, and a crashed request self-heals once the lease
// expires instead of wedging the scope.
//
// Rows live in content_locks. path '' is the whole scope (legacy structural
// operations); the attachment task runner (docs/content-task-refactor.md)
// holds path-granular rows keyed by task_id. The two levels are mutually
// exclusive: the scope row contends with every live path row and vice versa.

interface LockRow extends RowDataPacket {
  kind: string
  expires_at: string | Date
}

interface LockPathRow extends RowDataPacket {
  path: string
  kind: string
  task_id: number | null
  expires_at: string | Date
}

/** The named guard that serializes lock check-and-insert per scope. */
function scope_guard_name(scope_id: number) {
  return `content_locks:${scope_id}`
}

async function acquire_scope_guard(connection: Connection, scope_id: number, timeout_seconds: number) {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT GET_LOCK(?, ?) AS acquired',
    [scope_guard_name(scope_id), timeout_seconds],
  )
  return rows[0]?.acquired === 1
}

async function release_scope_guard(connection: Connection, scope_id: number) {
  await connection.execute('SELECT RELEASE_LOCK(?)', [scope_guard_name(scope_id)])
}

/** Expired leases are not live locks; purge before inspecting so a stale row never blocks an insert. */
async function purge_expired_locks(connection: Connection, scope_id: number) {
  await connection.execute(
    'DELETE FROM content_locks WHERE scope_id = ? AND expires_at < NOW()',
    [scope_id],
  )
}

async function list_live_locks(connection: Connection, scope_id: number) {
  const [rows] = await connection.execute<LockPathRow[]>(
    'SELECT path, kind, task_id, expires_at FROM content_locks WHERE scope_id = ? AND expires_at >= NOW()',
    [scope_id],
  )
  return rows
}

export interface AcquiredOperationLock {
  scope_id: number
  token: string
}

/**
 * Takes the scope's lock, atomically stealing it when the previous holder's
 * lease has expired. Contention is reported as a 409 rather than queued: the
 * caller's operation is a read-check-write sequence over names that cannot be
 * replayed transparently, so the UI has to explain the state instead.
 *
 * The check-and-insert runs inside a per-scope named lock (GET_LOCK) on one
 * connection — the row upsert alone cannot see another holder's *path* locks,
 * and a task acquiring path locks must likewise see a scope lock taken
 * mid-flight, so both directions share one critical section. The scope lock
 * (path '') contends with every live path lock: an old-style structural
 * operation (encrypt, redact, …) never runs next to a task.
 */
export async function acquire_operation_lock(scope_id: number, kind: ContentOperationKind): Promise<AcquiredOperationLock> {
  const token = crypto.randomUUID()
  const connection = await db.getConnection()
  try {
    // A brief wait absorbs same-millisecond contention between operations
    // whose locks would not actually conflict; the critical section is only
    // a handful of queries.
    if (! await acquire_scope_guard(connection, scope_id, 2))
      throw new ApiError(409, '操作冲突，请稍后再试')
    try {
      await purge_expired_locks(connection, scope_id)
      const held = await list_live_locks(connection, scope_id)
      if (held.length)
        throw new ApiError(409, '操作冲突，请稍后再试')
      await connection.execute(
        'INSERT INTO content_locks (scope_id, path, kind, token, expires_at) VALUES (?, \'\', ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))',
        [scope_id, kind, token, config.app.content.operationLock.ttlSeconds],
      )
    }
    finally {
      await release_scope_guard(connection, scope_id)
    }
  }
  finally {
    connection.release()
  }
  return { scope_id, token }
}

/** Frees the lock, but only while this holder still owns it — after a steal the old holder must not clear the new one's lease. */
export async function release_operation_lock(lock: AcquiredOperationLock) {
  await db.execute(
    'DELETE FROM content_locks WHERE scope_id = ? AND path = \'\' AND token = ?',
    [lock.scope_id, lock.token],
  )
}

/** The scope's live lock, as rendered by peers to disable the controls an operation would collide with. */
export async function get_operation_lock(scope_id: number): Promise<ContentOperationLock | null> {
  // A task's path lock disables the same controls as the scope lock during the
  // transition to the task queue; per-path disabled states arrive with the
  // editor's preflight wiring. The scope row (path '') wins when both exist.
  const [rows] = await db.execute<LockRow[]>(
    'SELECT kind, expires_at FROM content_locks WHERE scope_id = ? AND expires_at >= NOW() ORDER BY (path = \'\') DESC, expires_at DESC LIMIT 1',
    [scope_id],
  )
  const row = rows[0]
  if (! row)
    return null
  return {
    kind: row.kind as ContentOperationKind,
    expires_at: new Date(row.expires_at).toISOString(),
  }
}

/* ------------------------------------------------------------------------- */
/* Path-granular locks (attachment task runner)                               */
/* ------------------------------------------------------------------------- */

export interface AcquiredPathLocks {
  scope_id: number
  task_id: number
  token: string
  paths: string[]
}

export type PathLockAcquireResult
  = | { acquired: true, lock: AcquiredPathLocks }
    /** Not acquired: `conflicts` lists the requested paths that collide with a live lock. */
    | { acquired: false, conflicts: string[] }

/**
 * Takes path locks for a task: one row per path, all-or-nothing.
 *
 * Contention is a two-way prefix match (see attachment_path_conflicts):
 * locking `a/b/c.png` collides with `a/b` (its ancestor) and with `a/b/c.png/x`
 * (a descendant), so locking a file blocks its folder chain and locking a
 * folder blocks its whole subtree. The scope-level lock (path '') contends
 * with every path, which is what keeps legacy operations and tasks apart.
 *
 * A contended task is NOT an error — it stays queued and the runner retries —
 * so a failed acquisition reports the conflicting paths rather than throwing.
 * The empty `conflicts` case means the scope's named guard was busy; retry.
 */
export async function acquire_path_locks(scope_id: number, paths: string[], task_id: number, kind: ContentTaskKind): Promise<PathLockAcquireResult> {
  if (! paths.length)
    return { acquired: true, lock: { scope_id, task_id, token: crypto.randomUUID(), paths } }
  const token = crypto.randomUUID()
  const connection = await db.getConnection()
  try {
    // No wait: the runner retries a contended acquisition on its next tick.
    if (! await acquire_scope_guard(connection, scope_id, 0))
      return { acquired: false, conflicts: [] }
    try {
      await purge_expired_locks(connection, scope_id)
      const held = await list_live_locks(connection, scope_id)
      const conflicts = paths.filter(path =>
        held.some(row => row.path === '' || attachment_path_conflicts(row.path, path)),
      )
      if (conflicts.length)
        return { acquired: false, conflicts: [... new Set(conflicts)] }
      const ttl = config.app.content.operationLock.ttlSeconds
      for (const path of paths) {
        await connection.execute(
          'INSERT INTO content_locks (scope_id, path, kind, task_id, token, expires_at) VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))',
          [scope_id, path, kind, task_id, token, ttl],
        )
      }
      return { acquired: true, lock: { scope_id, task_id, token, paths } }
    }
    finally {
      await release_scope_guard(connection, scope_id)
    }
  }
  finally {
    connection.release()
  }
}

/**
 * Rolls the lease forward (runner heartbeat). A short count means part of the
 * lock set is gone — swept as expired or force-released — so the task must
 * stop: continuing would run a structure change without mutual exclusion.
 */
export async function renew_path_locks(lock: AcquiredPathLocks) {
  const [result] = await db.execute<ResultSetHeader>(
    'UPDATE content_locks SET expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE scope_id = ? AND task_id = ? AND token = ?',
    [config.app.content.operationLock.ttlSeconds, lock.scope_id, lock.task_id, lock.token],
  )
  if (result.affectedRows !== lock.paths.length)
    throw new ApiError(409, '任务锁已失效，请重试')
}

/** Frees the task's locks, but only while this token still owns them. */
export async function release_path_locks(lock: AcquiredPathLocks) {
  await db.execute(
    'DELETE FROM content_locks WHERE scope_id = ? AND task_id = ? AND token = ?',
    [lock.scope_id, lock.task_id, lock.token],
  )
}

/**
 * Frees whatever locks a task still holds, whichever acquisition they came
 * from. Transfer tasks (uploads) outlive the request that started them, so the
 * completion path — a later request, or the sweeper — cannot hold the original
 * token; task_id alone scopes the release, and a re-queued task re-acquires
 * with a fresh token anyway.
 */
export async function release_task_locks(scope_id: number, task_id: number) {
  await db.execute(
    'DELETE FROM content_locks WHERE scope_id = ? AND task_id = ?',
    [scope_id, task_id],
  )
}

/**
 * Rolls whatever locks a task holds forward. The report path (client progress)
 * cannot present the original token, and task_id already scopes the claim, so
 * this renews by task. Returns how many lock rows were touched: a short count
 * means the claim was swept and the caller must stop.
 */
export async function renew_task_locks(scope_id: number, task_id: number) {
  const [result] = await db.execute<ResultSetHeader>(
    'UPDATE content_locks SET expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE scope_id = ? AND task_id = ?',
    [config.app.content.operationLock.ttlSeconds, scope_id, task_id],
  )
  return Number(result.affectedRows)
}

/** Every live lock of the scope (scope row included), for preflight and the editor's disabled states. */
export async function list_scope_locks(scope_id: number): Promise<ContentPathLock[]> {
  const [rows] = await db.execute<LockPathRow[]>(
    'SELECT path, kind, task_id, expires_at FROM content_locks WHERE scope_id = ? AND expires_at >= NOW()',
    [scope_id],
  )
  return rows.map(row => ({
    path: row.path,
    kind: row.kind,
    task_id: row.task_id === null ? null : Number(row.task_id),
    expires_at: new Date(row.expires_at).toISOString(),
  }))
}
