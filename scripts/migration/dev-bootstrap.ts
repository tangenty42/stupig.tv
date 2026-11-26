import type { MigrationOptions } from './runner'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load_database_config } from '@config/loader'
import driver from 'mysql2/promise'
import { report_migration_error } from './cli'
import { run_migrations } from './local'

interface Dependencies {
  connect: () => Promise<{ query: (sql: string) => Promise<unknown>, end: () => Promise<void> }>
  migrate: (options: MigrationOptions) => Promise<{ pending: unknown[] }>
  sleep: (ms: number) => Promise<void>
  log: (message: string) => void
}

// Configuration errors are permanent; only a not-yet-listening server is worth waiting for.
const transient_codes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'PROTOCOL_CONNECTION_LOST', 'ER_CON_COUNT_ERROR'])

const default_dependencies: Dependencies = {
  connect: async () => {
    const config = load_database_config()
    return driver.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.name })
  },
  migrate: run_migrations,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  log: message => console.log(`[dev] ${message}`),
}

/** The dev database may still be booting: Compose starts MySQL without a readiness gate. */
async function wait_for_database(deps: Dependencies, attempts: number, interval_ms: number) {
  for (let attempt = 1; ; attempt ++) {
    let connection: Awaited<ReturnType<Dependencies['connect']>> | undefined
    try {
      connection = await deps.connect()
      await connection.query('SELECT 1')
      return connection
    }
    catch (error) {
      await connection?.end().catch(() => {})
      if (! transient_codes.has(String((error as { code?: unknown }).code)))
        throw error
      if (attempt >= attempts)
        throw new Error('Development database is not reachable; check `docker compose --env-file .env.dev -f docker-compose.dev.yml ps`', { cause: error })
      await deps.sleep(interval_ms)
    }
  }
}

/**
 * Migrate only an empty database automatically. A database with data may hold
 * hand-made fixtures that maintenance migrations rewrite, so it is reported instead.
 */
export async function prepare_dev_database(overrides: Partial<Dependencies> = {}, { attempts = 60, interval_ms = 1000 } = {}) {
  const deps = { ... default_dependencies, ... overrides }
  const connection = await wait_for_database(deps, attempts, interval_ms)
  let empty: boolean
  try {
    const [rows] = await connection.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()') as [Array<{ n: number | string }>]
    empty = Number(rows[0]?.n ?? 0) === 0
  }
  finally {
    await connection.end()
  }
  if (empty) {
    deps.log('Empty development database: applying all migrations')
    await deps.migrate({ maintenance: true })
    return 'migrated' as const
  }
  const { pending } = await deps.migrate({ check_only: true })
  if (pending.length)
    deps.log(`${pending.length} pending migration(s); review with \`pnpm migrate:dev --status\` before applying`)
  return pending.length ? 'pending' as const : 'current' as const
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepare_dev_database().catch((error) => {
    if (error instanceof Error && error.message.startsWith('Development database'))
      console.error(`[dev] ${error.message}`)
    else if (error instanceof Error && ! (error as { code?: unknown }).code)
      console.error(`[dev] ${error.message}`)
    else
      report_migration_error(error)
    process.exitCode = 1
  })
}
