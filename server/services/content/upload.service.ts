import type { ContentUploadSignRequest } from '@shared/types/content'
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectCommand, ListPartsCommand, PutObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { copy_object, delete_object_best_effort, head_object, put_object, signed_object_url } from '@server/lib/storage'
import { create_folder_rows, get_scope_attachment, get_scope_object_keys, insert_attachment_row, list_scope_file_rows, list_scope_paths, update_attachment_row_object } from '@server/services/content-attachments.service'
import { publish_attachment_change, resolve_attachment_name, with_attachment_lock } from '@server/services/content/attachment-structure.service'
import { cover_version_from, get_story } from '@server/services/content/story.service'
import { runtime_config } from '@shared/config'
import { attachment_ancestor_folders, attachment_download_name, attachment_folder_of, attachment_mime_type, attachment_path_join, decrypted_attachment_name, is_encrypted_attachment, redactable_attachment_mime, rename_attachment_references, sanitize_attachment_file_name, sanitize_attachment_path } from '@shared/content-markdown'

const config = runtime_config()

const upload_url_expires_seconds = config.app.content.upload.urlTtlSeconds

function content_upload_key_prefix(story_id: number) {
  return `content-upload/${story_id}/`
}

function assert_content_upload_key(story_id: number, key: string) {
  const prefix = content_upload_key_prefix(story_id)
  if (! key.startsWith(prefix) || ! /^[\w-]+$/.test(key.slice(prefix.length)))
    throw new ApiError(400, '上传凭证无效')
}

export async function sign_attachment_upload(input: ContentUploadSignRequest) {
  assert_content_upload_key(input.story_id, input.key)
  await get_story(input.story_id)

  const common = { Bucket: config.oss.bucket, Key: input.key }
  let command
  let return_key = false
  if (input.method === 'PUT' && input.upload_id && input.part_number) {
    command = new UploadPartCommand({ ... common, UploadId: input.upload_id, PartNumber: input.part_number })
  }
  else if (input.method === 'PUT') {
    command = new PutObjectCommand({ ... common, ContentType: input.content_type || undefined })
    return_key = true
  }
  else if (input.method === 'POST' && ! input.upload_id) {
    command = new CreateMultipartUploadCommand(common)
    return_key = true
  }
  else if (input.method === 'POST' && input.upload_id) {
    command = new CompleteMultipartUploadCommand({ ... common, UploadId: input.upload_id })
  }
  else if (input.method === 'GET' && input.upload_id) {
    command = new ListPartsCommand({ ... common, UploadId: input.upload_id })
  }
  else if (input.method === 'DELETE' && input.upload_id) {
    command = new AbortMultipartUploadCommand({ ... common, UploadId: input.upload_id })
  }
  else {
    throw new ApiError(400, '不支持的上传操作')
  }

  return {
    url: await signed_object_url(command, upload_url_expires_seconds),
    ... (return_key ? { key: input.key } : {}),
  }
}

/** RFC 5987 ext-value: encodeURIComponent minus the few characters it leaves bare. */
function rfc5987_ext_value(value: string) {
  return encodeURIComponent(value).replace(/['()*!]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Signs a short-lived object GET that saves the attachment under its row name.
 *
 * The object itself is public but nameless (a uuid key, no stored
 * Content-Disposition), so the name rides on the signature's
 * `response-content-disposition` override — the browser then saves the file
 * under it while the host keeps streaming the bytes.
 */
export async function sign_attachment_download(story_id: number, file_name: string) {
  await get_story(story_id)
  const rows = await list_scope_file_rows(story_id, [file_name])
  const row = rows[0]
  if (! row)
    throw new ApiError(404, '附件不存在或已被删除')
  // The object at the row's key is ciphertext; naming it after the plaintext
  // would hand out a corrupt file. Encrypted rows download through the
  // client-side decrypt path, never through this signature.
  if (row.encryption_key !== null)
    throw new ApiError(400, '加密的附件请在页面中下载')

  const url = await signed_object_url(new GetObjectCommand({
    Bucket: config.oss.bucket,
    Key: row.object_key!,
    ResponseContentDisposition: `attachment; filename*=UTF-8''${rfc5987_ext_value(attachment_download_name(row.file_name))}`,
  }), config.app.content.download.urlTtlSeconds)
  return { url }
}

export async function confirm_attachment_upload(story_id: number, key: string, raw_file_name: string) {
  assert_content_upload_key(story_id, key)
  const object = await head_object(key)
  const base_name = sanitize_attachment_path(raw_file_name, config.app.content.link.fileNameMaxBytes)
  // A signed upload can outlive its story, so the scope is revalidated here.
  await get_story(story_id)
  const file_name = resolve_attachment_name(base_name, await list_scope_paths(story_id), 'suffix')
  const target_key = `content/att/${crypto.randomUUID()}`
  const etag = await copy_object(key, target_key)
  await delete_object_best_effort(key)
  const version = etag ?? object.etag ?? String(Date.now())
  try {
    await insert_attachment_row({
      story_id,
      file_name,
      object_key: target_key,
      mime_type: attachment_mime_type(file_name),
      file_size: object.size,
      version,
    })
  }
  catch (ex) {
    await delete_object_best_effort(target_key)
    throw ex
  }

  await materialize_attachment_folders(story_id, file_name)
  await publish_attachment_change(story_id)
  const row = await get_scope_attachment(story_id, file_name)
  if (! row)
    throw new ApiError(500, '附件写入失败，请重试')
  return row
}

function get_form_file(form: FormData, field: string) {
  const file = form.get(field)
  if (! (file instanceof Blob) || file.size === 0) {
    throw new ApiError(400, '请先选择要上传的文件')
  }
  return file
}

/**
 * A file landing inside a folder makes that folder a row of its own.
 *
 * Folders otherwise exist only implicitly, through the files under them, so an
 * uploaded folder would disappear the moment its last file was deleted or moved
 * out — taking the structure the author uploaded with it. Recording the folder
 * when it first receives a file is what makes "every folder has a row" hold, so
 * no later operation has to invent one. Existing rows are kept, so a second
 * file in the same folder (or a re-upload) costs nothing.
 *
 * A directory that is empty to begin with still cannot arrive this way: a
 * picker yields no files for it, which is what 新建文件夹 is for.
 */
export async function materialize_attachment_folders(story_id: number, file_name: string) {
  const ancestors = attachment_ancestor_folders(file_name)
  if (ancestors.length)
    await create_folder_rows(story_id, ancestors)
}

/** Magic bytes of the formats the 删减版 editor can hand back, for a cheap payload check. */
function sniff_image_mime(data: Uint8Array) {
  const starts_with = (... bytes: number[]) => bytes.every((byte, index) => data[index] === byte)
  if (starts_with(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
    return 'image/png'
  if (starts_with(0xFF, 0xD8, 0xFF))
    return 'image/jpeg'
  if (starts_with(0x42, 0x4D))
    return 'image/bmp'
  if (starts_with(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50)
    return 'image/webp'
  return null
}

/**
 * Stores the public 删减版 of an encrypted image: a new plaintext attachment
 * named like the encrypted file without its `.good` suffix, holding the
 * redacted bitmap the editor exported. The twin keeps the source format, so a
 * GIF (or any format the canvas cannot re-encode) is refused rather than
 * silently transcoded, and the name is never taken over — an existing twin is
 * a conflict the caller has to resolve, since replacing it would be a silent
 * edit of a file that may already be published.
 */
export async function create_abridged_attachment(story_id: number, source_file_name: string, input: FormData) {
  return await with_attachment_lock(story_id, 'redact', async () => {
    const [source] = await list_scope_file_rows(story_id, [source_file_name])
    if (! source)
      throw new ApiError(404, '附件不存在或已被删除')
    if (! source.encryption_key || ! is_encrypted_attachment(source.file_name))
      throw new ApiError(400, '只有已加密的图片才能创建删减版')
    const file_name = decrypted_attachment_name(source.file_name)
    const mime_type = redactable_attachment_mime(file_name)
    if (! mime_type)
      throw new ApiError(400, '该图片格式不支持创建删减版')

    const upload = get_form_file(input, 'file')
    const file_data = Buffer.from(await upload.arrayBuffer())
    // The exported bytes must match the name they land under; the client sends
    // no type of its own, so this is the only check the payload gets.
    if (sniff_image_mime(file_data) !== mime_type)
      throw new ApiError(400, '删减版内容与文件格式不符')

    const existing = await list_scope_paths(story_id)
    // The twin keeps the source's plaintext name, so it can never itself carry
    // the `.good` suffix; the guard is here so this path answers to the same
    // rules as every other name, including a folder in the way.
    resolve_attachment_name(file_name, existing, 'reject')

    const object_key = `content/att/${crypto.randomUUID()}`
    const etag = await put_object(object_key, file_data, mime_type)
    const version = etag ?? String(Date.now())
    try {
      await insert_attachment_row({
        story_id,
        file_name,
        object_key,
        mime_type,
        file_size: file_data.length,
        version,
      })
    }
    catch (ex) {
      await delete_object_best_effort(object_key)
      throw ex
    }

    await publish_attachment_change(story_id)
    const row = await get_scope_attachment(story_id, file_name)
    if (! row)
      throw new ApiError(500, '附件写入失败，请重试')
    return row
  })
}

/** Compute the extension (including the dot) of a file name, or '' when absent. */
function file_extension(file_name: string) {
  const dot = file_name.lastIndexOf('.')
  return dot > 0 ? file_name.slice(dot) : ''
}

function file_stem(file_name: string) {
  const dot = file_name.lastIndexOf('.')
  return dot > 0 ? file_name.slice(0, dot) : file_name
}

export async function replace_attachment(
  story_id: number,
  old_file_name: string,
  key: string,
  raw_file_name: string,
  content_type: string | null,
  mode: 'keep-name' | 'new-name',
) {
  assert_content_upload_key(story_id, key)
  return await apply_attachment_replace(story_id, old_file_name, key, raw_file_name, content_type, mode)
}

/**
 * The lock-free core of replace_attachment; the task executor calls this with
 * path locks already held. `key` is already-uploaded bytes (the legacy path
 * validates its staging prefix before calling, the task path allocated it).
 */
export async function apply_attachment_replace(
  story_id: number,
  old_file_name: string,
  key: string,
  raw_file_name: string,
  content_type: string | null,
  mode: 'keep-name' | 'new-name',
) {
  const story = await get_story(story_id)
  const attachments = story.attachments
  const attachment = attachments.find(item => item.file_name === old_file_name)
  if (! attachment) {
    throw new ApiError(404, '附件不存在或已被删除')
  }
  // A replacement swaps the object but not the row's key, so replacing an
  // encrypted file would leave a key on plaintext bytes: the client would try
  // to decrypt readable content and the file would end up unopenable. Leaving
  // the encrypted state is 取消加密's job, not a file swap's.
  if (attachment.is_encrypted)
    throw new ApiError(409, '已加密的附件不能替换，请先取消加密')

  const object = await head_object(key)
  const new_name = sanitize_attachment_file_name(raw_file_name || 'file', config.app.content.link.fileNameMaxBytes)
  // The scope's files and folders share one path space, so a replacement has to
  // clear both before it can take a name.
  const existing = await list_scope_paths(story_id)

  // Resolve the replacement file name. `keep-name` reuses the old stem but
  // adopts the new file's extension; `new-name` uses the new file's name fully.
  // Both go through the shared guard: the incoming extension is the one piece
  // of the name the uploader controls, so `.good` has to be refused here too.
  let file_name: string
  if (mode === 'keep-name') {
    const new_ext = file_extension(new_name)
    file_name = resolve_attachment_name(
      new_ext ? `${file_stem(old_file_name)}${new_ext}` : old_file_name,
      existing,
      'reject',
      old_file_name,
    )
  }
  else {
    // Keep the replacement in the same folder as the file it replaces.
    file_name = resolve_attachment_name(
      attachment_path_join(attachment_folder_of(old_file_name), new_name),
      existing,
      'suffix',
      old_file_name,
    )
  }

  const old_keys = await get_scope_object_keys(story_id, [old_file_name])
  // A replacement always lands on a fresh object; the old one is deleted after.
  const object_key = `content/att/${crypto.randomUUID()}`
  const etag = await copy_object(key, object_key)
  await delete_object_best_effort(key)
  const version = etag ?? object.etag ?? String(Date.now())

  try {
    // Rewrite markdown/cover references only when the final name changed.
    const markdown = file_name === old_file_name
      ? story.markdown
      : rename_attachment_references(story.markdown, old_file_name, file_name)
    const renamed_cover = story.cover === old_file_name ? file_name : (story.cover ?? '')
    const cover_version = cover_version_from(story.attachments, renamed_cover, { file_name, version })
    // An in-place replacement of the cover file rewrites no references but the etag.
    const cover_object_rewritten = renamed_cover !== '' && renamed_cover === file_name
    if (markdown !== story.markdown || renamed_cover !== (story.cover ?? '') || cover_object_rewritten) {
      await db.execute('UPDATE content_stories SET markdown = ?, cover = ?, cover_version = ? WHERE id = ?', [markdown, renamed_cover, cover_version, story.id])
    }
    await update_attachment_row_object(story_id, old_file_name, {
      file_name,
      object_key,
      mime_type: content_type || attachment_mime_type(file_name),
      file_size: object.size,
      version,
    })
  }
  catch (ex) {
    await delete_object_best_effort(object_key)
    throw ex
  }

  await Promise.all(old_keys.map(key => delete_object_best_effort(key)))

  await publish_attachment_change(story_id)
  const row = await get_scope_attachment(story_id, file_name)
  if (! row)
    throw new ApiError(500, '附件写入失败，请重试')
  return row
}
