import type { content_retirement_config_schema, storage_audit_config_schema } from '@config/schema'
import type { Connection, Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { runtime_config } from '@config/loader'
import { create_aliyun_oss } from '@server/lib/aliyun-oss'
import { db } from '@server/lib/db'
import { create_esa_purge, retirement_url } from '@server/lib/esa-purge'
import { create_audit_catalog } from '@server/services/storage-audit/repository'

type Options = z.infer<typeof content_retirement_config_schema>
interface Retirement extends RowDataPacket {
  object_key: string
  scope_id: number
  phase: 'queued' | 'deleting' | 'purging' | 'completed'
  storage_bucket: string | null
  storage_endpoint: string | null
  esa_site_id: string | null
  esa_base_url: string | null
  purge_task_id: string | null
  task_age: number | null
  attempts: number
  lease_token: string
  reason?: string
}
interface Destination {
  bucket: string
  endpoint: string
  site: string
  base: string
}

/** Durable object-specific workflow; each external step runs outside the DB transaction. */
export function create_object_retirement(pool: Pick<Pool, 'execute' | 'getConnection'>, storage: Pick<ReturnType<typeof create_aliyun_oss>, 'head_object' | 'soft_delete_object'>, esa: ReturnType<typeof create_esa_purge>, destination: Destination, options: Options, audit_policy?: z.infer<typeof storage_audit_config_schema>) {
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
    finally { connection.release() }
  }
  async function claim(key: string, scope: number) {
    return transaction(async (connection) => {
      // Match namespace/publication lock order, including when the story is gone.
      await connection.execute('SELECT id FROM content_stories WHERE id = ? FOR UPDATE', [scope])
      const [rows] = await connection.execute<Retirement[]>(`SELECT *, TIMESTAMPDIFF(SECOND, purge_requested_at, CURRENT_TIMESTAMP(3)) AS task_age
        FROM content_object_retirements WHERE object_key = ? AND phase <> 'completed'
        AND next_attempt_at <= CURRENT_TIMESTAMP(3) AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP(3)) FOR UPDATE`, [key])
      const row = rows[0]
      if (! row)
        return null
      let blocked: string | null = null
      if ((row.storage_bucket !== null && row.storage_bucket !== destination.bucket)
        || (row.storage_endpoint !== null && row.storage_endpoint !== destination.endpoint)
        || (row.esa_site_id !== null && row.esa_site_id !== destination.site)
        || (row.esa_base_url !== null && row.esa_base_url !== destination.base)) {
        blocked = 'destination_changed'
      }
      try {
        retirement_url(destination.base, key)
      }
      catch { blocked = 'invalid_object_key' }
      if (! blocked && row.phase === 'queued') {
        if (row.reason === 'storage_audit_orphan') {
          const audit = audit_policy ?? runtime_config().app.storageAudit
          if (! audit.enabled || ! audit.orphanCleanup.enabled)
            blocked = 'audit_cleanup_disabled'
          else if (await create_audit_catalog(connection, destination, audit.staticKeys).ownership(key, false))
            blocked = 'audit_object_tracked'
        }
        // Current reads plus the retirement-row lock arbitrate with every adopter.
        const [live] = await connection.execute<RowDataPacket[]>('SELECT id FROM content_story_attachments WHERE object_key = ? OR original_key = ? OR avif_key = ? OR jpeg_key = ? OR redacted_avif_key = ? OR redacted_jpeg_key = ? LIMIT 1 FOR UPDATE', [key, key, key, key, key, key])
        const [jobs] = await connection.execute<RowDataPacket[]>(`SELECT id FROM content_image_jobs WHERE status IN ('queued', 'processing', 'ready', 'failed')
          AND (JSON_UNQUOTE(JSON_EXTRACT(intent, '$.input.key')) = ? OR JSON_UNQUOTE(JSON_EXTRACT(intent, '$.source.key')) = ?) LIMIT 1 FOR UPDATE`, [key, key])
        const [preloads] = await connection.execute<RowDataPacket[]>(`SELECT id FROM content_preload_jobs WHERE object_key = ? AND phase IN ('submitting', 'polling') LIMIT 1`, [key])
        // The additive migration can be pending at app startup. Never require its table early.
        const [[pin_table]] = await connection.execute<RowDataPacket[]>('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=\'content_migration_pins\'')
        const [migration_pins] = Number(pin_table?.n) ? await connection.execute<RowDataPacket[]>('SELECT object_key FROM content_migration_pins WHERE object_key=? AND retired_at IS NULL LIMIT 1 FOR UPDATE', [key]) : [[]]
        if (migration_pins.length)
          blocked = 'migration_source_pinned'
        else if (preloads.length)
          blocked = 'preload_in_progress'
        else if (live.length || jobs.length)
          blocked = 'object_referenced'
      }
      if (blocked) {
        await connection.execute(`UPDATE content_object_retirements SET last_error_code = ?, next_attempt_at = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3)) WHERE object_key = ?`, [blocked, options.retrySeconds, key])
        return null
      }
      const token = randomUUID().replaceAll('-', '')
      await connection.execute(`UPDATE content_object_retirements SET phase = IF(phase = 'queued', 'deleting', phase),
        storage_bucket = ?, storage_endpoint = ?, esa_site_id = ?, esa_base_url = ?,
        lease_token = ?, lease_until = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3)), attempts = attempts + 1
        WHERE object_key = ?`, [destination.bucket, destination.endpoint, destination.site, destination.base, token, options.leaseSeconds, key])
      return { ... row, phase: row.phase === 'queued' ? 'deleting' as const : row.phase, lease_token: token, attempts: Number(row.attempts) + 1 }
    })
  }
  async function checkpoint(row: Retirement, fields: string, values: (string | number | null)[], delay: number) {
    const [result] = await pool.execute<ResultSetHeader>(`UPDATE content_object_retirements SET ${fields},
      lease_token = NULL, lease_until = NULL, next_attempt_at = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3))
      WHERE object_key = ? AND lease_token = ? AND lease_until > CURRENT_TIMESTAMP(3)`, [... values, delay, row.object_key, row.lease_token])
    return result.affectedRows > 0
  }
  async function origin_absent(key: string) {
    try {
      await storage.head_object(key)
    }
    catch (error) {
      if ((error as { status?: number }).status === 404)
        return true
      throw error
    }
    return false
  }
  async function execute(row: Retirement) {
    let error_code = 'origin_delete_failed'
    try {
      if (row.phase === 'deleting') {
        if (! await origin_absent(row.object_key))
          await storage.soft_delete_object(row.object_key)
        if (! await origin_absent(row.object_key))
          throw new Error('Origin deletion not confirmed')
        // A 404 confirms only the origin; the edge purge duty must survive it.
        await checkpoint(row, 'phase = \'purging\', last_error_code = NULL, attempts = 0', [], 0)
        return
      }
      error_code = 'esa_request_failed'
      if (! row.purge_task_id) {
        // Persist intent before sending. If the acknowledgement is lost, an
        // exact-file purge can safely be resubmitted; never guess it completed.
        const [owned] = await pool.execute<ResultSetHeader>(`UPDATE content_object_retirements SET purge_requested_at = CURRENT_TIMESTAMP(3)
          WHERE object_key = ? AND lease_token = ? AND lease_until > CURRENT_TIMESTAMP(3)`, [row.object_key, row.lease_token])
        if (! owned.affectedRows)
          return
        const task = await esa.submit(destination.base, row.object_key)
        await checkpoint(row, 'purge_task_id = ?, last_error_code = NULL, attempts = 0', [task], options.pollSeconds)
        return
      }
      const status = await esa.status(destination.base, row.object_key, row.purge_task_id)
      if (status === 'Complete') {
        await checkpoint(row, 'phase = \'completed\', completed_at = CURRENT_TIMESTAMP(3), last_error_code = NULL', [], 0)
      }
      else if (status === 'Failed' || Number(row.task_age) >= options.taskTimeoutSeconds) {
        await checkpoint(row, 'purge_task_id = NULL, last_error_code = ?', [status === 'Failed' ? 'esa_task_failed' : 'esa_task_timeout'], options.retrySeconds)
      }
      else {
        await checkpoint(row, 'last_error_code = ?, attempts = 0', [status === 'Missing' ? 'esa_task_not_visible' : null], options.pollSeconds)
      }
    }
    catch {
      const delay = Math.min(options.maxRetrySeconds, options.retrySeconds * 2 ** Math.min(Number(row.attempts) - 1, 16))
      await checkpoint(row, 'last_error_code = ?', [error_code], delay)
    }
  }
  async function sweep(scope?: number, signal?: AbortSignal) {
    if (! options.enabled || signal?.aborted)
      return
    const [rows] = await pool.execute<Retirement[]>(`SELECT object_key, scope_id FROM content_object_retirements
      WHERE phase <> 'completed' AND next_attempt_at <= CURRENT_TIMESTAMP(3) AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP(3))
      ${scope === undefined ? '' : 'AND scope_id = ?'} ORDER BY next_attempt_at, created_at, object_key LIMIT ${options.scanLimit}`, scope === undefined ? [] : [scope])
    for (const candidate of rows) {
      if (signal?.aborted)
        break
      const row = await claim(candidate.object_key, Number(candidate.scope_id))
      if (row)
        await execute(row)
    }
  }
  return { sweep }
}

export async function sweep_object_retirements(scope?: number, signal?: AbortSignal) {
  const { aliyun, app } = runtime_config()
  // Provisioning must not drop work, delete from an unbound destination, or
  // depend on the image-processing feature switch.
  if (! app.contentRetirement.enabled || ! aliyun.oss || ! aliyun.esa || ! aliyun.esaPurge?.siteId || ! aliyun.esaPurge.accessKeyId || ! aliyun.esaPurge.accessKeySecret)
    return
  const service = create_object_retirement(db, create_aliyun_oss(aliyun.oss), create_esa_purge(aliyun.esaPurge), {
    bucket: aliyun.oss.bucket, endpoint: aliyun.oss.endpoint, site: aliyun.esaPurge.siteId, base: aliyun.esa.baseUrl,
  }, app.contentRetirement)
  await service.sweep(scope, signal)
}
