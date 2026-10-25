import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { createHash, randomUUID } from 'node:crypto'
import { ApiError } from '@server/errors/ApiError'
import { upload_intent_schema } from '@shared/content-upload'
import { z } from 'zod'

const id = z.string().regex(/^[\da-f]{32}$/)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const location = z.enum(['legacy_public', 'legacy_private', 'aliyun'])
const source_schema = z.strictObject({
  attachment_id: integer.positive(), revision: z.string().min(1).max(255),
  location, key: z.string().min(1).max(512), etag: z.string().min(1).max(255),
  oss_version_id: z.string().min(1).max(255).nullable(), sha256: z.string().regex(/^[\da-f]{64}$/).nullable(),
})
const copy_intent_schema = z.strictObject({
  scope_id: integer, operation: z.enum(['copy', 'restore']),
  target_path: z.string().min(1).max(255), target_location: location,
  target_access: z.enum(['public', 'private']), expected_size: integer,
  source: source_schema,
})
export { upload_intent_schema }
const intent_schema = z.union([copy_intent_schema, upload_intent_schema])

type Intent = z.infer<typeof intent_schema>
export interface TransferClaim { id: string, executor_id: string, epoch: number }
interface SessionRow extends RowDataPacket {
  id: string
  actor_id: number
  fingerprint: string
  intent: Intent | string
  status: 'uploading' | 'queued' | 'running' | 'verifying' | 'completed' | 'cancelled' | 'failed' | 'expired'
  execution_epoch: number
  active_attempt_id: string | null
  expected_size: number
  expired: number
  result: object | string | null
}

const terminal = new Set(['completed', 'cancelled', 'failed', 'expired'])
function conflict() {
  return new ApiError(409, '传输会话状态或执行权已变化')
}
function claim_values(claim: TransferClaim) {
  return [id.parse(claim.id), id.parse(claim.executor_id), integer.positive().parse(claim.epoch)]
}
// Every mutation is called inside the caller's transaction. Business services
// lock/authorize the scope first, then this session; no storage I/O in that tx.
// This repository is not an authorized API or a background worker.
const fence = `id = ? AND executor_id = ? AND execution_epoch = ?
  AND status IN ('running', 'verifying') AND lease_until > CURRENT_TIMESTAMP(3)
  AND expires_at > CURRENT_TIMESTAMP(3)`

async function touch(connection: Connection, claim: TransferClaim) {
  const [result] = await connection.execute<ResultSetHeader>(`UPDATE content_transfer_sessions SET revision = revision + 1 WHERE ${fence}`, claim_values(claim))
  if (result.affectedRows !== 1)
    throw conflict()
}

async function active_attempt(connection: Connection, claim: TransferClaim, attempt_id: string) {
  // Locks session before attempt/parts. Recheck DB time at the end with touch.
  const [sessions] = await connection.execute<SessionRow[]>(`SELECT * FROM content_transfer_sessions WHERE ${fence} FOR UPDATE`, claim_values(claim))
  const session = sessions[0]
  if (! session || session.active_attempt_id !== id.parse(attempt_id))
    throw conflict()
  const [attempts] = await connection.execute<RowDataPacket[]>('SELECT * FROM content_transfer_attempts WHERE id = ? AND session_id = ? AND execution_epoch = ? FOR UPDATE', [attempt_id, claim.id, claim.epoch])
  if (! attempts[0] || attempts[0].cleanup_required)
    throw conflict()
  return { session, attempt: attempts[0] }
}

/** Stable, strict intent fingerprint; retries never accept a different body. */
export async function accept_transfer(connection: Connection, actor_id: number, request_id: string, input: Intent, lifetime_seconds: number) {
  integer.positive().parse(actor_id)
  z.uuid().parse(request_id)
  z.number().int().min(1).max(604_800).parse(lifetime_seconds)
  const intent = intent_schema.parse(input)
  const encoded = JSON.stringify(intent)
  const fingerprint = createHash('sha256').update(encoded).digest('hex')
  const session_id = randomUUID().replaceAll('-', '')
  try {
    await connection.execute(`INSERT INTO content_transfer_sessions
      (id, actor_id, request_id, fingerprint, scope_id, operation, intent, target_path, target_location, expected_size, status, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3)))`,
    [session_id, actor_id, request_id, fingerprint, intent.scope_id, intent.operation, encoded, intent.target_path, intent.target_location, intent.expected_size, 'queued', lifetime_seconds])
  }
  catch (error) {
    if ((error as { code?: string }).code !== 'ER_DUP_ENTRY')
      throw error
    // Either a receipt collision or a live target reservation. Never adopt the
    // other request just because its destination name happens to be the same.
  }
  const [rows] = await connection.execute<SessionRow[]>('SELECT *, expires_at <= CURRENT_TIMESTAMP(3) AS expired FROM content_transfer_sessions WHERE actor_id = ? AND request_id = ? FOR UPDATE', [actor_id, request_id])
  const row = rows[0]
  if (! row)
    throw new ApiError(409, '目标名称已被其他传输预约')
  if (row.fingerprint !== fingerprint)
    throw new ApiError(409, '同一请求标识不能用于不同的传输内容')
  if (row.expired)
    throw new ApiError(409, '传输请求已过期，请重新确认状态')
  return row
}

/** Conditional claim uses DB time; competing scanners cannot both win. */
export async function claim_transfer(connection: Connection, session_id: string, executor_id: string, lease_seconds: number, max_claims: number) {
  id.parse(session_id)
  id.parse(executor_id)
  z.number().int().min(1).max(600).parse(lease_seconds)
  z.number().int().min(1).max(1000).parse(max_claims)
  const [result] = await connection.execute<ResultSetHeader>(`UPDATE content_transfer_sessions
    SET executor_id = ?, execution_epoch = execution_epoch + 1, claim_count = claim_count + 1,
      lease_until = LEAST(expires_at, TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3))), status = 'running', revision = revision + 1
    WHERE id = ? AND status IN ('queued', 'running', 'verifying') AND expires_at > CURRENT_TIMESTAMP(3)
      AND next_run_at <= CURRENT_TIMESTAMP(3) AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP(3)) AND claim_count < ?`,
  [executor_id, lease_seconds, session_id, max_claims])
  if (result.affectedRows !== 1)
    return null
  const [rows] = await connection.execute<SessionRow[]>('SELECT execution_epoch FROM content_transfer_sessions WHERE id = ?', [session_id])
  return { id: session_id, executor_id, epoch: Number(rows[0]!.execution_epoch) }
}

export async function heartbeat_transfer(connection: Connection, claim: TransferClaim, lease_seconds: number) {
  z.number().int().min(1).max(600).parse(lease_seconds)
  const [result] = await connection.execute<ResultSetHeader>(`UPDATE content_transfer_sessions
    SET lease_until = LEAST(expires_at, TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3))), revision = revision + 1 WHERE ${fence}`,
  [lease_seconds, ... claim_values(claim)])
  if (result.affectedRows !== 1)
    throw conflict()
}

/** Each new executor attempt gets a different key, isolating late OSS writes. */
export async function create_transfer_attempt(connection: Connection, claim: TransferClaim, part_size: number) {
  z.number().int().min(100 * 1024).max(5 * 1024 ** 3).parse(part_size)
  await touch(connection, claim)
  const [sessions] = await connection.execute<SessionRow[]>('SELECT expected_size, operation FROM content_transfer_sessions WHERE id = ?', [claim.id])
  if (Math.ceil(Number(sessions[0]!.expected_size) / part_size) > 10_000)
    throw new ApiError(409, '分片计划超过存储服务上限')
  const attempt_id = randomUUID().replaceAll('-', '')
  const key = `content/att/${sessions[0]!.operation === 'upload' ? 'staging' : 'transfers'}/${claim.id}/${attempt_id}`
  await connection.execute('UPDATE content_transfer_attempts SET cleanup_required = 1 WHERE session_id = ? AND status <> \'adopted\'', [claim.id])
  await connection.execute('INSERT INTO content_transfer_attempts (id, session_id, execution_epoch, target_key, part_size) VALUES (?, ?, ?, ?, ?)', [attempt_id, claim.id, claim.epoch, key, part_size])
  const [result] = await connection.execute<ResultSetHeader>(`UPDATE content_transfer_sessions SET active_attempt_id = ?, revision = revision + 1 WHERE ${fence}`, [attempt_id, ... claim_values(claim)])
  if (result.affectedRows !== 1)
    throw conflict()
  return { id: attempt_id, key }
}

export async function attach_transfer_upload(connection: Connection, claim: TransferClaim, attempt_id: string, upload_id: string) {
  z.string().min(1).max(4096).parse(upload_id)
  const { attempt } = await active_attempt(connection, claim, attempt_id)
  if (attempt.upload_id && attempt.upload_id !== upload_id)
    throw conflict()
  if (attempt.status === 'verified' || attempt.status === 'adopted')
    throw conflict()
  await connection.execute('UPDATE content_transfer_attempts SET upload_id = ?, status = \'uploading\', revision = revision + 1 WHERE id = ?', [upload_id, attempt_id])
  await touch(connection, claim)
}

export async function record_transfer_part(connection: Connection, claim: TransferClaim, attempt_id: string, part: { number: number, size: number, etag: string }) {
  z.strictObject({ number: z.number().int().min(1).max(10_000), size: integer.positive(), etag: z.string().min(1).max(255) }).parse(part)
  const { session, attempt } = await active_attempt(connection, claim, attempt_id)
  const offset = (part.number - 1) * Number(attempt.part_size)
  const expected = Math.min(Number(attempt.part_size), Number(session.expected_size) - offset)
  if (! attempt.upload_id || attempt.status !== 'uploading' || expected <= 0 || part.size !== expected)
    throw new ApiError(409, '分片与固定传输计划不符')
  const [parts] = await connection.execute<RowDataPacket[]>('SELECT * FROM content_transfer_parts WHERE attempt_id = ? AND part_number = ?', [attempt_id, part.number])
  if (parts[0]) {
    if (parts[0].etag !== part.etag || Number(parts[0].byte_length) !== part.size || Number(parts[0].range_start) !== offset)
      throw new ApiError(409, '已确认分片不能被不同结果覆盖')
  }
  else {
    await connection.execute('INSERT INTO content_transfer_parts (attempt_id, part_number, range_start, byte_length, etag) VALUES (?, ?, ?, ?, ?)', [attempt_id, part.number, offset, part.size, part.etag])
  }
  await touch(connection, claim)
}

export async function verify_transfer_attempt(connection: Connection, claim: TransferClaim, attempt_id: string, identity: { size: number, etag: string, oss_version_id: string, sha256: string }) {
  z.strictObject({ size: integer, etag: z.string().min(1).max(255), oss_version_id: z.string().min(1).max(255), sha256: z.string().regex(/^[\da-f]{64}$/) }).parse(identity)
  const { session, attempt } = await active_attempt(connection, claim, attempt_id)
  const intent: Intent = typeof session.intent === 'string' ? JSON.parse(session.intent) : session.intent
  const expected_sha256 = intent.operation === 'upload' ? intent.sha256 : intent.source.sha256
  if (Number(session.expected_size) !== identity.size || (expected_sha256 && expected_sha256 !== identity.sha256))
    throw new ApiError(409, '完整对象与固定传输计划不符')
  if (attempt.upload_id) {
    const [parts] = await connection.execute<RowDataPacket[]>('SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS bytes FROM content_transfer_parts WHERE attempt_id = ?', [attempt_id])
    if (Number(parts[0]!.count) !== Math.ceil(identity.size / Number(attempt.part_size)) || Number(parts[0]!.bytes) !== identity.size)
      throw new ApiError(409, '传输分片检查点不完整')
  }
  await connection.execute('UPDATE content_transfer_attempts SET status = \'verified\', object_etag = ?, oss_version_id = ?, sha256 = ?, revision = revision + 1 WHERE id = ?', [identity.etag, identity.oss_version_id, identity.sha256, attempt_id])
  const [result] = await connection.execute<ResultSetHeader>(`UPDATE content_transfer_sessions SET status = 'verifying', revision = revision + 1 WHERE ${fence}`, claim_values(claim))
  if (result.affectedRows !== 1)
    throw conflict()
}

/** Caller publishes attachment/reference changes in THIS SAME transaction. */
export async function complete_transfer_in_transaction(connection: Connection, claim: TransferClaim, attempt_id: string, result: { attachment_id: number, object_key: string, version: string }) {
  z.strictObject({ attachment_id: integer.positive(), object_key: z.string().min(1).max(512), version: z.string().min(1).max(255) }).parse(result)
  const { attempt } = await active_attempt(connection, claim, attempt_id)
  if (attempt.status !== 'verified' || attempt.target_key !== result.object_key || attempt.object_etag !== result.version)
    throw conflict()
  const [updated] = await connection.execute<ResultSetHeader>(`UPDATE content_transfer_sessions SET status = 'completed', result = CAST(? AS JSON),
    executor_id = NULL, lease_until = NULL, revision = revision + 1 WHERE ${fence} AND status = 'verifying'`, [JSON.stringify(result), ... claim_values(claim)])
  if (updated.affectedRows !== 1)
    throw conflict()
  await connection.execute('UPDATE content_transfer_attempts SET status = \'adopted\', cleanup_required = 0, revision = revision + 1 WHERE id = ?', [attempt_id])
}

/** Terminal cancellation invalidates the executor; cleanup is a separate fact. */
export async function cancel_transfer(connection: Connection, session_id: string, actor_id: number) {
  id.parse(session_id)
  integer.positive().parse(actor_id)
  const [rows] = await connection.execute<SessionRow[]>('SELECT * FROM content_transfer_sessions WHERE id = ? AND actor_id = ? FOR UPDATE', [session_id, actor_id])
  const row = rows[0]
  if (! row)
    throw new ApiError(404, '传输会话不存在')
  if (terminal.has(row.status))
    return row
  await connection.execute(`UPDATE content_transfer_sessions SET status = 'cancelled', execution_epoch = execution_epoch + 1,
    executor_id = NULL, lease_until = NULL, revision = revision + 1 WHERE id = ?`, [session_id])
  await connection.execute('UPDATE content_transfer_attempts SET cleanup_required = 1 WHERE session_id = ? AND status <> \'adopted\'', [session_id])
  const [updated] = await connection.execute<SessionRow[]>('SELECT * FROM content_transfer_sessions WHERE id = ?', [session_id])
  return updated[0]!
}

/** Expiry keeps the receipt tombstone and durable cleanup targets. */
export async function expire_transfer(connection: Connection, session_id: string) {
  id.parse(session_id)
  const [result] = await connection.execute<ResultSetHeader>(`UPDATE content_transfer_sessions SET status = 'expired', execution_epoch = execution_epoch + 1,
    executor_id = NULL, lease_until = NULL, revision = revision + 1
    WHERE id = ? AND expires_at <= CURRENT_TIMESTAMP(3) AND status IN ('uploading', 'queued', 'running', 'verifying')`, [session_id])
  if (result.affectedRows)
    await connection.execute('UPDATE content_transfer_attempts SET cleanup_required = 1 WHERE session_id = ? AND status <> \'adopted\'', [session_id])
  return result.affectedRows === 1
}
