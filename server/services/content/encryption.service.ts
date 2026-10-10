import type { ContentAttachmentBatchResult, ContentBatchSkipped } from '@shared/types/content'
import { ApiError } from '@server/errors/ApiError'
import { decrypt_attachment, encrypt_attachment } from '@server/lib/attachment-crypto'
import { db } from '@server/lib/db'
import { delete_object_best_effort, get_object, put_object } from '@server/lib/storage'
import { list_scope_file_rows, list_scope_paths, update_attachment_row_encryption } from '@server/services/content-attachments.service'
import { publish_attachment_change, publish_attachment_refresh, rewrite_story_attachment_refs, with_attachment_lock } from '@server/services/content/attachment-structure.service'
import { get_story } from '@server/services/content/story.service'
import { attachment_name_conflict_message, attachment_path_taken, decrypted_attachment_name, encrypted_attachment_suffix, is_encrypted_attachment } from '@shared/content-markdown'
import { settings } from '@shared/settings'

export async function encrypt_attachments(story_id: number, file_names: string[]) {
  return await transform_attachment_encryption(story_id, 'encrypt', file_names)
}

export async function decrypt_attachments(story_id: number, file_names: string[]) {
  return await transform_attachment_encryption(story_id, 'decrypt', file_names)
}

/**
 * Encrypts or decrypts attachments in place: downloads each object, uploads
 * the transformed bytes under a fresh object key, and swaps the row's name
 * (`.good` suffix on/off), object and key in one transaction — references are
 * rewritten like a rename. The OSS transfers run outside the transaction
 * (they can outlive a lease); old objects are deleted only after the commit.
 */
async function transform_attachment_encryption(story_id: number, kind: 'encrypt' | 'decrypt', file_names: string[]): Promise<ContentAttachmentBatchResult> {
  return await with_attachment_lock(story_id, kind, async () => {
    const rows = await list_scope_file_rows(story_id, file_names)
    const by_name = new Map(rows.map(row => [row.file_name, row]))
    const skipped: ContentBatchSkipped[] = []
    const ordered = [... new Set(file_names)].flatMap((name) => {
      const row = by_name.get(name)
      if (! row) {
        skipped.push({ file_name: name, reason: '附件不存在或已被删除' })
        return []
      }
      return [row]
    })
    const encrypting = kind === 'encrypt'
    const targets = ordered.filter((row) => {
      // A row qualifies only when its state differs from the goal: encrypt
      // takes plaintext rows, decrypt takes `.good` rows.
      if (encrypting !== is_encrypted_attachment(row.file_name))
        return true
      skipped.push({ file_name: row.file_name, reason: encrypting ? '已加密' : '未加密' })
      return false
    })
    if (! targets.length) {
      publish_attachment_refresh(story_id)
      const attachments = (await get_story(story_id)).attachments
      return { attachments, succeeded: [], skipped }
    }
    if (encrypting) {
      const max_bytes = settings.app.content.encrypt.maxSizeMb * 1024 * 1024
      for (const row of [... targets]) {
        if (Number(row.file_size) > max_bytes) {
          skipped.push({ file_name: row.file_name, reason: '文件太大' })
          targets.splice(targets.indexOf(row), 1)
        }
      }
    }

    // The new display names must be free (a decrypt can land on a plaintext name).
    // Deliberately not `resolve_attachment_name`: encrypting is the one operation
    // whose whole purpose is to produce a `.good` name, so the intrinsic rule
    // that reserves the suffix must not apply here — only the conflict does.
    const planned = targets.map(row => ({
      row,
      new_file_name: encrypting ? `${row.file_name}${encrypted_attachment_suffix}` : decrypted_attachment_name(row.file_name),
    }))
    const moving_away = new Set(planned.map(plan => plan.row.file_name.toLowerCase()))
    const remaining = (await list_scope_paths(story_id)).filter(path => ! moving_away.has(path.toLowerCase()))
    const available: typeof planned = []
    for (const plan of planned) {
      const destinations = available.map(item => item.new_file_name)
      if (attachment_path_taken([... remaining, ... destinations], plan.new_file_name)) {
        skipped.push({ file_name: plan.row.file_name, reason: attachment_name_conflict_message })
        continue
      }
      available.push(plan)
    }
    planned.splice(0, planned.length, ... available)

    if (! planned.length) {
      publish_attachment_refresh(story_id)
      const attachments = (await get_story(story_id)).attachments
      return { attachments, succeeded: [], skipped }
    }

    const processed: { row: (typeof planned)[number]['row'], new_file_name: string, object_key: string, version: string, encryption_key: string | null, file_size: number }[] = []
    try {
      for (const plan of planned) {
        const source = await get_object(plan.row.object_key!)
        const object_key = `content/att/${crypto.randomUUID()}`
        if (encrypting) {
          const { key, data } = encrypt_attachment(source)
          const version = await put_object(object_key, data, null)
          processed.push({ ... plan, object_key, version: version ?? '', encryption_key: key, file_size: data.length })
        }
        else {
          if (! plan.row.encryption_key)
            throw new ApiError(409, '附件缺少密钥，无法解密')
          let data: Uint8Array
          try {
            data = decrypt_attachment(source, plan.row.encryption_key)
          }
          catch {
            throw new ApiError(409, `附件解密失败：${plan.row.file_name}`)
          }
          const version = await put_object(object_key, data, plan.row.mime_type)
          processed.push({ ... plan, object_key, version: version ?? '', encryption_key: null, file_size: data.length })
        }
      }
    }
    catch (ex) {
      await Promise.all(processed.map(item => delete_object_best_effort(item.object_key)))
      throw ex
    }

    const connection = await db.getConnection()
    try {
      await connection.beginTransaction()
      for (const item of processed) {
        await update_attachment_row_encryption(item.row.id, {
          file_name: item.new_file_name,
          object_key: item.object_key,
          file_size: item.file_size,
          version: item.version,
          encryption_key: item.encryption_key,
        }, connection)
      }
      await rewrite_story_attachment_refs(connection, story_id, processed.map(item => ({ old_file_name: item.row.file_name, new_file_name: item.new_file_name })))
      await connection.commit()
    }
    catch (ex) {
      await connection.rollback()
      await Promise.all(processed.map(item => delete_object_best_effort(item.object_key)))
      throw ex
    }
    finally {
      connection.release()
    }
    for (const item of processed)
      await delete_object_best_effort(item.row.object_key!)
    await publish_attachment_change(story_id)
    const attachments = (await get_story(story_id)).attachments
    return {
      attachments,
      succeeded: processed.map(item => item.row.file_name),
      skipped,
    }
  })
}
