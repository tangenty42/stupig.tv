import type { Connection, ResultSetHeader } from 'mysql2/promise'
import type { UploadRow } from './upload-session.repository'
import { ApiError } from '@server/errors/ApiError'
import { attachment_inherits_private, attachment_mime_type, attachment_name_conflict_message, decrypted_attachment_name, link_file_name_byte_length } from '@shared/content-markdown'
import { attachment_name_key } from '@shared/content-workspace'
import { settings } from '@shared/settings'
import { attachment_owned_object_keys } from './attachment-objects'
import { require_adoptable_objects } from './object-adoption.service'
import { enqueue_object_retirement } from './object-retirement.repository'
import { enqueue_preload } from './preload.repository'
import { redacted_object_keys } from './redacted-variant'
import { begin_namespace_change, finish_namespace_change } from './reference-history.service'
import { node_version, workspace_rows } from './workspace.repository'

/** Called by the session adopter: mapping, namespace journal and receipt share one transaction. */
export async function publish_uploaded_attachment(connection: Connection, session: UploadRow, image?: { adopt: (connection: Connection, attachment_id: number, node_revision: number) => Promise<void>, key: string, etag: string }) {
  const object = session.result
  if (! object || ! ('key' in object))
    throw new ApiError(409, '上传对象尚未就绪')
  await require_adoptable_objects(connection, [object.key])
  const before = await begin_namespace_change(connection, session.scope_id)
  const rows = await workspace_rows(connection, session.scope_id)
  const parent = rows.find(row => Number(row.id) === session.intent.target_parent_id && row.is_folder)
  const final_name = session.intent.target_name
  if (! parent || ! final_name)
    throw new ApiError(409, '上传目标目录已变化')
  const name = parent.file_name ? `${parent.file_name}/${final_name}` : final_name
  if (attachment_inherits_private(name) !== attachment_inherits_private(session.intent.target_path))
    throw new ApiError(409, '上传目标目录的机密状态已变化，请重新受理上传')
  const mime = session.intent.mime_type ?? attachment_mime_type(decrypted_attachment_name(final_name))
  const source = session.intent.source && rows.find(row => Number(row.id) === session.intent.source!.id)
  if (session.intent.source && (! source || node_version(rows, source) !== session.intent.source.version))
    throw new ApiError(409, '原附件已变化，请重新受理上传')
  const replacing = session.intent.purpose === 'replace' || session.intent.image?.mode === 'redacted' ? session.intent.source : session.intent.replacement
  const replaced = replacing && rows.find(row => Number(row.id) === replacing.id)
  if (replacing && (! replaced || node_version(rows, replaced) !== replacing.version))
    throw new ApiError(409, '被替换附件已变化')
  if (link_file_name_byte_length(name) > settings.app.content.link.fileNameMaxBytes || rows.some(row => row.id !== replaced?.id && Number(row.parent_id) === Number(parent.id) && row.name_key === attachment_name_key(final_name)))
    throw new ApiError(409, attachment_name_conflict_message)
  if (replaced) {
    if (session.intent.image?.mode === 'overwrite' || session.intent.image?.mode === 'redacted') {
      if (! image)
        throw new ApiError(409, '图片尚未处理就绪')
      await image.adopt(connection, Number(replaced.id), Number(replaced.node_revision))
      const refresh = await finish_namespace_change(connection, before)
      return { attachment_id: Number(replaced.id), object_key: image.key, version: image.etag, refresh }
    }
    await connection.execute(`UPDATE content_story_attachments SET parent_id = ?, name = ?, name_key = ?, file_name = ?,
      object_key = ?, mime_type = ?, file_size = ?, version = ?, oss_version_id = ?, is_private = ?, node_revision = node_revision + 1
      , original_key = NULL, avif_key = NULL, jpeg_key = NULL, parent_avif_key = NULL, image_metadata = NULL, lqip_jpeg = NULL, is_edited = 0
      WHERE id = ?`, [parent.id, final_name, attachment_name_key(final_name), name, object.key, mime, object.size, object.etag,
      object.oss_version_id, session.intent.target_access === 'private' ? 1 : 0, replaced.id])
    const retained = session.intent.redacted_policy === 'keep' ? redacted_object_keys(replaced) : []
    if (! retained.length) {
      await connection.execute('UPDATE content_story_attachments SET redacted_avif_key = NULL, redacted_jpeg_key = NULL, redacted_metadata = NULL, redacted_lqip_jpeg = NULL, redacted_revision = redacted_revision + 1, read_revision = read_revision + 1 WHERE id = ?', [replaced.id])
    }
    for (const key of attachment_owned_object_keys(replaced).filter(key => ! retained.includes(key)))
      await enqueue_object_retirement(connection, key, session.scope_id, 'replacement')
    await image?.adopt(connection, Number(replaced.id), Number(replaced.node_revision) + 1)
    if (! image && mime?.startsWith('image/'))
      await enqueue_preload(connection, session.scope_id, Number(replaced.id), [object])
    const refresh = await finish_namespace_change(connection, before)
    return { attachment_id: Number(replaced.id), object_key: image?.key ?? object.key, version: image?.etag ?? object.etag, refresh }
  }
  const [inserted] = await connection.execute<ResultSetHeader>(`INSERT INTO content_story_attachments
    (story_id, parent_id, name, name_key, file_name, object_key, mime_type, file_size, version, storage_bucket, storage_provider, oss_version_id, is_private)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', 'aliyun', ?, ?)`,
  [session.scope_id, parent.id, final_name, attachment_name_key(final_name), name, object.key, mime, object.size, object.etag, object.oss_version_id, session.intent.target_access === 'private' ? 1 : 0])
  await image?.adopt(connection, Number(inserted.insertId), 1)
  if (! image && mime?.startsWith('image/'))
    await enqueue_preload(connection, session.scope_id, Number(inserted.insertId), [object])
  const refresh = await finish_namespace_change(connection, before)
  return { attachment_id: Number(inserted.insertId), object_key: image?.key ?? object.key, version: image?.etag ?? object.etag, refresh }
}
