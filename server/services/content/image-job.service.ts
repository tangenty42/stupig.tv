import type { create_aliyun_oss } from '@server/lib/aliyun-oss'
import type { Connection, Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { ImageAccessRow } from './attachment-access.service'
import type { RedactedVariantRow } from './redacted-variant'
import { createHash, randomUUID } from 'node:crypto'
import { ApiError } from '@server/errors/ApiError'
import { create_oss_image_processor } from '@server/lib/oss-image-processing'
import { image_processing_options_schema, process_image_variants } from '@server/lib/webp-image-processing'
import { content_image_formats } from '@shared/content-image-format'
import { settings } from '@shared/settings'
import { z } from 'zod'
import { image_download_name, resolve_attachment_role } from './attachment-access.service'
import { create_image_attempt_cleanup } from './image-attempt-cleanup.service'
import { copy_image_original, image_object_identity, image_original_key } from './image-original-object'
import { require_adoptable_objects } from './object-adoption.service'
import { enqueue_object_retirement } from './object-retirement.repository'
import { enqueue_preload } from './preload.repository'
import { has_redacted_variant, redacted_object_keys } from './redacted-variant'
import { require_workspace_actor } from './workspace-auth.service'
import { enqueue_workspace_change } from './workspace-sync.service'

const uuid = () => randomUUID().replaceAll('-', '')
const object_identity = image_object_identity
export const image_job_intent_schema = z.strictObject({
  scope_id: z.number().int().positive(), actor_id: z.number().int().positive(),
  mode: z.enum(['upload', 'copy', 'overwrite', 'redacted']), is_private: z.boolean(),
  input: object_identity.extend({ sha256: object_identity.shape.sha256.nullable() }), original_name: z.string().min(1).max(255), original_mime: z.string().min(1).max(255),
  source: z.strictObject({ id: z.number().int().positive(), revision: z.number().int().positive(), node_revision: z.number().int().positive(), key: z.string().min(1).max(512), is_private: z.boolean() }).nullable(),
  profile_version: z.number().int().positive(), profile: image_processing_options_schema,
  processor: z.literal('oss').optional(),
  input_basis: z.enum(['display', 'original']).optional(),
  redacted_policy: z.enum(['keep', 'discard']).optional(),
}).superRefine((value, ctx) => {
  if ((value.mode === 'upload') !== (value.source === null)
    || (value.mode === 'redacted' && (! value.source?.is_private || value.is_private))
    || (value.source && value.mode !== 'redacted' && value.is_private !== value.source.is_private)) {
    ctx.addIssue({ code: 'custom', message: '图片保存模式与来源权限不一致' })
  }
})
export type ImageJobIntent = z.infer<typeof image_job_intent_schema>
const produced = z.strictObject({
  display: object_identity, fallback: object_identity, width: z.number().int().positive(), height: z.number().int().positive(),
  original: object_identity.nullable(),
  lqip: z.string().max(Math.ceil(settings.app.content.image.lqipMaxBytes / 3) * 4),
})
interface JobRow extends RowDataPacket {
  id: string
  actor_id: number
  scope_id: number
  fingerprint: string
  intent: ImageJobIntent | string
  status: string
  execution_epoch: number
  active_attempt_id: string | null
  busy: number
  result: z.infer<typeof produced> | string | null
  attachment_id: number | null
}
function parse_intent(row: JobRow) {
  return image_job_intent_schema.parse(typeof row.intent === 'string' ? JSON.parse(row.intent) : row.intent)
}
function conflict() {
  return new ApiError(409, '图片处理状态、权限或版本已变化')
}
function jpeg_bytes(base64: string) {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.toString('base64') !== base64 || bytes.length > settings.app.content.image.lqipMaxBytes
    || bytes.length < 4 || bytes.readUInt16BE(0) !== 0xFFD8 || bytes.readUInt16BE(bytes.length - 2) !== 0xFFD9) {
    throw new ApiError(400, '图片占位数据无效')
  }
  return bytes
}

/**
 * Internal producer: callers must hold the existing namespace/upload reservation.
 * No arbitrary-key public API and no process-local promise owns this ledger.
 * Each admitted intent owns its provider/profile; retries only refresh budgets.
 */
export function create_image_jobs(pool: Pick<Pool, 'getConnection'>, storage: ReturnType<typeof create_aliyun_oss>, lease_seconds: number, heartbeat_seconds: number, cloud = create_oss_image_processor) {
  if (! Number.isInteger(lease_seconds) || lease_seconds < 1 || heartbeat_seconds <= 0 || heartbeat_seconds >= lease_seconds)
    throw new ApiError(400, '图片处理租约无效')
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
    finally {
      connection.release()
    }
  }
  async function changed(connection: Connection, job: string, scope: number) {
    const [uploads] = await connection.execute<RowDataPacket[]>('SELECT session_id FROM content_upload_images WHERE job_id = ?', [job])
    if (uploads.length)
      await enqueue_workspace_change(connection, scope, { upload_sessions: uploads.map(row => String(row.session_id)) })
  }
  async function authorize(connection: Connection, intent: ImageJobIntent, check_source = true) {
    const [scopes] = await connection.execute<RowDataPacket[]>('SELECT id FROM content_stories WHERE id = ? FOR UPDATE', [intent.scope_id])
    if (! scopes[0])
      throw new ApiError(404, '档案不存在或已被删除')
    await require_workspace_actor(intent.actor_id, intent.is_private || !! intent.source?.is_private, connection)
    if (intent.source && check_source) {
      const [rows] = await connection.execute<RowDataPacket[]>('SELECT * FROM content_story_attachments WHERE id = ? AND story_id = ? FOR UPDATE', [intent.source.id, intent.scope_id])
      const row = rows[0]
      if (! row || row.storage_provider !== 'aliyun' || row.encryption_key !== null || row.display_key !== intent.source.key || Number(row.image_revision) !== intent.source.revision
        || Number(row.node_revision) !== intent.source.node_revision || Boolean(row.is_private) !== intent.source.is_private) {
        throw conflict()
      }
      if (intent.input_basis === 'original') {
        await resolve_attachment_role(row as ImageAccessRow, 'original', null, async (source) => {
          await require_workspace_actor(intent.actor_id, Boolean(source.is_private), connection)
        })
      }
    }
  }
  async function get(connection: Connection, id: string) {
    const [rows] = await connection.execute<JobRow[]>('SELECT *, lease_until > CURRENT_TIMESTAMP(3) AS busy FROM content_image_jobs WHERE id = ? FOR UPDATE', [id])
    if (! rows[0])
      throw new ApiError(404, '图片处理不存在')
    return rows[0]
  }
  async function with_job<T>(id: string, actor: number, action: (connection: Connection, row: JobRow, intent: ImageJobIntent) => Promise<T>, check_source = true) {
    z.string().regex(/^[\da-f]{32}$/).parse(id)
    return transaction(async (connection) => {
      // Discover without a lock, then always take scope -> source -> job locks.
      const [found] = await connection.execute<JobRow[]>('SELECT intent FROM content_image_jobs WHERE id = ? AND actor_id = ?', [id, actor])
      if (! found[0])
        throw new ApiError(404, '图片处理不存在')
      const intent = parse_intent(found[0])
      await authorize(connection, intent, false)
      const row = await get(connection, id)
      if (check_source && row.status !== 'completed')
        await authorize(connection, intent)
      return action(connection, row, intent)
    })
  }
  async function enqueue_in_transaction(connection: Connection, request: string, input: ImageJobIntent) {
    z.uuid().parse(request)
    const intent = image_job_intent_schema.parse(input)
    const encoded = JSON.stringify(intent)
    const fingerprint = createHash('sha256').update(encoded).digest('hex')
    await authorize(connection, intent, false)
    const [previous] = await connection.execute<JobRow[]>('SELECT * FROM content_image_jobs WHERE actor_id = ? AND request_id = ? FOR UPDATE', [intent.actor_id, request])
    if (previous[0]) {
      if (previous[0].fingerprint !== fingerprint)
        throw conflict()
      return { id: previous[0].id, status: previous[0].status }
    }
    await authorize(connection, intent)
    const id = uuid()
    await require_adoptable_objects(connection, [intent.input.key, intent.source?.key])
    await connection.execute(`INSERT IGNORE INTO content_image_jobs (id, scope_id, actor_id, request_id, fingerprint, intent)
        VALUES (?, ?, ?, ?, ?, CAST(? AS JSON))`, [id, intent.scope_id, intent.actor_id, request, fingerprint, encoded])
    const [rows] = await connection.execute<JobRow[]>('SELECT * FROM content_image_jobs WHERE actor_id = ? AND request_id = ? FOR UPDATE', [intent.actor_id, request])
    if (! rows[0] || rows[0].fingerprint !== fingerprint)
      throw conflict()
    return { id: rows[0].id, status: rows[0].status }
  }
  async function enqueue(request: string, input: ImageJobIntent) {
    return transaction(connection => enqueue_in_transaction(connection, request, input))
  }
  async function run(id: string, actor: number) {
    const claim = await with_job(id, actor, async (connection, row, intent) => {
      if (row.status === 'ready' || row.status === 'completed')
        return null
      if (! ['queued', 'processing'].includes(row.status) || row.busy)
        throw conflict()
      const epoch = Number(row.execution_epoch) + 1
      const executor = uuid()
      const attempt = uuid()
      const prefix = `content/att/images/${id}/${attempt}`
      await connection.execute('UPDATE content_image_attempts SET cleanup_required = 1 WHERE job_id = ? AND adopted = 0', [id])
      await connection.execute(`INSERT INTO content_image_attempts (id, job_id, execution_epoch, display_key, fallback_key) VALUES (?, ?, ?, ?, ?)`, [attempt, id, epoch, `${prefix}.${content_image_formats.display.extension}`, `${prefix}.${content_image_formats.fallback.extension}`])
      await connection.execute(`UPDATE content_image_jobs SET status = 'processing', execution_epoch = ?, executor_id = ?, active_attempt_id = ?,
        lease_until = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3)), result = NULL, error_code = NULL WHERE id = ?`, [epoch, executor, attempt, lease_seconds, id])
      await changed(connection, id, intent.scope_id)
      return { epoch, executor, attempt, intent, prefix }
    })
    if (! claim)
      return
    const fence = `id = ? AND execution_epoch = ? AND executor_id = ? AND status = 'processing' AND lease_until > CURRENT_TIMESTAMP(3)`
    const values = [id, claim.epoch, claim.executor]
    const abort = new AbortController()
    let heartbeat: Promise<void> | null = null
    async function renew() {
      const [result] = await transaction(connection => connection.execute<ResultSetHeader>(`UPDATE content_image_jobs SET lease_until = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3)) WHERE ${fence}`, [lease_seconds, ... values]))
      if (result.affectedRows !== 1)
        throw conflict()
    }
    const timer = setInterval(() => {
      if (! heartbeat)
        heartbeat = renew().catch(() => abort.abort()).finally(() => { heartbeat = null })
    }, heartbeat_seconds * 1000)
    timer.unref()
    try {
      const { input, profile } = claim.intent
      if (input.size > profile.maxInputBytes)
        throw new ApiError(400, '图片超过处理大小限制')
      const head = await storage.head_object(input.key)
      if (head.etag !== input.etag || head.version_id !== input.version_id || head.size !== input.size || await storage.get_object_access(input.key) !== 'private')
        throw conflict()
      const { stream, size } = await storage.get_object_stream(input.key, input.etag, abort.signal)
      if (size !== input.size) {
        stream.destroy()
        throw conflict()
      }
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of stream) {
        length += chunk.length
        if (length > input.size || length > profile.maxInputBytes) {
          stream.destroy()
          throw conflict()
        }
        chunks.push(Buffer.from(chunk))
      }
      const bytes = Buffer.concat(chunks)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (length !== input.size || (input.sha256 !== null && sha256 !== input.sha256))
        throw conflict()
      const output = async (key: string, body: Buffer, mime: string) => {
        abort.signal.throwIfAborted()
        const object = await storage.put_object(key, body, mime, 'private')
        await renew()
        if (! object.version_id || await storage.get_object_access(key) !== 'private')
          throw conflict()
        return { key, etag: object.etag, version_id: object.version_id, size: body.length, sha256: createHash('sha256').update(body).digest('hex') }
      }
      const result = claim.intent.processor === 'oss'
        ? await cloud()({ storage, input: { ... input, sha256 }, bytes, profile, prefix: claim.prefix, signal: abort.signal, checkpoint: renew })
        : await (async () => {
            const result = await process_image_variants(bytes, profile)
            jpeg_bytes(result.lqip.toString('base64'))
            abort.signal.throwIfAborted()
            await renew()
            const display = await output(`${claim.prefix}.${content_image_formats.display.extension}`, result.display, content_image_formats.display.mime)
            const fallback = await output(`${claim.prefix}.${content_image_formats.fallback.extension}`, result.fallback, content_image_formats.fallback.mime)
            return { ... result, display, fallback }
          })()
      const { display, fallback } = result
      jpeg_bytes(result.lqip.toString('base64'))
      const archive = claim.intent.mode === 'upload' ? { ... input, sha256 } : claim.intent.mode === 'copy' ? display : null
      const original = archive
        ? await copy_image_original(storage, archive, image_original_key(id, claim.attempt), abort.signal)
        : null
      await renew()
      await with_job(id, actor, async (connection) => {
        const [updated] = await connection.execute<ResultSetHeader>(`UPDATE content_image_jobs SET status = 'ready', result = CAST(? AS JSON), lease_until = NULL, executor_id = NULL WHERE ${fence}`,
          [JSON.stringify({ display, fallback, original, width: result.width, height: result.height, lqip: result.lqip.toString('base64') }), ... values])
        if (updated.affectedRows !== 1)
          throw conflict()
        await changed(connection, id, claim.intent.scope_id)
      })
    }
    catch (error) {
      // Late workers may neither publish nor change a replacement worker's state.
      const error_message = error instanceof ApiError ? error.message : '图片处理失败，请重试或联系管理员'
      await transaction(async (connection) => {
        const [updated] = await connection.execute<ResultSetHeader>(`UPDATE content_image_jobs SET status = 'failed', error_code = 'image_processing_failed', result = CAST(? AS JSON), lease_until = NULL, executor_id = NULL WHERE ${fence}`, [JSON.stringify({ error_message }), ... values])
        if (updated.affectedRows)
          await changed(connection, id, claim.intent.scope_id)
      })
      throw error
    }
    finally {
      clearInterval(timer)
      await heartbeat
    }
  }
  async function cancel(id: string, actor: number) {
    return with_job(id, actor, async (connection, row) => {
      if (row.status === 'completed')
        return 'completed'
      await connection.execute(`UPDATE content_image_jobs SET status = 'cancelled', execution_epoch = execution_epoch + 1, lease_until = NULL, executor_id = NULL WHERE id = ?`, [id])
      await changed(connection, id, Number(row.scope_id))
      return 'cancelled'
    }, false)
  }
  async function retry(id: string, actor: number, budgets?: Pick<ImageJobIntent['profile'], 'maxInputBytes' | 'maxPixels' | 'timeoutSeconds'>) {
    return with_job(id, actor, async (connection, row) => {
      if (row.status !== 'failed')
        throw conflict()
      const intent = parse_intent(row)
      if (budgets) {
        intent.profile = image_processing_options_schema.parse({ ... intent.profile,
          maxInputBytes: budgets.maxInputBytes, maxPixels: budgets.maxPixels, timeoutSeconds: budgets.timeoutSeconds })
      }
      // The original admission fingerprint remains the request identity. Only
      // execution budgets may change on explicit retry; encoding/source do not.
      await connection.execute('UPDATE content_image_jobs SET status = \'queued\', error_code = NULL, result = NULL, intent = CAST(? AS JSON) WHERE id = ?', [JSON.stringify(intent), id])
      await changed(connection, id, intent.scope_id)
    })
  }
  async function fail_publication(id: string, epoch: number, scope: number) {
    await transaction(async (connection) => {
      const [updated] = await connection.execute<ResultSetHeader>(`UPDATE content_image_jobs SET status = 'failed', error_code = 'image_publish_failed'
        WHERE id = ? AND execution_epoch = ? AND status IN ('queued', 'ready') AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP(3))`, [id, epoch])
      if (updated.affectedRows)
        await changed(connection, id, scope)
    })
  }
  /** Called by the namespace publisher INSIDE its transaction, before its receipt. */
  async function adopt(connection: Connection, id: string, actor: number, attachment_id: number, node_revision: number) {
    const [found] = await connection.execute<JobRow[]>('SELECT intent FROM content_image_jobs WHERE id = ? AND actor_id = ?', [id, actor])
    if (! found[0])
      throw new ApiError(404, '图片处理不存在')
    const intent = parse_intent(found[0])
    await authorize(connection, intent, false)
    const job = await get(connection, id)
    if (job.status === 'completed') {
      if (Number(job.attachment_id) !== attachment_id)
        throw conflict()
      return
    }
    if (job.status !== 'ready' || ! job.result)
      throw conflict()
    await authorize(connection, intent)
    const result = produced.parse(typeof job.result === 'string' ? JSON.parse(job.result) : job.result)
    const [rows] = await connection.execute<(RowDataPacket & RedactedVariantRow)[]>('SELECT * FROM content_story_attachments WHERE id = ? AND story_id = ? FOR UPDATE', [attachment_id, intent.scope_id])
    const row = rows[0]
    if (! row || row.is_folder || row.storage_provider !== 'aliyun' || row.encryption_key !== null || Number(row.node_revision) !== node_revision || Boolean(row.is_private) !== (intent.mode === 'redacted' ? intent.source?.is_private : intent.is_private)
      || (intent.mode === 'overwrite' || intent.mode === 'redacted' ? Number(row.id) !== intent.source?.id : row.object_key !== intent.input.key)) {
      throw conflict()
    }
    if (intent.mode === 'redacted') {
      await require_adoptable_objects(connection, [result.display.key, result.fallback.key])
      await connection.execute(`UPDATE content_story_attachments SET redacted_display_key = ?, redacted_fallback_key = ?,
        redacted_revision = redacted_revision + 1, redacted_metadata = CAST(? AS JSON), redacted_lqip = ?,
        read_revision = read_revision + 1, node_revision = node_revision + 1 WHERE id = ?`,
      [result.display.key, result.fallback.key, JSON.stringify({ display: result.display, fallback: result.fallback, width: result.width, height: result.height }), jpeg_bytes(result.lqip), attachment_id])
      for (const key of redacted_object_keys(row))
        await enqueue_object_retirement(connection, key, intent.scope_id, 'redacted-overwrite')
      await enqueue_object_retirement(connection, intent.input.key, intent.scope_id, 'image-input')
      await connection.execute('UPDATE content_image_attempts SET adopted = 1, cleanup_required = 0 WHERE id = ? AND job_id = ?', [job.active_attempt_id, id])
      await connection.execute('UPDATE content_image_jobs SET status = \'completed\', attachment_id = ? WHERE id = ?', [attachment_id, id])
      await enqueue_preload(connection, intent.scope_id, attachment_id, [result.display, result.fallback])
      return
    }
    const previous = typeof row.image_metadata === 'string' ? JSON.parse(row.image_metadata) : row.image_metadata
    const archive = intent.mode === 'upload' ? intent.input : intent.mode === 'copy' ? result.display : null
    if (!! archive !== !! result.original || (result.original && (result.original.key !== image_original_key(id, job.active_attempt_id!)
      || (archive!.sha256 !== null && result.original.sha256 !== archive!.sha256) || result.original.size !== archive!.size))) {
      throw conflict()
    }
    const original = archive ? result.original!.key : intent.mode === 'overwrite' ? row.original_key : null
    await require_adoptable_objects(connection, [result.display.key, result.fallback.key, original])
    const metadata = { display: result.display, fallback: result.fallback, width: result.width, height: result.height, profile_version: intent.profile_version,
      original: archive ? { ... result.original!, name: intent.mode === 'copy' ? image_download_name(row.file_name, 'display') : intent.original_name, mime: intent.mode === 'copy' ? content_image_formats.display.mime : intent.original_mime } : intent.mode === 'overwrite' ? previous?.original ?? null : null,
      source_id: intent.mode === 'copy' ? null : intent.source?.id ?? null, source_revision: intent.mode === 'copy' ? null : intent.source?.revision ?? null,
      input_basis: intent.input_basis ?? (intent.mode === 'upload' ? 'original' : 'display'),
      redaction_source_id: null }
    await connection.execute(`UPDATE content_story_attachments SET original_key = ?, display_key = ?, fallback_key = ?, source_display_key = ?,
      image_revision = image_revision + 1, is_edited = ?, image_metadata = CAST(? AS JSON), lqip = ?,
      object_key = ?, version = ?, oss_version_id = ?, file_size = ?, mime_type = '${content_image_formats.display.mime}', node_revision = node_revision + 1 WHERE id = ?`,
    [original, result.display.key, result.fallback.key, intent.mode === 'copy' ? null : intent.source?.key ?? null, intent.mode === 'upload' ? 0 : 1, JSON.stringify(metadata), jpeg_bytes(result.lqip),
      result.display.key, result.display.etag, result.display.version_id, result.display.size, attachment_id])
    if (intent.mode === 'overwrite') {
      if (has_redacted_variant(row) && ! intent.redacted_policy)
        throw new ApiError(409, '已有删减版，请重新选择保留或删除')
      if (intent.redacted_policy === 'discard') {
        await connection.execute('UPDATE content_story_attachments SET redacted_display_key = NULL, redacted_fallback_key = NULL, redacted_metadata = NULL, redacted_lqip = NULL, redacted_revision = redacted_revision + 1, read_revision = read_revision + 1 WHERE id = ?', [attachment_id])
        for (const key of redacted_object_keys(row))
          await enqueue_object_retirement(connection, key, intent.scope_id, 'redacted-discard')
      }
      for (const key of [row.display_key, row.fallback_key].filter(Boolean))
        await enqueue_object_retirement(connection, key, intent.scope_id, 'image-overwrite')
    }
    await enqueue_object_retirement(connection, intent.input.key, intent.scope_id, 'image-input')
    await connection.execute('UPDATE content_image_attempts SET adopted = 1, cleanup_required = 0 WHERE id = ? AND job_id = ?', [job.active_attempt_id, id])
    await connection.execute('UPDATE content_image_jobs SET status = \'completed\', attachment_id = ? WHERE id = ?', [attachment_id, id])
    await enqueue_preload(connection, intent.scope_id, attachment_id, [result.display, result.fallback])
  }
  const cleanup = create_image_attempt_cleanup(pool, storage)
  return { enqueue, enqueue_in_transaction, run, cancel, retry, adopt, cleanup, fail_publication }
}
