import type { RowDataPacket } from 'mysql2/promise'
import { createHash } from 'node:crypto'
import { ApiError } from '@server/errors/ApiError'
import { decrypt_attachment } from '@server/lib/attachment-crypto'
import { db } from '@server/lib/db'
import { get_object, head_object, put_object, storage_bucket_name } from '@server/lib/storage'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { settings } from '@shared/settings'
import { dispose_unadopted_attachment_object } from './private-attachments.service'
import { begin_namespace_change, finish_namespace_change } from './reference-history.service'

interface LegacyRow extends RowDataPacket {
  id: number
  story_id: number
  file_name: string
  object_key: string
  version: string
  file_size: number
  mime_type: string | null
  encryption_key: string
  is_private: number
  storage_bucket: 'public' | 'private'
}
interface BackupRow extends RowDataPacket {
  attachment_id: number
  story_id: number
  old_object_key: string
  old_version: string
  old_file_size: number
  encryption_key: string
  private_object_key: string
  private_version: string
  plaintext_sha256: string
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Dry-run inventories only. Apply retains every original object and key for release-A rollback. */
export async function migrate_private_attachments(options: { apply: boolean, rollback?: boolean }) {
  const report: { id: number, status: 'candidate' | 'migrated' | 'rolled_back' | 'skipped' | 'failed', reason?: string }[] = []
  if (options.rollback) {
    const [backups] = await db.execute<BackupRow[]>('SELECT * FROM content_attachment_encryption_backup WHERE rolled_back_at IS NULL ORDER BY attachment_id')
    for (const backup of backups) {
      if (! options.apply) {
        report.push({ id: backup.attachment_id, status: 'candidate' })
        continue
      }
      // The rollback object must still be intact before a row can point at it.
      try {
        const original = await get_object('public', backup.old_object_key)
        if (original.length !== Number(backup.old_file_size) || digest(decrypt_attachment(original, backup.encryption_key)) !== backup.plaintext_sha256)
          throw new ApiError(409, '回滚密文或明文摘要核验失败')
      }
      catch (error) {
        report.push({ id: backup.attachment_id, status: 'failed', reason: safe_reason(error) })
        continue
      }
      const connection = await db.getConnection()
      try {
        await connection.beginTransaction()
        const before = await begin_namespace_change(connection, backup.story_id)
        const current = before.nodes.find(node => node.id === backup.attachment_id)
        if (! current?.is_private || current.storage_bucket !== 'private' || current.object_key !== backup.private_object_key || current.version !== backup.private_version)
          throw new ApiError(409, '附件已变化，无法自动回滚')
        await connection.execute('UPDATE content_story_attachments SET object_key = ?, version = ?, file_size = ?, encryption_key = ?, is_private = 0, storage_bucket = \'public\' WHERE id = ?', [backup.old_object_key, backup.old_version, backup.old_file_size, backup.encryption_key, backup.attachment_id])
        await connection.execute('UPDATE content_attachment_encryption_backup SET rolled_back_at = CURRENT_TIMESTAMP WHERE attachment_id = ? AND rolled_back_at IS NULL', [backup.attachment_id])
        await finish_namespace_change(connection, before)
        await connection.commit()
        report.push({ id: backup.attachment_id, status: 'rolled_back' })
        refresh(backup.story_id)
      }
      catch (error) {
        await connection.rollback()
        report.push({ id: backup.attachment_id, status: 'failed', reason: safe_reason(error) })
      }
      finally {
        connection.release()
      }
    }
    return report
  }
  if (options.apply)
    storage_bucket_name('private')
  const [rows] = await db.execute<LegacyRow[]>('SELECT * FROM content_story_attachments WHERE is_folder = 0 AND is_private = 0 AND (encryption_key IS NOT NULL OR file_name LIKE \'%.good\') ORDER BY id')
  for (const row of rows) {
    if (! row.story_id || ! row.object_key || ! row.encryption_key || ! row.file_name.endsWith('.good') || row.storage_bucket !== 'public') {
      report.push({ id: row.id, status: 'skipped', reason: '旧密文行缺少档案、对象、密钥或名称标记' })
      continue
    }
    if (Number(row.file_size) > settings.app.content.encrypt.maxSizeMb * 1024 * 1024 + 28) {
      report.push({ id: row.id, status: 'skipped', reason: '超过旧密文单文件内存迁移上限' })
      continue
    }
    if (! options.apply) {
      report.push({ id: row.id, status: 'candidate' })
      continue
    }
    const object_key = `content/att/${crypto.randomUUID()}`
    let adopted = false
    try {
      const plain = decrypt_attachment(await get_object('public', row.object_key), row.encryption_key)
      const sha256 = digest(plain)
      const version = await put_object('private', object_key, plain, row.mime_type)
      const head = await head_object('private', object_key)
      if (! version || head.size !== plain.length || head.etag !== version || digest(await get_object('private', object_key)) !== sha256)
        throw new ApiError(409, '私有副本大小、版本或 SHA-256 核验失败')
      const connection = await db.getConnection()
      try {
        await connection.beginTransaction()
        const before = await begin_namespace_change(connection, row.story_id)
        const [locked] = await connection.execute<LegacyRow[]>('SELECT * FROM content_story_attachments WHERE id = ? FOR UPDATE', [row.id])
        const current = locked[0]
        if (! current || current.story_id !== row.story_id || current.object_key !== row.object_key || current.version !== row.version || current.encryption_key !== row.encryption_key || current.is_private || current.storage_bucket !== 'public')
          throw new ApiError(409, '附件已变化，迁移未提交')
        await connection.execute('INSERT INTO content_attachment_encryption_backup (attachment_id, story_id, old_object_key, encryption_key, old_version, old_file_size, plaintext_sha256, private_object_key, private_version, private_file_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [row.id, row.story_id, row.object_key, row.encryption_key, row.version, row.file_size, sha256, object_key, version, plain.length])
        await connection.execute('UPDATE content_story_attachments SET object_key = ?, version = ?, file_size = ?, is_private = 1, storage_bucket = \'private\', encryption_key = NULL WHERE id = ? AND object_key = ? AND version = ?', [object_key, version, plain.length, row.id, row.object_key, row.version])
        await finish_namespace_change(connection, before)
        await connection.commit()
        adopted = true
        report.push({ id: row.id, status: 'migrated' })
        refresh(row.story_id)
      }
      catch (error) {
        await connection.rollback()
        throw error
      }
      finally {
        connection.release()
      }
    }
    catch (error) {
      report.push({ id: row.id, status: 'failed', reason: safe_reason(error) })
    }
    finally {
      if (! adopted)
        await dispose_unadopted_attachment_object('private', object_key)
    }
  }
  return report
}

function safe_reason(error: unknown) {
  // Storage errors can include signed URLs/credentials. Reports never echo them.
  return error instanceof ApiError ? error.message : '迁移失败，请核对该附件、备份记录与数据库／存储配置'
}
function refresh(story_id: number) {
  publish_refresh({ resource: sync_resource('content_attachments', story_id) })
  publish_refresh({ resource: sync_resource('content_story', story_id) })
  publish_refresh({ resource: sync_resource('content_stories', 'all') })
}
