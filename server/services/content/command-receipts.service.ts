import type { runtime_config } from '@config/loader'
import type { Pool, RowDataPacket } from 'mysql2/promise'

type Options = ReturnType<typeof runtime_config>['app']['contentReceipts']
interface Receipt extends RowDataPacket {
  actor_id: string
  request_id: string
  expired: number
}
type Cursor = Pick<Receipt, 'actor_id' | 'request_id'>

/** Only discard expired replay payloads: deleting the identity would allow re-execution. */
export function create_content_receipt_compactor(pool: Pick<Pool, 'execute'>, options: Options) {
  let cursor: Cursor | null = null
  const select = `SELECT CAST(r.actor_id AS CHAR) AS actor_id, r.request_id,
    r.expires_at <= CURRENT_TIMESTAMP(3) AS expired FROM content_command_receipts r`
  return async (signal?: AbortSignal) => {
    if (! options.enabled || signal?.aborted)
      return
    let rows: Receipt[]
    if (cursor) {
      // Two primary-key ranges avoid an expiry scan or a row-constructor inequality
      // that may scan the already-visited requests within one actor.
      const [page] = await pool.execute<Receipt[]>(`${select} WHERE r.actor_id = ? AND r.request_id > ? ORDER BY r.request_id LIMIT ?`,
        [cursor.actor_id, cursor.request_id, options.scanLimit])
      rows = page
      if (signal?.aborted)
        return
      if (rows.length < options.scanLimit) {
        const [following] = await pool.execute<Receipt[]>(`${select} WHERE r.actor_id > ? ORDER BY r.actor_id, r.request_id LIMIT ?`,
          [cursor.actor_id, options.scanLimit - rows.length])
        rows.push(... following)
      }
    }
    else {
      const [page] = await pool.execute<Receipt[]>(`${select} ORDER BY r.actor_id, r.request_id LIMIT ?`, [options.scanLimit])
      rows = page
    }
    for (const row of rows) {
      if (signal?.aborted)
        return
      if (row.expired) {
        await pool.execute(`UPDATE content_command_receipts SET result = JSON_OBJECT()
          WHERE actor_id = ? AND request_id = ? AND expires_at <= CURRENT_TIMESTAMP(3) AND JSON_LENGTH(result) > 0`,
        [row.actor_id, row.request_id])
      }
      // Advance even past live/compacted receipts, but never past a failed update.
      cursor = { actor_id: row.actor_id, request_id: row.request_id }
    }
    // A restart may repeat a page; every write is idempotent. Wrap to revisit rows
    // that were live on the previous pass and inserts behind the cursor.
    if (! signal?.aborted && rows.length < options.scanLimit)
      cursor = null
  }
}
