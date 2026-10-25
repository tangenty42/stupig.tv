import type { runtime_config } from '@config/loader'
import type { create_aliyun_oss } from '@server/lib/aliyun-oss'
import type { ContentUploadSession } from '@shared/types/content-upload'
import type { Connection, Pool, RowDataPacket } from 'mysql2/promise'
import type { UploadRow } from './upload-session.repository'
import type { create_upload_sessions } from './upload-session.service'
import { ApiError } from '@server/errors/ApiError'
import { create_image_jobs } from './image-job.service'
import { publish_uploaded_attachment } from './upload-publication.service'

type Options = ReturnType<typeof runtime_config>['app']['contentImages']
/** Upload reservation and image intent are committed together, before any encoding. */
export function create_upload_images(pool: Pick<Pool, 'execute' | 'getConnection'>, storage: ReturnType<typeof create_aliyun_oss>, options: Options) {
  const jobs = create_image_jobs(pool, storage, options.leaseSeconds, options.heartbeatSeconds)
  async function sealed(connection: Connection, row: UploadRow) {
    if (! row.intent.image)
      return
    if (! options.enabled)
      throw new ApiError(503, '图片处理暂未启用')
    const input = row.result
    if (! input || ! ('key' in input))
      throw new ApiError(409, '上传对象尚未就绪')
    const request = `${row.id.slice(0, 8)}-${row.id.slice(8, 12)}-${row.id.slice(12, 16)}-${row.id.slice(16, 20)}-${row.id.slice(20)}`
    const job = await jobs.enqueue_in_transaction(connection, request, {
      scope_id: Number(row.scope_id), actor_id: Number(row.actor_id), ... row.intent.image,
      is_private: row.intent.target_access === 'private',
      input: { key: input.key, etag: input.etag, version_id: input.oss_version_id, size: input.size, sha256: input.sha256 },
      profile_version: options.profileVersion, profile: options.profile,
    })
    await connection.execute('INSERT IGNORE INTO content_upload_images (session_id, job_id) VALUES (?, ?)', [row.id, job.id])
  }
  async function cancel(connection: Connection, row: UploadRow) {
    if (! row.intent.image)
      return
    await connection.execute(`UPDATE content_image_jobs j JOIN content_upload_images u ON u.job_id = j.id
      SET j.status = 'cancelled', j.execution_epoch = j.execution_epoch + 1, j.lease_until = NULL, j.executor_id = NULL
      WHERE u.session_id = ? AND j.actor_id = ? AND j.status NOT IN ('completed', 'cancelled')`, [row.id, row.actor_id])
  }
  async function state(value: ContentUploadSession) {
    const [rows] = await pool.execute<RowDataPacket[]>(`SELECT j.status, j.result FROM content_upload_images u JOIN content_image_jobs j ON j.id = u.job_id WHERE u.session_id = ?`, [value.id])
    const result = typeof rows[0]?.result === 'string' ? JSON.parse(rows[0].result) : rows[0]?.result
    return rows[0] ? { ... value, image_status: String(rows[0].status), ... (rows[0].status === 'failed' ? { image_error: typeof result?.error_message === 'string' ? result.error_message : '图片发布失败，请重试；来源或权限变化时需取消后重新操作' } : {}) } : value
  }
  async function publish(connection: Connection, row: UploadRow) {
    if (! row.intent.image)
      return publish_uploaded_attachment(connection, row)
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT j.* FROM content_upload_images u JOIN content_image_jobs j ON j.id = u.job_id WHERE u.session_id = ?`, [row.id])
    const job = rows[0]
    if (! job || ! ['ready', 'completed'].includes(job.status))
      throw new ApiError(409, '图片仍在处理或处理失败，请查看上传状态')
    const result = typeof job.result === 'string' ? JSON.parse(job.result) : job.result
    return publish_uploaded_attachment(connection, row, { key: result.avif.key, etag: result.avif.etag,
      adopt: (connection, attachment, revision) => jobs.adopt(connection, job.id, row.actor_id, attachment, revision) })
  }
  async function retry(session: string, actor: number) {
    const [rows] = await pool.execute<RowDataPacket[]>(`SELECT j.id, j.status FROM content_upload_images u JOIN content_image_jobs j ON j.id = u.job_id WHERE u.session_id = ? AND j.actor_id = ?`, [session, actor])
    if (rows[0]?.status === 'failed')
      await jobs.retry(String(rows[0].id), actor, options.profile)
  }
  async function sweep(uploads: ReturnType<typeof create_upload_sessions>, signal?: AbortSignal) {
    if (! options.enabled || signal?.aborted)
      return
    const [rows] = await pool.execute<RowDataPacket[]>(`SELECT s.id, s.actor_id, s.scope_id, j.id AS job_id, j.status AS image_status, j.execution_epoch AS image_epoch
      FROM content_transfer_sessions s JOIN content_upload_images u ON u.session_id = s.id JOIN content_image_jobs j ON j.id = u.job_id
      WHERE s.status = 'verifying' AND s.expires_at > CURRENT_TIMESTAMP(3) AND (j.status IN ('queued', 'ready') OR (j.status = 'processing' AND j.lease_until <= CURRENT_TIMESTAMP(3)))
      ORDER BY j.updated_at LIMIT ${options.scanLimit}`)
    const queue = [... rows]
    await Promise.all(Array.from({ length: Math.min(options.concurrency, queue.length) }, async () => {
      while (queue.length && ! signal?.aborted) {
        const row = queue.shift()!
        let failure_epoch = Number(row.image_epoch)
        try {
          if (row.image_status !== 'ready') {
            await jobs.run(row.job_id, Number(row.actor_id))
            const [current] = await pool.execute<RowDataPacket[]>('SELECT execution_epoch FROM content_image_jobs WHERE id = ?', [row.job_id])
            failure_epoch = Number(current[0]?.execution_epoch)
          }
          await uploads.adopt(row.id, Number(row.actor_id), publish)
        }
        catch {
          // Busy/late workers may not fail another worker. A terminal failure is
          // visible and explicitly retryable; never automatically loop a bad image.
          await jobs.fail_publication(row.job_id, failure_epoch, Number(row.scope_id))
        }
      }
    }))
  }
  return { sealed, cancel, state, publish, retry, sweep, jobs }
}
