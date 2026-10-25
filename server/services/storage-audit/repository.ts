import type { StorageAuditFinding, StorageAuditKind } from '@shared/types/storage-audit'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { createHash, randomUUID } from 'node:crypto'

export interface AuditState extends RowDataPacket {
  destination_id: string
  cycle_id: string
  previous_cycle_id?: string | null
  phase: 'attachments' | 'avatars' | 'static' | 'objects' | 'findings' | 'completed'
  row_cursor: number
  role_cursor: number
  object_cursor: Buffer | string | null
  cycle_started_at: Date
}
export interface AuditIssue { key: string, kind: StorageAuditKind, expected?: number | null, observed?: number | null, modified_at?: Date }
export type AuditPool = Pick<Pool, 'execute' | 'getConnection'>
export function audit_destination(bucket: string, endpoint: string) {
  return createHash('sha256').update(JSON.stringify([bucket, new URL(endpoint).origin])).digest('hex')
}
export const audit_roles = ['object_key', 'original_key', 'avif_key', 'jpeg_key', 'redacted_avif_key', 'redacted_jpeg_key'] as const
export const audit_key = (key: Buffer | string | null) => key === null ? '' : key.toString()

export function create_audit_repository(pool: AuditPool, destination: { bucket: string, endpoint: string }, lease_seconds: number) {
  const id = audit_destination(destination.bucket, destination.endpoint)
  const token = randomUUID().replaceAll('-', '')
  async function fenced<T>(work: (connection: PoolConnection) => Promise<T>) {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT destination_id FROM storage_audit_targets
        WHERE destination_id=? AND lease_token=? AND lease_until>CURRENT_TIMESTAMP(3) FOR UPDATE`, [id, token])
      if (! rows.length)
        throw new Error('audit_lease_lost')
      const result = await work(connection)
      await connection.commit()
      return result
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
    finally { connection.release() }
  }
  return {
    id,
    async claim() {
      await pool.execute(`INSERT IGNORE INTO storage_audit_targets (destination_id, storage_bucket, storage_endpoint, cycle_id)
        VALUES (?, ?, ?, ?)`, [id, destination.bucket, destination.endpoint, randomUUID().replaceAll('-', '')])
      const [result] = await pool.execute<ResultSetHeader>(`UPDATE storage_audit_targets SET lease_token=?, lease_until=TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3))
        WHERE destination_id=? AND next_run_at<=CURRENT_TIMESTAMP(3) AND (lease_until IS NULL OR lease_until<=CURRENT_TIMESTAMP(3))`, [token, lease_seconds, id])
      if (! result.affectedRows)
        return null
      return fenced(async (connection) => {
        await connection.execute(`UPDATE storage_audit_targets SET previous_cycle_id=IF(last_completed_at IS NULL,NULL,cycle_id), cycle_id=?, phase='attachments', row_cursor=0, role_cursor=0, object_cursor=NULL,
          references_checked=0, objects_checked=0, cycle_started_at=CURRENT_TIMESTAMP(3), last_error_code=NULL
          WHERE destination_id=? AND phase='completed'`, [randomUUID().replaceAll('-', ''), id])
        const [rows] = await connection.execute<AuditState[]>('SELECT * FROM storage_audit_targets WHERE destination_id=?', [id])
        return rows[0]!
      })
    },
    async renew() {
      const [result] = await pool.execute<ResultSetHeader>(`UPDATE storage_audit_targets SET lease_until=TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3))
        WHERE destination_id=? AND lease_token=? AND lease_until>CURRENT_TIMESTAMP(3)`, [lease_seconds, id, token])
      if (! result.affectedRows)
        throw new Error('audit_lease_lost')
    },
    async checkpoint(state: AuditState, issues: AuditIssue[] = [], resolve_id: number | null = null, checked_references = 0, checked_objects = 0) {
      await fenced(async (connection) => {
        for (const issue of issues) {
          const hash = createHash('sha256').update(JSON.stringify([id, issue.key, issue.kind])).digest('hex')
          await connection.execute(`INSERT INTO storage_audit_findings
            (destination_id, finding_hash, object_key, kind, expected_size, observed_size, last_seen_cycle,object_modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
            observations=IF(resolved_at IS NOT NULL OR NOT(object_modified_at<=>VALUES(object_modified_at)) OR NOT(observed_size<=>VALUES(observed_size)),1,
              IF(last_seen_cycle=VALUES(last_seen_cycle),observations,IF(last_seen_cycle<=>?,observations+1,1))),
            expected_size=VALUES(expected_size), observed_size=VALUES(observed_size), object_modified_at=VALUES(object_modified_at),
            first_seen_at=IF(resolved_at IS NULL,first_seen_at,CURRENT_TIMESTAMP(3)), resolved_at=NULL,
            last_seen_at=CURRENT_TIMESTAMP(3), last_seen_cycle=VALUES(last_seen_cycle)`,
          [id, hash, Buffer.from(issue.key), issue.kind, issue.expected ?? null, issue.observed ?? null, state.cycle_id, issue.modified_at ?? null, state.previous_cycle_id ?? null])
        }
        if (resolve_id !== null) {
          await connection.execute('UPDATE storage_audit_findings SET resolved_at=CURRENT_TIMESTAMP(3) WHERE id=? AND destination_id=? AND resolved_at IS NULL', [resolve_id, id])
        }
        await connection.execute(`UPDATE storage_audit_targets SET phase=?, row_cursor=?, role_cursor=?, object_cursor=?,
          references_checked=references_checked+?, objects_checked=objects_checked+? WHERE destination_id=?`,
        [state.phase, state.row_cursor, state.role_cursor, state.object_cursor === null ? null : Buffer.from(state.object_cursor), checked_references, checked_objects, id])
      })
    },
    async release(delay: number, error: string | null = null) {
      await fenced(async (connection) => {
        await connection.execute(`UPDATE storage_audit_targets SET lease_token=NULL, lease_until=NULL, last_error_code=?,
          next_run_at=TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3)), last_completed_at=IF(phase='completed',CURRENT_TIMESTAMP(3),last_completed_at)
          WHERE destination_id=?`, [error, delay, id])
      })
    },
  }
}

export function create_audit_catalog(pool: Pick<Pool, 'execute'>, destination: { bucket: string, endpoint: string }, static_keys: readonly string[]) {
  return {
    async reference(key: string): Promise<{ size: number | null } | null> {
      if (static_keys.includes(key))
        return { size: null }
      const [files] = await pool.execute<RowDataPacket[]>(`SELECT IF(object_key=?,file_size,NULL) AS expected_size FROM content_story_attachments
        WHERE storage_provider='aliyun' AND is_folder=0 AND story_id IS NOT NULL
        AND (object_key=? OR original_key=? OR avif_key=? OR jpeg_key=? OR redacted_avif_key=? OR redacted_jpeg_key=?) LIMIT 1`, [key, key, key, key, key, key, key])
      if (files.length)
        return { size: files[0]!.expected_size === null ? null : Number(files[0]!.expected_size) }
      if (key.startsWith('avatar/')) {
        const [users] = await pool.execute<RowDataPacket[]>('SELECT id FROM users WHERE avatar_file=? LIMIT 1', [key.slice(7)])
        if (users.length)
          return { size: null }
      }
      return null
    },
    async ownership(key: string, include_retirement = true): Promise<'tracked' | 'retired' | null> {
      if (include_retirement) {
        const [retired] = await pool.execute<RowDataPacket[]>(`SELECT phase FROM content_object_retirements
          WHERE object_key=? AND storage_bucket=? AND storage_endpoint=? LIMIT 1`, [key, destination.bucket, destination.endpoint])
        if (retired.length)
          return retired[0]!.phase === 'completed' ? 'retired' : 'tracked'
      }
      const [tracked] = await pool.execute<RowDataPacket[]>(`SELECT 1 FROM (
        SELECT CAST(target_key AS BINARY) AS k FROM content_transfer_attempts WHERE status<>'adopted' OR cleanup_required=1
        UNION ALL SELECT CAST(avif_key AS BINARY) FROM content_image_attempts WHERE adopted=0
        UNION ALL SELECT CAST(jpeg_key AS BINARY) FROM content_image_attempts WHERE adopted=0
        UNION ALL SELECT CAST(CONCAT('content/att/originals/',job_id,'/',id) AS BINARY) FROM content_image_attempts WHERE adopted=0
        UNION ALL SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(intent,'$.input.key')) AS BINARY) FROM content_image_jobs WHERE status IN ('queued','processing','ready','failed')
        UNION ALL SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(intent,'$.source.key')) AS BINARY) FROM content_image_jobs WHERE status IN ('queued','processing','ready','failed')
        UNION ALL SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(intent,'$.source.key')) AS BINARY) FROM content_transfer_sessions WHERE status IN ('uploading','queued','running','verifying','failed')
        UNION ALL SELECT CAST(staging_key AS BINARY) FROM content_task_items WHERE staging_provider='aliyun' AND superseded_at IS NULL
        UNION ALL SELECT CAST(object_key AS BINARY) FROM content_migration_pins WHERE retired_at IS NULL
        UNION ALL SELECT CAST(m.target_key AS BINARY) FROM content_migration_objects m JOIN content_migration_scopes s ON s.scope_id=m.scope_id WHERE m.state='copying' OR s.state='copying'
        UNION ALL SELECT CAST(object_key AS BINARY) FROM content_preload_jobs WHERE phase IN ('submitting','polling')
      ) AS protected WHERE k=? LIMIT 1`, [key])
      if (tracked.length)
        return 'tracked'
      return null
    },
    async next_reference(state: AuditState) {
      if (state.phase === 'static') {
        const key = static_keys[Number(state.row_cursor)]
        return key === undefined ? null : { key, next: { ... state, row_cursor: Number(state.row_cursor) + 1 } as AuditState }
      }
      if (state.phase === 'avatars') {
        const [rows] = await pool.execute<RowDataPacket[]>('SELECT id,avatar_file FROM users WHERE id>=? ORDER BY id LIMIT 1', [state.row_cursor])
        const row = rows[0]
        return row ? { key: row.avatar_file ? `avatar/${row.avatar_file}` : null, next: { ... state, row_cursor: Number(row.id) + 1 } as AuditState } : null
      }
      const [rows] = await pool.execute<RowDataPacket[]>(`SELECT id,${audit_roles.join(',')} FROM content_story_attachments
        WHERE id>=? AND storage_provider='aliyun' AND is_folder=0 AND story_id IS NOT NULL ORDER BY id LIMIT 1`, [state.row_cursor])
      const row = rows[0]
      if (! row)
        return null
      const slot = Number(row.id) === Number(state.row_cursor) ? Number(state.role_cursor) : 0
      const last = slot === audit_roles.length - 1
      return { key: row[audit_roles[slot]!] as string | null,
        next: { ... state, row_cursor: Number(row.id) + (last ? 1 : 0), role_cursor: last ? 0 : slot + 1 } as AuditState }
    },
    async next_finding(state: AuditState) {
      const [rows] = await pool.execute<RowDataPacket[]>(`SELECT id,object_key,kind FROM storage_audit_findings
        WHERE destination_id=? AND resolved_at IS NULL AND last_seen_cycle<>? AND id>? ORDER BY id LIMIT 1`, [state.destination_id, state.cycle_id, state.row_cursor])
      const row = rows[0]
      return row ? { id: Number(row.id), key: audit_key(row.object_key), kind: row.kind as StorageAuditKind } : null
    },
  }
}

export async function read_audit_findings(pool: Pick<Pool, 'execute'>, destination_id: string, after_id: number, limit: number): Promise<StorageAuditFinding[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(`SELECT id,object_key,kind,expected_size,observed_size,observations,first_seen_at,last_seen_at,resolved_at
    FROM storage_audit_findings WHERE destination_id=? AND resolved_at IS NULL AND id>? ORDER BY id LIMIT ?`, [destination_id, after_id, limit])
  return rows.map(row => ({ id: Number(row.id), object_key: audit_key(row.object_key), kind: row.kind,
    expected_size: row.expected_size === null ? null : Number(row.expected_size), observed_size: row.observed_size === null ? null : Number(row.observed_size),
    observations: Number(row.observations), first_seen_at: new Date(row.first_seen_at).toISOString(), last_seen_at: new Date(row.last_seen_at).toISOString(), resolved_at: null }))
}
