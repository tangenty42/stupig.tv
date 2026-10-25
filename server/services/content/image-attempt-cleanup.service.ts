import type { create_aliyun_oss } from '@server/lib/aliyun-oss'
import type { Connection, Pool, RowDataPacket } from 'mysql2/promise'
import { runtime_config } from '@config/loader'
import { ApiError } from '@server/errors/ApiError'
import { settings } from '@shared/settings'
import { image_original_key } from './image-original-object'
import { enqueue_object_retirement, requeue_late_object } from './object-retirement.repository'

/** Attempt facts authorize retirement; the shared worker owns deletion and purge. */
export function create_image_attempt_cleanup(pool: Pick<Pool, 'getConnection'>, storage: Pick<ReturnType<typeof create_aliyun_oss>, 'head_object'>) {
  async function transaction<T>(action: (connection: Connection) => Promise<T>) {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const result = await action(connection)
      await connection.commit()
      return result
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
    finally { connection.release() }
  }
  return async function cleanup(after_id = '', signal?: AbortSignal) {
    if (signal?.aborted)
      return { pending: 0, next_cursor: after_id || null }
    if (after_id && ! /^[\da-f]{32}$/.test(after_id))
      throw new ApiError(400, '图片清理游标无效')
    const attempts = await transaction(async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT a.id, a.job_id, j.scope_id FROM content_image_attempts a JOIN content_image_jobs j ON j.id = a.job_id
        WHERE a.cleanup_required = 1 AND a.adopted = 0 AND a.id > ? AND (NOT (a.id <=> j.active_attempt_id) OR j.status IN ('cancelled', 'failed'))
        ORDER BY a.id LIMIT ${settings.app.content.workspace.batchLimit}`, [after_id])
      return rows
    })
    let pending = 0
    for (const candidate of attempts) {
      if (signal?.aborted)
        return { pending, next_cursor: after_id || null }
      const targets = await transaction(async (connection) => {
        // Same scope -> job order as adoption; discovery is not authorization.
        await connection.execute('SELECT id FROM content_stories WHERE id = ? FOR UPDATE', [candidate.scope_id])
        const [jobs] = await connection.execute<RowDataPacket[]>('SELECT * FROM content_image_jobs WHERE id = ? AND scope_id = ? FOR UPDATE', [candidate.job_id, candidate.scope_id])
        const job = jobs[0]
        if (! job || Number(job.scope_id) !== Number(candidate.scope_id))
          return []
        const [rows] = await connection.execute<RowDataPacket[]>('SELECT * FROM content_image_attempts WHERE id = ? AND job_id = ? FOR UPDATE', [candidate.id, job.id])
        const attempt = rows[0]
        if (! attempt || Number(attempt.adopted) || ! Number(attempt.cleanup_required)
          || (job.active_attempt_id === attempt.id && ! ['cancelled', 'failed'].includes(job.status))) {
          return []
        }
        const prefix = `content/att/images/${job.id}/${attempt.id}`
        if (attempt.job_id !== job.id || ! /^[\da-f]{32}$/.test(job.id) || ! /^[\da-f]{32}$/.test(attempt.id)
          || attempt.avif_key !== `${prefix}.avif` || attempt.jpeg_key !== `${prefix}.jpg`) {
          throw new ApiError(409, '图片清理对象与账本不符')
        }
        const keys: string[] = []
        for (const key of [attempt.avif_key, attempt.jpeg_key, image_original_key(job.id, attempt.id)]) {
          const [live] = await connection.execute<RowDataPacket[]>('SELECT id FROM content_story_attachments WHERE object_key = ? OR original_key = ? OR avif_key = ? OR jpeg_key = ? OR redacted_avif_key = ? OR redacted_jpeg_key = ? LIMIT 1 FOR UPDATE', [key, key, key, key, key, key])
          if (live.length) {
            pending ++
            continue
          }
          await enqueue_object_retirement(connection, key, Number(job.scope_id), 'image-abandoned-attempt')
          const { oss } = runtime_config().aliyun
          const [bound] = await connection.execute<RowDataPacket[]>(`SELECT object_key FROM content_object_retirements
            WHERE object_key = ? AND scope_id = ? AND storage_bucket = ? AND storage_endpoint = ? FOR UPDATE`,
          [key, Number(job.scope_id), oss!.bucket, oss!.endpoint])
          if (bound.length)
            keys.push(key)
          else
            pending ++
        }
        return keys
      })
      // Keep facts even after 404 or successful retirement: a cancelled worker's
      // already-sent PUT/Copy may arrive after the retirement has completed.
      for (const key of targets) {
        try {
          await storage.head_object(key)
          await transaction(async (connection) => {
            await connection.execute('SELECT id FROM content_stories WHERE id = ? FOR UPDATE', [candidate.scope_id])
            await requeue_late_object(connection, key, Number(candidate.scope_id))
          })
        }
        catch (error) {
          if ((error as { status?: number }).status !== 404)
            pending ++
        }
      }
    }
    return { pending, next_cursor: attempts.length === settings.app.content.workspace.batchLimit ? String(attempts.at(- 1)!.id) : null }
  }
}
