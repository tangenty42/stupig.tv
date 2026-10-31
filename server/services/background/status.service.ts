import type { Pool, RowDataPacket } from 'mysql2/promise'
import { runtime_config } from '@config/loader'
import { db } from '@server/lib/db'
import { local_background_status } from '@server/services/content/background.service'

// Fixed SQL only. Never return payloads, keys, signed URLs or cloud error messages.
const ledgers = [
  { id: 'receipts', table: 'content_command_receipts', phase: 'CASE WHEN JSON_LENGTH(result) = 0 THEN \'compacted\' WHEN expires_at <= CURRENT_TIMESTAMP(3) THEN \'expired\' ELSE \'replayable\' END', error: 'NULL', pending: 'expires_at <= CURRENT_TIMESTAMP(3) AND JSON_LENGTH(result) > 0', due: 'expires_at <= CURRENT_TIMESTAMP(3) AND JSON_LENGTH(result) > 0', lease: 'FALSE', where: '1 = 1' },
  { id: 'images', table: 'content_image_jobs', phase: 'status', error: 'error_code', pending: 'status IN (\'queued\', \'processing\', \'ready\')', due: 'status IN (\'queued\', \'ready\', \'processing\') AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP(3))', lease: 'lease_until > CURRENT_TIMESTAMP(3)', where: '1 = 1' },
  { id: 'uploads', table: 'content_transfer_sessions', phase: 'status', error: 'NULL', pending: 'status IN (\'queued\', \'uploading\', \'running\', \'verifying\')', due: 'status IN (\'queued\', \'uploading\', \'running\', \'verifying\') AND expires_at <= CURRENT_TIMESTAMP(3)', lease: 'lease_until > CURRENT_TIMESTAMP(3)', where: 'operation = \'upload\'' },
  { id: 'retirement', table: 'content_object_retirements', phase: 'phase', error: 'last_error_code', pending: 'phase <> \'completed\'', due: 'phase <> \'completed\' AND next_attempt_at <= CURRENT_TIMESTAMP(3) AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP(3))', lease: 'lease_until > CURRENT_TIMESTAMP(3)', where: '1 = 1' },
  { id: 'preload', table: 'content_preload_jobs', phase: 'phase', error: 'last_error_code', pending: 'phase IN (\'queued\', \'submitting\', \'polling\')', due: 'phase IN (\'queued\', \'submitting\', \'polling\') AND next_attempt_at <= CURRENT_TIMESTAMP(3)', lease: 'FALSE', where: '1 = 1' },
  { id: 'sync', table: 'content_sync_outbox', phase: '\'pending\'', error: 'last_error_code', pending: 'TRUE', due: 'next_attempt_at <= CURRENT_TIMESTAMP(3) AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP(3))', lease: 'lease_until > CURRENT_TIMESTAMP(3)', where: '1 = 1' },
  { id: 'storage_audit', table: 'storage_audit_targets', phase: 'phase', error: 'last_error_code', pending: 'phase <> \'completed\'', due: 'next_run_at <= CURRENT_TIMESTAMP(3) AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP(3))', lease: 'lease_until > CURRENT_TIMESTAMP(3)', where: '1 = 1' },
]

export async function read_background_ledgers(pool: Pick<Pool, 'execute'>) {
  const result = await Promise.all(ledgers.map(async (spec) => {
    const [rows] = await pool.execute<RowDataPacket[]>(`SELECT ${spec.phase} AS phase, ${spec.error} AS error_code, COUNT(*) AS total,
      SUM(IF(${spec.pending}, 1, 0)) AS pending, SUM(IF(${spec.due}, 1, 0)) AS due,
      SUM(IF(${spec.lease}, 1, 0)) AS leased, MIN(IF(${spec.pending}, created_at, NULL)) AS oldest_pending_at
      FROM ${spec.table} WHERE ${spec.where} GROUP BY ${spec.phase}, ${spec.error}`)
    return { id: spec.id, groups: rows.map(row => ({ phase: String(row.phase),
      error_code: typeof row.error_code === 'string' && /^[\w-]{1,80}$/.test(row.error_code) ? row.error_code : null,
      total: Number(row.total), pending: Number(row.pending), due: Number(row.due), leased: Number(row.leased),
      oldest_pending_at: row.oldest_pending_at ? new Date(row.oldest_pending_at).toISOString() : null })) }
  }))
  const [sites] = await pool.execute<RowDataPacket[]>(`SELECT last_error_code, COUNT(*) AS total,
    SUM(IF(lease_until > CURRENT_TIMESTAMP(3), 1, 0)) AS leased FROM content_preload_sites GROUP BY last_error_code`)
  const [audit] = await pool.execute<RowDataPacket[]>('SELECT kind,COUNT(*) AS total FROM storage_audit_findings WHERE resolved_at IS NULL GROUP BY kind')
  const [targets] = await pool.execute<RowDataPacket[]>(`SELECT destination_id,phase,references_checked,objects_checked,cycle_started_at,last_completed_at,next_run_at,last_error_code
    FROM storage_audit_targets ORDER BY destination_id`)
  const iso = (value: unknown) => value ? new Date(value as string | Date).toISOString() : null
  return { ledgers: result, storage_audit: targets.map(row => ({ destination_id: String(row.destination_id), phase: String(row.phase),
    references_checked: Number(row.references_checked), objects_checked: Number(row.objects_checked), cycle_started_at: iso(row.cycle_started_at),
    last_completed_at: iso(row.last_completed_at), next_run_at: iso(row.next_run_at), error_code: typeof row.last_error_code === 'string' && /^[\w-]{1,80}$/.test(row.last_error_code) ? row.last_error_code : null })),
  storage_audit_findings: audit.map(row => ({ kind: String(row.kind), total: Number(row.total) })), preload_targets: sites.map(row => ({ total: Number(row.total), leased: Number(row.leased),
    error_code: typeof row.last_error_code === 'string' && /^[\w-]{1,80}$/.test(row.last_error_code) ? row.last_error_code : null })) }
}

export async function get_background_status() {
  return { mode: runtime_config().app.backgroundRunner.mode, process: local_background_status(), database: await read_background_ledgers(db) }
}
