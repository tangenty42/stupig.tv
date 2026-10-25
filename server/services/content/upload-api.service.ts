import type { UploadBatch } from '@shared/content-upload'
import type { RowDataPacket } from 'mysql2/promise'
import { runtime_config } from '@config/loader'
import { ApiError } from '@server/errors/ApiError'
import { create_aliyun_oss } from '@server/lib/aliyun-oss'
import { db } from '@server/lib/db'
import { settings } from '@shared/settings'
import { get_attachment_workspace } from './attachment-workspace.service'
import { admit_upload_batch } from './upload-admission.service'
import { create_upload_images } from './upload-image.service'
import { create_upload_lifecycle } from './upload-lifecycle.service'
import { create_upload_sessions } from './upload-session.service'
import { require_workspace_actor } from './workspace-auth.service'

/** All runtime uploads require Aliyun and the workspace session protocol. */
async function service() {
  const target = runtime_config().aliyun.oss
  if (! target)
    throw new ApiError(503, '阿里云上传目标尚未配置')
  try {
    await db.execute('SELECT 1 FROM content_upload_part_grants, content_upload_images LIMIT 0')
  }
  catch (error) {
    if ((error as { code?: string }).code === 'ER_NO_SUCH_TABLE')
      throw new ApiError(503, '上传会话迁移尚未应用')
    throw error
  }
  const storage = create_aliyun_oss(target)
  const images = create_upload_images(db, storage, runtime_config().app.contentImages)
  const lifecycle = create_upload_lifecycle(db, storage, runtime_config().app.contentUploads, images.cancel)
  const uploads = create_upload_sessions({
    pool: db, storage, target: { bucket: target.bucket, endpoint: target.endpoint, region: target.region },
    on_sealed: images.sealed, on_cancel: lifecycle.cancel,
    authorize: async (connection, actor, intent) => {
      const [rows] = await connection.execute<RowDataPacket[]>('SELECT id FROM content_stories WHERE id = ? FOR UPDATE', [intent.scope_id])
      if (! rows[0])
        throw new ApiError(404, '档案不存在或已被删除')
      // Redaction reads a confidential source even though its output is public.
      await require_workspace_actor(actor, intent.target_access === 'private' || intent.purpose === 'redact', connection)
    },
    limits: {
      part_size: settings.app.content.upload.partSizeMb * 1024 ** 2, max_size: settings.app.content.upload.maxSizeMb * 1024 ** 2,
      lifetime_seconds: settings.app.content.workspace.sessionHours * 3600, lease_seconds: settings.app.content.workspace.leaseSeconds,
      heartbeat_seconds: settings.app.content.workspace.heartbeatSeconds, url_ttl_seconds: settings.app.content.upload.urlTtlSeconds,
    },
  })
  return { ... uploads, images, lifecycle }
}
export async function list_upload_sessions(scope: number, actor: number) {
  const uploads = await service()
  const sessions = await Promise.all((await uploads.list(scope, actor)).map(uploads.images.state))
  return { enabled: true, sessions, reservations: await uploads.reservations(scope, actor) }
}
export async function begin_upload_batch(actor: number, input: UploadBatch) {
  const uploads = await service()
  const { refresh: _refresh, ... result } = await admit_upload_batch(actor, input)
  // Acceptance is durable before any multipart creation. A lost response can
  // replay this receipt; clients initialize each accepted session independently.
  return { ... result, sessions: await Promise.all(result.accepted.map(item => uploads.get(item.session_id, actor))) }
}
export async function adopt_upload_session(session: string, actor: number) {
  const uploads = await service()
  const state = await uploads.get(session, actor)
  const receipt = await uploads.adopt(session, actor, uploads.images.publish)
  // Read after commit (also on receipt replay): the file, its ancestors and the
  // namespace revision must agree before the client retires its task row.
  const viewer = await require_workspace_actor(actor, false)
  const workspace = await get_attachment_workspace(state.scope_id!, viewer)
  return { attachment_id: receipt.attachment_id, attachment: workspace.attachments.find(file => file.id === receipt.attachment_id) ?? null, workspace }
}
export async function operate_upload_session(operation: 'get' | 'initialize' | 'resume' | 'seal' | 'cancel', session: string, actor: number) {
  const uploads = await service()
  if (operation === 'resume') {
    await uploads.get(session, actor)
    await uploads.images.retry(session, actor)
  }
  return uploads.images.state(await uploads[operation](session, actor))
}
export async function sign_upload_session_part(session: string, actor: number, part: number, md5: string) {
  return (await service()).sign(session, actor, part, md5)
}

export async function sweep_content_images(signal?: AbortSignal) {
  if (signal?.aborted)
    return
  if (! runtime_config().app.contentImages.enabled || ! runtime_config().aliyun.oss)
    return
  const uploads = await service()
  await uploads.images.sweep(uploads, signal)
}

let upload_cleanup_cursor = ''
let image_cleanup_cursor = ''
export async function sweep_content_uploads(signal?: AbortSignal) {
  if (signal?.aborted)
    return
  if (! runtime_config().app.contentUploads.enabled || ! runtime_config().aliyun.oss)
    return
  const uploads = await service()
  await uploads.lifecycle.expire(signal)
  upload_cleanup_cursor = await uploads.lifecycle.cleanup(upload_cleanup_cursor, signal)
  const cleanup = await uploads.images.jobs.cleanup(image_cleanup_cursor, signal)
  image_cleanup_cursor = cleanup.next_cursor ?? ''
}
