import type { create_aliyun_oss } from '@server/lib/aliyun-oss'
import type { ContentUploadReservation, ContentUploadSession } from '@shared/types/content-upload'
import type { Connection, Pool, RowDataPacket } from 'mysql2/promise'
import type { UploadAttempt, UploadIntent, UploadPublication, UploadRow } from './upload-session.repository'
import { createHash, randomUUID } from 'node:crypto'
import { ApiError } from '@server/errors/ApiError'
import { attachment_path_violation, redactable_attachment_mime } from '@shared/content-markdown'
import { redaction_image_mime } from '@shared/content-upload'
import { z } from 'zod'
import { accept_transfer, attach_transfer_upload, cancel_transfer, claim_transfer, create_transfer_attempt, expire_transfer, heartbeat_transfer, upload_intent_schema, verify_transfer_attempt } from './transfer-session.repository'
import { adopt_upload_in_transaction, claim_upload_completion, confirm_upload_parts, get_upload, get_upload_attempt, release_upload, reserve_upload_part, upload_publication_schema } from './upload-session.repository'
import { legacy_workspace_change } from './workspace-change'
import { enqueue_workspace_change } from './workspace-sync.service'

interface Dependencies {
  pool: Pick<Pool, 'getConnection'>
  storage: ReturnType<typeof create_aliyun_oss>
  target: ContentUploadSession['target']
  /** Rechecks current actor grants and locks the scope, before locking the session. */
  authorize: (connection: Connection, actor: number, intent: Pick<UploadIntent, 'scope_id' | 'target_access'> & Partial<Pick<UploadIntent, 'source' | 'replacement' | 'purpose'>>) => Promise<void>
  limits: { part_size: number, max_size: number, lifetime_seconds: number, lease_seconds: number, heartbeat_seconds: number, url_ttl_seconds: number }
  on_sealed?: (connection: Connection, row: UploadRow) => Promise<void>
  on_cancel?: (connection: Connection, row: UploadRow) => Promise<void>
}

/** Request-independent state; no in-memory map owns an upload or its receipts. */
export function create_upload_sessions({ pool, storage, target, authorize, limits, on_sealed, on_cancel }: Dependencies) {
  z.object({ part_size: z.number().int().min(100 * 1024).max(5 * 1024 ** 3), max_size: z.number().int().positive(),
    lifetime_seconds: z.number().int().min(1).max(604_800), lease_seconds: z.number().int().min(1).max(600),
    heartbeat_seconds: z.number().positive(), url_ttl_seconds: z.number().int().min(1).max(604_800) })
    .refine(value => value.heartbeat_seconds < value.lease_seconds).parse(limits)
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
    finally {
      connection.release()
    }
  }
  async function owned<T>(session_id: string, actor: number, action: (connection: Connection, row: UploadRow) => Promise<T>) {
    z.string().regex(/^[\da-f]{32}$/).parse(session_id)
    z.number().int().positive().parse(actor)
    return transaction(async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>('SELECT intent FROM content_transfer_sessions WHERE id = ? AND actor_id = ? AND operation = \'upload\'', [session_id, actor])
      if (! rows[0])
        throw new ApiError(404, '上传会话不存在')
      const intent = upload_intent_schema.parse(typeof rows[0].intent === 'string' ? JSON.parse(rows[0].intent) : rows[0].intent)
      await authorize(connection, actor, intent)
      return action(connection, await get_upload(connection, session_id, actor))
    })
  }
  const public_state = (row: UploadRow, attempt: UploadAttempt | null, parts: ContentUploadSession['parts'] = []): ContentUploadSession => ({
    id: row.id, scope_id: Number(row.scope_id), status: row.result && row.status === 'verifying' ? 'ready' : row.status,
    path: String(row.target_path ?? row.intent.target_path), size: Number(row.expected_size), sha256: row.intent.sha256,
    parent_id: row.intent.target_parent_id, source_id: row.intent.source?.id, replacement_id: row.intent.replacement?.id, purpose: row.intent.purpose,
    expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at), revision: Number(row.revision),
    key: attempt?.target_key ?? null, upload_id: attempt?.upload_id ?? null, part_size: attempt ? Number(attempt.part_size) : null, parts,
    target, object_etag: row.result && 'etag' in row.result ? row.result.etag : null,
  })
  async function snapshot(session: string, actor: number) {
    return owned(session, actor, async (connection, row) => {
      const attempt = row.active_attempt_id && ! ['cancelled', 'expired', 'failed'].includes(row.status) ? await get_upload_attempt(connection, row) : null
      return { row, attempt }
    })
  }
  async function get(session: string, actor: number) {
    return owned(session, actor, async (connection, row) => {
      const attempt = row.active_attempt_id && ! ['cancelled', 'expired', 'failed'].includes(row.status) ? await get_upload_attempt(connection, row) : null
      const [parts] = attempt ? await connection.execute<RowDataPacket[]>('SELECT part_number, byte_length, etag FROM content_transfer_parts WHERE attempt_id = ? ORDER BY part_number', [attempt.id]) : [[]]
      return public_state(row, attempt, parts.map(part => ({ part_number: Number(part.part_number), size: Number(part.byte_length), etag: String(part.etag) })))
    })
  }
  async function list(scope: number, actor: number) {
    const ids = await transaction(async (connection) => {
      await authorize(connection, actor, { scope_id: scope, target_access: 'public' })
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id FROM content_transfer_sessions
        WHERE scope_id = ? AND actor_id = ? AND operation = 'upload' AND expires_at > CURRENT_TIMESTAMP(3)
        AND status IN ('queued', 'running', 'uploading', 'verifying') ORDER BY created_at`, [scope, actor])
      return rows.map(row => String(row.id))
    })
    const states: ContentUploadSession[] = []
    for (const id of ids) {
      try {
        const state = await get(id, actor)
        if (! ['cancelled', 'expired', 'failed', 'completed'].includes(state.status))
          states.push(state)
      }
      catch (error) {
        if (! (error instanceof ApiError) || ! [404, 409].includes(error.statusCode))
          throw error
      }
    }
    return states
  }
  async function reservations(scope: number, actor: number) {
    return transaction(async (connection) => {
      await authorize(connection, actor, { scope_id: scope, target_access: 'public' })
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id, target_parent_id, target_path, source_attachment_id, replacement_attachment_id
        FROM content_transfer_sessions WHERE scope_id = ? AND operation = 'upload'
        AND status IN ('queued', 'running', 'uploading', 'verifying') AND expires_at > CURRENT_TIMESTAMP(3) ORDER BY id`, [scope])
      return rows.map((row): ContentUploadReservation => ({
        id: String(row.id), path: String(row.target_path),
        parent_id: row.target_parent_id == null ? undefined : Number(row.target_parent_id),
        source_id: row.source_attachment_id == null ? undefined : Number(row.source_attachment_id),
        replacement_id: row.replacement_attachment_id == null ? undefined : Number(row.replacement_attachment_id),
      }))
    })
  }
  async function initialize(session: string, actor: number) {
    const executor = randomUUID().replaceAll('-', '')
    const preparation = await owned(session, actor, async (connection, row) => {
      if (['uploading', 'verifying', 'completed'].includes(row.status))
        return null
      if (row.active_attempt_id && (await get_upload_attempt(connection, row)).upload_id)
        return null
      const claim = await claim_transfer(connection, row.id, executor, limits.lease_seconds, 1000)
      if (! claim)
        throw new ApiError(409, '上传正在初始化，请稍后重试')
      await enqueue_workspace_change(connection, Number(row.scope_id), { upload_sessions: [session] })
      return { claim, attempt: await create_transfer_attempt(connection, claim, limits.part_size), mime: row.intent.mime_type ?? 'application/octet-stream' }
    })
    if (preparation) {
      // Attempt/key is durable before this external request. A lost init response
      // leaves a cleanup fact; a later initializer gets a new key and epoch.
      const upload = await storage.create_multipart_upload(preparation.attempt.key, preparation.mime)
      try {
        await owned(session, actor, async (connection, row) => {
          await attach_transfer_upload(connection, preparation.claim, preparation.attempt.id, upload)
          await release_upload(connection, session, executor, preparation.claim.epoch, false)
          await enqueue_workspace_change(connection, Number(row.scope_id), { upload_sessions: [session] })
        })
      }
      catch (error) {
        await storage.abort_multipart_upload(preparation.attempt.key, upload).catch(() => {})
        throw error
      }
    }
    const current = await snapshot(session, actor)
    return public_state(current.row, current.attempt)
  }
  async function begin(actor: number, request_id: string, input: UploadIntent) {
    const intent = upload_intent_schema.parse(input)
    if (intent.expected_size > limits.max_size || attachment_path_violation(intent.target_path))
      throw new ApiError(400, '上传名称或大小无效')
    const id = await transaction(async (connection) => {
      await authorize(connection, actor, intent)
      const [expired] = await connection.execute<RowDataPacket[]>(`SELECT id FROM content_transfer_sessions WHERE scope_id = ? AND target_path = ?
        AND status IN ('uploading', 'queued', 'running', 'verifying') AND expires_at <= CURRENT_TIMESTAMP(3) FOR UPDATE`, [intent.scope_id, intent.target_path])
      for (const previous of expired) {
        if (await expire_transfer(connection, previous.id))
          await enqueue_workspace_change(connection, intent.scope_id, { upload_sessions: [String(previous.id)] })
      }
      const row = await accept_transfer(connection, actor, request_id, intent, limits.lifetime_seconds)
      await enqueue_workspace_change(connection, intent.scope_id, { upload_sessions: [row.id] })
      return row.id
    })
    return initialize(id, actor)
  }
  async function sign(session: string, actor: number, part: number, md5: string) {
    const plan = await owned(session, actor, async (connection, row) => {
      const attempt = await get_upload_attempt(connection, row)
      const size = await reserve_upload_part(connection, row, attempt, part, md5)
      return { key: attempt.target_key, upload: attempt.upload_id!, size, ttl: Math.min(limits.url_ttl_seconds, Number(row.remaining_seconds)) }
    })
    return storage.signed_part_upload(plan.key, plan.upload, part, plan.size, md5, plan.ttl)
  }
  async function resume(session: string, actor: number) {
    const current = await snapshot(session, actor)
    if (current.row.status !== 'uploading' || ! current.attempt?.upload_id)
      return public_state(current.row, current.attempt)
    const parts: ContentUploadSession['parts'] = []
    let marker = 0
    do {
      const page = await storage.list_multipart_parts(current.attempt.target_key, current.attempt.upload_id, marker).catch(async (error: unknown) => {
        if ((error as { code?: string }).code !== 'NoSuchUpload')
          throw error
        // Complete/abort removes the multipart outside our transaction. Recheck
        // authorized state before interpreting that absence as a storage failure.
        const latest = await snapshot(session, actor)
        if (latest.row.status !== 'uploading' || latest.attempt?.id !== current.attempt!.id)
          return null
        throw error
      })
      if (! page)
        return get(session, actor)
      parts.push(... page.parts)
      if (parts.length > 10_000 || (page.next_marker !== null && page.next_marker <= marker))
        throw new ApiError(502, 'OSS 分片分页异常')
      if (page.next_marker === null)
        break
      marker = page.next_marker
    } while (true)
    await owned(session, actor, async (connection, row) => {
      // Another client may have completed, cancelled or replaced this attempt
      // while ListParts was in flight. Never apply its old inventory afterwards.
      if (row.status !== 'uploading' || row.active_attempt_id !== current.attempt!.id)
        return
      await confirm_upload_parts(connection, row, await get_upload_attempt(connection, row), parts)
      await enqueue_workspace_change(connection, Number(row.scope_id), { upload_sessions: [session] })
    })
    return get(session, actor)
  }
  async function seal(session: string, actor: number) {
    const state = await resume(session, actor)
    if (state.status === 'ready' || state.status === 'completed')
      return state
    const prepared = await owned(session, actor, async (connection, row) => {
      if (row.result)
        return null
      const attempt = await get_upload_attempt(connection, row)
      const [parts] = await connection.execute<RowDataPacket[]>('SELECT part_number, byte_length AS size, etag FROM content_transfer_parts WHERE attempt_id = ? ORDER BY part_number', [attempt.id])
      const count = Math.ceil(Number(row.expected_size) / Number(attempt.part_size))
      if (parts.length !== count || parts.some((part, index) => Number(part.part_number) !== index + 1 || Number(part.size) !== Math.min(Number(attempt.part_size), Number(row.expected_size) - index * Number(attempt.part_size))))
        throw new ApiError(409, '上传分片尚未完整确认')
      await enqueue_workspace_change(connection, Number(row.scope_id), { upload_sessions: [session] })
      return { attempt, claim: await claim_upload_completion(connection, row, randomUUID().replaceAll('-', ''), limits.lease_seconds), parts }
    })
    if (! prepared)
      return resume(session, actor)
    const { attempt, claim, parts } = prepared
    let metadata = await storage.head_object(attempt.target_key).catch((error: unknown) => {
      if ((error as { status?: number }).status === 404)
        return null
      throw error
    })
    if (! metadata) {
      await storage.complete_multipart_upload(attempt.target_key, attempt.upload_id!, parts.map(part => ({ part_number: Number(part.part_number), etag: part.etag })))
      metadata = await storage.head_object(attempt.target_key)
    }
    if (metadata.size !== state.size || ! metadata.version_id || await storage.get_object_access(attempt.target_key) !== 'private')
      throw new ApiError(409, '上传对象大小或私密状态不符')
    const hash = createHash('sha256')
    const { stream } = await storage.get_object_stream(attempt.target_key, metadata.etag)
    let bytes = 0
    const image_header = new Uint8Array(12)
    let heartbeat_at = Date.now()
    try {
      for await (const chunk of stream) {
        if (bytes < image_header.length)
          image_header.set(chunk.subarray(0, image_header.length - bytes), bytes)
        bytes += chunk.length
        if (bytes > state.size)
          throw new ApiError(409, '上传对象大小不符')
        hash.update(chunk)
        if (Date.now() - heartbeat_at >= limits.heartbeat_seconds * 1000) {
          await owned(session, actor, connection => heartbeat_transfer(connection, claim, limits.lease_seconds))
          heartbeat_at = Date.now()
        }
      }
    }
    finally {
      stream.destroy()
    }
    const sha256 = hash.digest('hex')
    const snapshot_intent = (await snapshot(session, actor)).row.intent
    if (snapshot_intent.image?.source && redaction_image_mime(image_header) !== 'image/png')
      throw new ApiError(400, '图片编辑输出必须为无损 PNG')
    if (state.purpose === 'redact' && ! snapshot_intent.image && redaction_image_mime(image_header) !== redactable_attachment_mime(state.path))
      throw new ApiError(400, '删减版实际格式与原图不一致')
    const after = await storage.head_object(attempt.target_key)
    if (bytes !== state.size || sha256 !== state.sha256 || after.etag !== metadata.etag || after.version_id !== metadata.version_id)
      throw new ApiError(409, '上传对象完整摘要或身份不符')
    await owned(session, actor, async (connection, row) => {
      await heartbeat_transfer(connection, claim, limits.lease_seconds)
      await verify_transfer_attempt(connection, claim, attempt.id, { size: bytes, etag: metadata!.etag, oss_version_id: metadata!.version_id!, sha256 })
      await connection.execute('UPDATE content_transfer_sessions SET result = CAST(? AS JSON) WHERE id = ?', [JSON.stringify({ key: attempt.target_key, etag: metadata!.etag, oss_version_id: metadata!.version_id, size: bytes, sha256 }), session])
      await release_upload(connection, session, claim.executor_id, claim.epoch, true)
      if (on_sealed)
        await on_sealed(connection, await get_upload(connection, session, actor))
      await enqueue_workspace_change(connection, Number(row.scope_id), { upload_sessions: [session] })
    })
    return resume(session, actor)
  }
  async function cancel(session: string, actor: number) {
    const target = await owned(session, actor, async (connection, row) => {
      const attempt = row.active_attempt_id && ! ['cancelled', 'expired', 'failed', 'completed'].includes(row.status) ? await get_upload_attempt(connection, row) : null
      await cancel_transfer(connection, session, actor)
      if (! ['cancelled', 'expired', 'failed', 'completed'].includes(row.status)) {
        await on_cancel?.(connection, row)
        await enqueue_workspace_change(connection, Number(row.scope_id), { upload_sessions: [session] })
      }
      return attempt
    })
    if (target?.upload_id)
      await storage.abort_multipart_upload(target.target_key, target.upload_id).catch(() => {})
    const current = await snapshot(session, actor)
    return public_state(current.row, current.attempt)
  }
  async function adopt(session: string, actor: number, publish: (connection: Connection, row: UploadRow) => Promise<UploadPublication>) {
    return owned(session, actor, async (connection, row) => {
      if (row.status === 'completed') {
        const receipt = upload_publication_schema.parse(row.result)
        await enqueue_workspace_change(connection, Number(row.scope_id), { ... (receipt.refresh ?? legacy_workspace_change), upload_sessions: [session] })
        return receipt
      }
      if (row.status !== 'verifying' || ! row.result)
        throw new ApiError(409, '上传对象尚未就绪')
      const result = await publish(connection, row)
      await adopt_upload_in_transaction(connection, row, result)
      await enqueue_workspace_change(connection, Number(row.scope_id), { ... (result.refresh ?? legacy_workspace_change), upload_sessions: [session] })
      return result
    })
  }
  return { begin, get, list, reservations, initialize, sign, resume, seal, cancel, adopt }
}
