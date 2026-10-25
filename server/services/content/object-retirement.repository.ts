import type { Connection } from 'mysql2/promise'
import { runtime_config } from '@config/loader'
import { ApiError } from '@server/errors/ApiError'

/** Capture destinations in the removal transaction, before a deployment can change them. */
export async function enqueue_object_retirement(connection: Connection, key: string, scope: number, reason: string) {
  const { oss, esa, esaPurge } = runtime_config().aliyun
  if (! oss)
    throw new ApiError(503, '附件退役存储尚未配置')
  await connection.execute(`INSERT IGNORE INTO content_object_retirements
    (object_key, scope_id, reason, storage_bucket, storage_endpoint, esa_site_id, esa_base_url) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [key, scope, reason, oss.bucket, oss.endpoint, esaPurge?.siteId || null, esa?.baseUrl ?? null])
}

/**
 * Only upload/image-attempt reconcilers may re-arm a completed tombstone after
 * observing a late write. Never steal a live retirement worker's lease or duty.
 */
export async function requeue_late_object(connection: Connection, key: string, scope: number) {
  const { oss, esa, esaPurge } = runtime_config().aliyun
  if (! oss)
    return
  await connection.execute(`UPDATE content_object_retirements SET phase = 'queued', purge_task_id = NULL,
    purge_requested_at = NULL, completed_at = NULL, attempts = 0, last_error_code = NULL, next_attempt_at = CURRENT_TIMESTAMP(3)
    WHERE object_key = ? AND scope_id = ? AND phase = 'completed'
    AND lease_token IS NULL AND storage_bucket = ? AND storage_endpoint = ? AND esa_site_id <=> ? AND esa_base_url <=> ?`,
  [key, scope, oss.bucket, oss.endpoint, esaPurge?.siteId || null, esa?.baseUrl ?? null])
}
