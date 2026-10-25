import type { Connection, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'
import { z } from 'zod'
import { upload_intent_schema } from './transfer-session.repository'
import { workspace_change_schema } from './workspace-change'

export const upload_publication_schema = z.object({
  attachment_id: z.number().int().positive(), object_key: z.string(), version: z.string(),
  refresh: workspace_change_schema.optional(),
})
export type UploadPublication = z.infer<typeof upload_publication_schema>

export type UploadIntent = z.infer<typeof upload_intent_schema>
export interface UploadRow extends RowDataPacket {
  id: string
  actor_id: number
  scope_id: number
  intent: UploadIntent
  status: string
  expected_size: number
  active_attempt_id: string | null
  execution_epoch: number
  remaining_seconds: number
  busy: number
  result: null | { key: string, etag: string, oss_version_id: string, sha256: string, size: number } | UploadPublication
}
export interface UploadAttempt extends RowDataPacket {
  id: string
  target_key: string
  upload_id: string | null
  part_size: number
  execution_epoch: number
  cleanup_required: number
}

/** Caller holds scope/actor authorization locks first, then session and attempt. */
export async function get_upload(connection: Connection, session_id: string, actor_id: number) {
  const [rows] = await connection.execute<UploadRow[]>(`SELECT *,
    TIMESTAMPDIFF(SECOND, CURRENT_TIMESTAMP(3), expires_at) AS remaining_seconds,
    lease_until > CURRENT_TIMESTAMP(3) AS busy
    FROM content_transfer_sessions WHERE id = ? AND actor_id = ? AND operation = 'upload' FOR UPDATE`, [session_id, actor_id])
  const row = rows[0]
  if (! row)
    throw new ApiError(404, '上传会话不存在')
  if (row.remaining_seconds <= 0 && ! ['completed', 'cancelled', 'expired', 'failed'].includes(row.status))
    throw new ApiError(409, '上传会话已过期', { code: 'UPLOAD_SESSION_EXPIRED' })
  row.intent = upload_intent_schema.parse(typeof row.intent === 'string' ? JSON.parse(row.intent) : row.intent)
  row.result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result
  return row
}

export async function get_upload_attempt(connection: Connection, session: UploadRow) {
  const [rows] = await connection.execute<UploadAttempt[]>('SELECT * FROM content_transfer_attempts WHERE id = ? AND session_id = ? FOR UPDATE', [session.active_attempt_id, session.id])
  const attempt = rows[0]
  if (! attempt || attempt.cleanup_required)
    throw new ApiError(409, '上传尝试已失效')
  return attempt
}

export async function release_upload(connection: Connection, session_id: string, executor: string, epoch: number, ready: boolean) {
  const [updated] = await connection.execute(`UPDATE content_transfer_sessions SET status = ?, executor_id = NULL,
    lease_until = NULL, revision = revision + 1 WHERE id = ? AND executor_id = ? AND execution_epoch = ?
    AND status IN ('running', 'verifying') AND lease_until > CURRENT_TIMESTAMP(3) AND expires_at > CURRENT_TIMESTAMP(3)`,
  [ready ? 'verifying' : 'uploading', session_id, executor, epoch])
  if ((updated as { affectedRows: number }).affectedRows !== 1)
    throw new ApiError(409, '上传会话执行权已变化')
}

/** Resume completion on the same immutable part commitments; never reinitialize it. */
export async function claim_upload_completion(connection: Connection, session: UploadRow, executor: string, lease_seconds: number) {
  if (! ['uploading', 'running', 'verifying'].includes(session.status) || session.busy || session.result)
    throw new ApiError(409, '上传会话暂时不能完成')
  const epoch = Number(session.execution_epoch) + 1
  await connection.execute(`UPDATE content_transfer_sessions SET status = 'running', executor_id = ?, execution_epoch = ?,
    lease_until = LEAST(expires_at, TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3))), revision = revision + 1 WHERE id = ?`,
  [executor, epoch, lease_seconds, session.id])
  await connection.execute('UPDATE content_transfer_attempts SET execution_epoch = ? WHERE id = ? AND session_id = ?', [epoch, session.active_attempt_id, session.id])
  return { id: session.id, executor_id: executor, epoch }
}

/** Reserve a fixed checksum BEFORE issuing a URL. A retry cannot change bytes. */
export async function reserve_upload_part(connection: Connection, session: UploadRow, attempt: UploadAttempt, number: number, md5: string) {
  if (session.status !== 'uploading' || ! attempt.upload_id)
    throw new ApiError(409, '上传会话当前不可写入')
  const size = Math.min(Number(attempt.part_size), Number(session.expected_size) - (number - 1) * Number(attempt.part_size))
  if (! Number.isInteger(number) || number < 1 || number > 10_000 || size <= 0
    || ! /^[A-Z0-9+/]{22}==$/i.test(md5) || Buffer.from(md5, 'base64').toString('base64') !== md5) {
    throw new ApiError(400, '分片与上传计划不符')
  }
  const [rows] = await connection.execute<RowDataPacket[]>('SELECT * FROM content_upload_part_grants WHERE attempt_id = ? AND part_number = ?', [attempt.id, number])
  if (rows[0] && (Number(rows[0].byte_length) !== size || rows[0].content_md5 !== md5))
    throw new ApiError(409, '已签发分片不能更改内容，请重新创建上传')
  if (! rows[0])
    await connection.execute('INSERT INTO content_upload_part_grants (attempt_id, part_number, byte_length, content_md5) VALUES (?, ?, ?, ?)', [attempt.id, number, size, md5])
  return size
}

/** OSS, not a client checkpoint, confirms bytes. The ETag of UploadPart is MD5. */
export async function confirm_upload_parts(connection: Connection, session: UploadRow, attempt: UploadAttempt, parts: { part_number: number, size: number, etag: string }[]) {
  if (! ['uploading', 'running'].includes(session.status) || ! attempt.upload_id)
    throw new ApiError(409, '上传会话不能记录分片')
  const [grants] = await connection.execute<RowDataPacket[]>('SELECT * FROM content_upload_part_grants WHERE attempt_id = ?', [attempt.id])
  const expected = new Map(grants.map(row => [Number(row.part_number), row]))
  for (const part of parts) {
    const grant = expected.get(part.part_number)
    if (! grant || Number(grant.byte_length) !== part.size || Buffer.from(grant.content_md5, 'base64').toString('hex') !== part.etag.toLowerCase())
      throw new ApiError(409, 'OSS 分片与已签发内容不符')
    const [existing] = await connection.execute<RowDataPacket[]>('SELECT etag, byte_length FROM content_transfer_parts WHERE attempt_id = ? AND part_number = ?', [attempt.id, part.part_number])
    if (existing[0] && (existing[0].etag !== part.etag || Number(existing[0].byte_length) !== part.size))
      throw new ApiError(409, '已确认分片发生变化')
    if (! existing[0])
      await connection.execute('INSERT INTO content_transfer_parts (attempt_id, part_number, range_start, byte_length, etag) VALUES (?, ?, ?, ?, ?)', [attempt.id, part.part_number, (part.part_number - 1) * Number(attempt.part_size), part.size, part.etag])
  }
}

/** A later business publisher must adopt the ready object in its own transaction. */
export async function adopt_upload_in_transaction(connection: Connection, session: UploadRow, result: UploadPublication) {
  const attempt = await get_upload_attempt(connection, session)
  if (session.status !== 'verifying' || ! session.result)
    throw new ApiError(409, '上传尚未验证或发布对象不一致')
  if (session.intent.image) {
    const [jobs] = await connection.execute<RowDataPacket[]>(`SELECT j.result, j.attachment_id FROM content_upload_images u JOIN content_image_jobs j ON j.id = u.job_id
      WHERE u.session_id = ? AND j.status = 'completed' AND j.actor_id = ?`, [session.id, session.actor_id])
    const image = typeof jobs[0]?.result === 'string' ? JSON.parse(jobs[0].result) : jobs[0]?.result
    if (Number(jobs[0]?.attachment_id) !== result.attachment_id || image?.avif?.key !== result.object_key || image?.avif?.etag !== result.version)
      throw new ApiError(409, '图片发布回执与上传会话不一致')
  }
  else if (! ('key' in session.result) || session.result.key !== result.object_key || session.result.etag !== result.version) {
    throw new ApiError(409, '上传尚未验证或发布对象不一致')
  }
  if (! Number.isSafeInteger(result.attachment_id) || result.attachment_id < 1)
    throw new ApiError(400, '附件标识无效')
  await connection.execute(`UPDATE content_transfer_sessions SET status = 'completed', result = CAST(? AS JSON), revision = revision + 1 WHERE id = ?`, [JSON.stringify(result), session.id])
  await connection.execute('UPDATE content_transfer_attempts SET status = \'adopted\', cleanup_required = 0 WHERE id = ?', [attempt.id])
}
