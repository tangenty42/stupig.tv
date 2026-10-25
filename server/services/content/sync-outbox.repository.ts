import type { DataSyncEvent } from '@shared/types/sync'
import type { Connection } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'

/** Use the caller's transaction. Never publish or open a second connection here. */
export async function enqueue_content_refresh(connection: Pick<Connection, 'execute'>, resources: string[]) {
  for (const resource of new Set(resources)) {
    const event: DataSyncEvent = {
      id: randomUUID().replaceAll('-', ''), type: 'refresh', resource, timestamp: Date.now(),
    }
    await connection.execute('INSERT INTO content_sync_outbox (id, resource, payload) VALUES (?, ?, CAST(? AS JSON))',
      [event.id, resource, JSON.stringify(event)])
  }
}
