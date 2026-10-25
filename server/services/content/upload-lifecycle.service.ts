import type { create_aliyun_oss } from '@server/lib/aliyun-oss'
import type { Connection, Pool, RowDataPacket } from 'mysql2/promise'
import type { UploadRow } from './upload-session.repository'
import { runtime_config } from '@config/loader'
import { ApiError } from '@server/errors/ApiError'
import { log_error } from '@server/lib/log'
import { enqueue_object_retirement, requeue_late_object } from './object-retirement.repository'
import { expire_transfer, upload_intent_schema } from './transfer-session.repository'
import { enqueue_workspace_change } from './workspace-sync.service'

type Options = ReturnType<typeof runtime_config>['app']['contentUploads']
type Storage = Pick<ReturnType<typeof create_aliyun_oss>, 'abort_multipart_upload' | 'list_multipart_uploads' | 'head_object'>
interface Attempt extends RowDataPacket {
  id: string
  session_id: string
  target_key: string
  upload_id: string | null
  status: string
  cleanup_required: number
}
const terminal = new Set(['cancelled', 'expired', 'failed'])

/** Session/attempt facts own cleanup; paths alone never authorize deletion. */
export function create_upload_lifecycle(pool: Pick<Pool, 'execute' | 'getConnection'>, storage: Storage, options: Options,
  cancel_image: (connection: Connection, row: UploadRow) => Promise<void>) {
  async function transaction<T>(action: (connection: Connection) => Promise<T>) {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const value = await action(connection)
      await connection.commit()
      return value
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
    finally { connection.release() }
  }
  function owned_key(attempt: Attempt) {
    if (! /^[\da-f]{32}$/.test(attempt.session_id) || ! /^[\da-f]{32}$/.test(attempt.id)
      || attempt.target_key !== `content/att/staging/${attempt.session_id}/${attempt.id}`) {
      throw new ApiError(409, '上传清理对象与账本不符')
    }
    return attempt.target_key
  }
  async function retire(connection: Connection, row: UploadRow, attempt: Attempt) {
    const key = owned_key(attempt)
    const [live] = await connection.execute<RowDataPacket[]>('SELECT id FROM content_story_attachments WHERE object_key = ? OR original_key = ? OR avif_key = ? OR jpeg_key = ? LIMIT 1 FOR UPDATE', [key, key, key, key])
    if (live.length)
      return false
    // Same scope/session locks as adoption. The tombstone prevents any later
    // adopter, while the retirement worker owns external deletion and ESA purge.
    await enqueue_object_retirement(connection, key, Number(row.scope_id), 'upload-abandoned-attempt')
    const { oss } = runtime_config().aliyun
    if (! oss)
      return false
    const [bound] = await connection.execute<RowDataPacket[]>(`SELECT object_key FROM content_object_retirements
      WHERE object_key = ? AND scope_id = ? AND storage_bucket = ? AND storage_endpoint = ? FOR UPDATE`,
    [key, Number(row.scope_id), oss.bucket, oss.endpoint])
    return bound.length > 0
  }
  async function cancel(connection: Connection, row: UploadRow) {
    await cancel_image(connection, row)
    const [attempts] = await connection.execute<Attempt[]>('SELECT * FROM content_transfer_attempts WHERE session_id = ? AND cleanup_required = 1 AND status <> \'adopted\' ORDER BY id FOR UPDATE', [row.id])
    for (const attempt of attempts)
      await retire(connection, row, attempt)
  }
  async function expire(signal?: AbortSignal) {
    if (signal?.aborted)
      return
    const [candidates] = await pool.execute<RowDataPacket[]>(`SELECT id, scope_id FROM content_transfer_sessions WHERE operation = 'upload'
      AND expires_at <= CURRENT_TIMESTAMP(3) AND status IN ('queued', 'uploading', 'running', 'verifying')
      ORDER BY expires_at, id LIMIT ${options.scanLimit}`)
    for (const candidate of candidates) {
      if (signal?.aborted)
        break
      try {
        await transaction(async (connection) => {
          await connection.execute('SELECT id FROM content_stories WHERE id = ? FOR UPDATE', [candidate.scope_id])
          const [rows] = await connection.execute<UploadRow[]>('SELECT * FROM content_transfer_sessions WHERE id = ? AND operation = \'upload\' FOR UPDATE', [candidate.id])
          const row = rows[0]
          if (! row || Number(row.scope_id) !== Number(candidate.scope_id) || ! await expire_transfer(connection, row.id))
            return null
          row.intent = upload_intent_schema.parse(typeof row.intent === 'string' ? JSON.parse(row.intent) : row.intent)
          await cancel(connection, row)
          await enqueue_workspace_change(connection, Number(row.scope_id), { upload_sessions: [String(candidate.id)] })
        })
      }
      catch { log_error('content upload expiry failed', { session_id: String(candidate.id) }) }
    }
  }
  async function cleanup(after_id = '', signal?: AbortSignal) {
    if (signal?.aborted)
      return after_id
    if (after_id && ! /^[\da-f]{32}$/.test(after_id))
      throw new ApiError(400, '上传清理游标无效')
    const [candidates] = await pool.execute<RowDataPacket[]>(`SELECT a.id, a.session_id, s.scope_id FROM content_transfer_attempts a
      JOIN content_transfer_sessions s ON s.id = a.session_id WHERE s.operation = 'upload' AND a.id > ?
      AND a.cleanup_required = 1 AND a.status <> 'adopted'
      AND (s.status IN ('cancelled', 'expired', 'failed') OR NOT (a.id <=> s.active_attempt_id))
      ORDER BY a.id LIMIT ${options.scanLimit}`, [after_id])
    for (const candidate of candidates) {
      if (signal?.aborted)
        return after_id
      try {
        const target = await transaction(async (connection) => {
          await connection.execute('SELECT id FROM content_stories WHERE id = ? FOR UPDATE', [candidate.scope_id])
          const [rows] = await connection.execute<UploadRow[]>('SELECT * FROM content_transfer_sessions WHERE id = ? AND operation = \'upload\' FOR UPDATE', [candidate.session_id])
          const row = rows[0]
          if (! row || row.target_location !== 'aliyun' || Number(row.scope_id) !== Number(candidate.scope_id))
            return null
          const [attempts] = await connection.execute<Attempt[]>('SELECT * FROM content_transfer_attempts WHERE id = ? AND session_id = ? FOR UPDATE', [candidate.id, row.id])
          const attempt = attempts[0]
          if (! attempt || ! Number(attempt.cleanup_required) || attempt.status === 'adopted'
            || (! terminal.has(row.status) && row.active_attempt_id === attempt.id)) {
            return null
          }
          // Lazy reservation expiry may have invalidated the session already.
          if (terminal.has(row.status)) {
            row.intent = upload_intent_schema.parse(typeof row.intent === 'string' ? JSON.parse(row.intent) : row.intent)
            await cancel_image(connection, row)
          }
          if (! await retire(connection, row, attempt))
            return null
          return { key: attempt.target_key, upload: attempt.upload_id, scope: Number(row.scope_id) }
        })
        if (! target)
          continue
        // Keep facts after 404, abort failures and successful deletion: init or
        // Complete may still arrive late. Each pass is bounded and replayable.
        const uploads = new Set(target.upload ? [target.upload] : [])
        try {
          for (const upload of await storage.list_multipart_uploads(target.key))
            uploads.add(upload)
        }
        catch { log_error('content upload multipart discovery failed', { attempt_id: String(candidate.id) }) }
        for (const upload of uploads) {
          try {
            await storage.abort_multipart_upload(target.key, upload)
          }
          catch (error) {
            if ((error as { status?: number }).status !== 404)
              log_error('content upload multipart abort failed', { attempt_id: String(candidate.id) })
          }
        }
        try {
          await storage.head_object(target.key)
        }
        catch (error) {
          if ((error as { status?: number }).status === 404)
            continue
          throw error
        }
        // A completed retirement is still an adoption tombstone. Re-arm only
        // its deletion duty when an already-sent Complete resurrects the key.
        await transaction(async (connection) => {
          await connection.execute('SELECT id FROM content_stories WHERE id = ? FOR UPDATE', [target.scope])
          await requeue_late_object(connection, target.key, target.scope)
        })
      }
      catch { log_error('content upload attempt cleanup failed', { attempt_id: String(candidate.id) }) }
    }
    return candidates.length === options.scanLimit ? String(candidates.at(- 1)!.id) : ''
  }
  return { cancel, expire, cleanup }
}
