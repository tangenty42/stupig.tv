import type { RowDataPacket } from 'mysql2/promise'
import { create_aliyun_oss } from '@server/lib/aliyun-oss'
import { db } from '@server/lib/db'
import { log_error } from '@server/lib/log'
import { delete_object_best_effort } from '@server/lib/storage'

/** A lost commit acknowledgement must never make compensation delete a live object. */
export async function dispose_unadopted_attachment_object(bucket: 'public' | 'private', key: string, provider: 'legacy' | 'aliyun' = 'legacy') {
  try {
    if (provider === 'aliyun') {
      const [live] = await db.execute<RowDataPacket[]>('SELECT id FROM content_story_attachments WHERE object_key = ? AND storage_provider = \'aliyun\' LIMIT 1', [key])
      if (! live.length)
        await create_aliyun_oss().soft_delete_object(key)
      return
    }
    const [rows] = await db.execute<RowDataPacket[]>('SELECT id FROM content_story_attachments WHERE object_key = ? AND storage_bucket = ? UNION SELECT b.attachment_id FROM content_attachment_encryption_backup b WHERE b.old_object_key = ? OR (b.private_object_key = ? AND EXISTS (SELECT 1 FROM content_story_attachments a WHERE a.id = b.attachment_id AND a.storage_bucket = \'private\' AND a.object_key = b.private_object_key AND a.version = b.private_version)) UNION SELECT attachment_id FROM content_attachment_storage_migrations WHERE state <> \'retired\' AND (source_key = ? OR target_key = ?) LIMIT 1', [key, bucket, key, key, key, key])
    if (! rows.length)
      await delete_object_best_effort(bucket, key)
  }
  catch {
    // Leave an orphan for reconciliation when DB state cannot be confirmed.
    log_error('private-attachment-compensation-deferred', { bucket, key })
  }
}
