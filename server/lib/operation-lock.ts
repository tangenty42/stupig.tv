import type { ContentOperationKind, ContentOperationLock } from '@shared/types/content'
import type { RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { runtime_config } from '@shared/config'

const config = runtime_config()

// Scope-level mutual exclusion for content attachment structure changes. The
// lock is a single row per scope (`story_id`) carrying a lease, which gives
// two properties the in-memory guards of a single browser tab cannot: it is
// shared across tabs/users, and a crashed request self-heals once the lease
// expires instead of wedging the scope.
//
// Rows live in content_locks at path '' (the whole scope). Path-granular rows
// arrive with the attachment task runner (docs/content-task-refactor.md); until
// then every operation locks the scope, so contention semantics are unchanged.

interface LockTokenRow extends RowDataPacket {
  token: string
}

interface LockRow extends RowDataPacket {
  kind: string
  expires_at: string | Date
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
 * Ownership is confirmed by re-reading the token rather than by the upsert's
 * affected-row count, which cannot distinguish "inserted/stolen" from
 * "matched a live lease and left it untouched" (mysql2 connects with
 * CLIENT_FOUND_ROWS, so an unchanged row still counts as affected).
 */
export async function acquire_operation_lock(scope_id: number, kind: ContentOperationKind): Promise<AcquiredOperationLock> {
  const token = crypto.randomUUID()
  await db.execute(
    `INSERT INTO content_locks (scope_id, path, kind, token, expires_at)
     VALUES (?, '', ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))
     ON DUPLICATE KEY UPDATE
       kind = IF(expires_at < NOW(), VALUES(kind), kind),
       token = IF(expires_at < NOW(), VALUES(token), token),
       expires_at = IF(expires_at < NOW(), VALUES(expires_at), expires_at)`,
    [scope_id, kind, token, config.app.content.operationLock.ttlSeconds],
  )
  const [rows] = await db.execute<LockTokenRow[]>(
    'SELECT token FROM content_locks WHERE scope_id = ? AND path = \'\'',
    [scope_id],
  )
  // A live lease is never rewritten, so the token is stable between the two
  // statements: it is either ours (we took or stole the lock) or the holder's.
  if (rows[0]?.token !== token)
    throw new ApiError(409, '操作冲突，请稍后再试')
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
  const [rows] = await db.execute<LockRow[]>(
    'SELECT kind, expires_at FROM content_locks WHERE scope_id = ? AND path = \'\' AND expires_at >= NOW()',
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
