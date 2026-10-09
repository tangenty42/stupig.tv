import type { RowDataPacket } from 'mysql2/promise'
import { db } from '@server/lib/db'
import { error_fields, log_error } from '@server/lib/log'

/**
 * Readiness probe for the container healthcheck (Dockerfile / docker-compose.yml)
 * and for the deploy gate in .github/workflows/deploy.yml.
 *
 * Deliberately more than "the process answers": a 200 on `/` proves nothing —
 * SSR renders the shell even when every query fails. Asking the database, and
 * asking for the migration ledger specifically, is what makes "up but useless"
 * (unreachable MySQL, structure never applied) read as unhealthy instead of
 * silently serving errors.
 *
 * Public and detail-free on purpose: the probe runs inside the container with no
 * credentials, and this response is reachable through the reverse proxy. It names
 * no host, no version and no row contents — only whether the app can serve.
 */
export default defineEventHandler(async (event) => {
  try {
    const [rows] = await db.execute<RowDataPacket[]>('SELECT COUNT(*) AS applied FROM schema_migrations')
    const applied = Number((rows[0] as { applied: number } | undefined)?.applied ?? 0)
    return { status: 'ok', migrations: applied }
  }
  catch (error) {
    log_error('healthz failed', { ... error_fields(error) })
    setResponseStatus(event, 503)
    return { status: 'unavailable' }
  }
})
