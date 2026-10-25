import type { runtime_config } from '@config/loader'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { log_error } from '@server/lib/log'

type Options = ReturnType<typeof runtime_config>['app']['contentSync']
interface OutboxRow extends RowDataPacket {
  id: string
  resource: string
  payload: object | string
  attempts: number
}

/** A small Content-only dispatcher. A broker ACK, not a local queue, completes delivery. */
export function create_content_sync_dispatcher(pool: Pick<Pool, 'getConnection' | 'execute'>,
  publish: (resource: string, payload: string, timeout_ms: number) => Promise<void>, options: Options) {
  async function claim() {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.execute<OutboxRow[]>(`SELECT id, resource, payload, attempts FROM content_sync_outbox
        WHERE next_attempt_at <= CURRENT_TIMESTAMP(3) AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP(3))
        ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`)
      const row = rows[0]
      const token = randomUUID().replaceAll('-', '')
      if (row) {
        await connection.execute(`UPDATE content_sync_outbox SET lease_token = ?, lease_until = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3)),
          attempts = attempts + 1 WHERE id = ?`, [token, options.leaseSeconds, row.id])
      }
      await connection.commit()
      return row ? { ... row, token } : null
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
    finally { connection.release() }
  }
  return async (signal?: AbortSignal) => {
    if (! options.enabled)
      return
    for (let index = 0; index < options.scanLimit; index ++) {
      if (signal?.aborted)
        break
      // Claim just before delivery: a whole batch must not wait out its leases.
      const row = await claim()
      if (! row)
        break
      try {
        await publish(row.resource, typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload), options.publishTimeoutMs)
        await pool.execute('DELETE FROM content_sync_outbox WHERE id = ? AND lease_token = ? AND lease_until > CURRENT_TIMESTAMP(3)', [row.id, row.token])
      }
      catch {
        const retry = Math.min(options.maxRetrySeconds, options.retrySeconds * 2 ** Math.min(Number(row.attempts), 30))
        await pool.execute(`UPDATE content_sync_outbox SET lease_token = NULL, lease_until = NULL,
          next_attempt_at = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3)), last_error_code = 'delivery_unconfirmed'
          WHERE id = ? AND lease_token = ? AND lease_until > CURRENT_TIMESTAMP(3)`, [retry, row.id, row.token])
        log_error('content refresh delivery unconfirmed', { event_id: row.id, attempt: Number(row.attempts) + 1 })
        // A disconnected broker must not consume the entire batch's retries.
        break
      }
    }
  }
}
