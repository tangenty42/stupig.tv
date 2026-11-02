import type { RowDataPacket } from 'mysql2/promise'
import type { Protection } from './inventory-catalog'
import type { Checkpoint, RecordRow } from './inventory-run'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { load_aliyun_oss_config, load_database_config } from '@config/loader'
import mysql from 'mysql2/promise'
import { create_inventory_catalog, inventory_execute } from './inventory-catalog'
import { checkpoint_schema, inventory_error, inventory_summary, new_checkpoint, run_inventory } from './inventory-run'
import { create_inventory_reader } from './oss-inventory'

export function inventory_arguments(args: string[]) {
  const { values } = parseArgs({ args, strict: true, options: {
    'help': { type: 'boolean' }, 'output': { type: 'string' }, 'prefix': { type: 'string', default: '' }, 'parts': { type: 'boolean', default: false },
    'metadata-only': { type: 'boolean', default: false },
    'min-age-days': { type: 'string', default: '30' }, 'max-requests': { type: 'string', default: '50' },
    'page-size': { type: 'string', default: '25' }, 'max-seconds': { type: 'string', default: '60' }, 'pause-ms': { type: 'string', default: '100' },
  } })
  function integer(key: 'min-age-days' | 'max-requests' | 'page-size' | 'max-seconds' | 'pause-ms', min: number, max: number) {
    const raw = values[key]!
    const value = Number(raw)
    if (! /^\d+$/.test(raw) || ! Number.isSafeInteger(value) || value < min || value > max)
      throw new Error('invalid_inventory_arguments')
    return value
  }
  if (Buffer.byteLength(values.prefix!) > 1024 || /[\0\r\n]/.test(values.prefix!))
    throw new Error('invalid_inventory_arguments')
  return { help: values.help, output: values.output,
    scan: { prefix: values.prefix!, parts: values.parts!, min_age_days: integer('min-age-days', 7, 36500), page_size: integer('page-size', 1, 100), catalog_mode: values['metadata-only'] ? 'unverified' as const : 'database' as const },
    budget: { max_requests: integer('max-requests', 3, 1000), max_ms: integer('max-seconds', 1, 3600) * 1000, pause_ms: integer('pause-ms', 0, 10000) } }
}
async function atomic(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  try {
    await rename(temporary, path)
  }
  finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        throw error
    })
  }
}
export function inventory_sink(directory: string) {
  return {
    async save(state: Checkpoint, records: RecordRow[]) {
      // Write-before-checkpoint, immutable revision filenames: an interrupted
      // page is safely overwritten on replay rather than appended/counting twice.
      if (records.length)
        await atomic(resolve(directory, `records-${String(state.revision).padStart(8, '0')}.json`), { format: 1, target: state.target, revision: state.revision, executable: false, records })
      await atomic(resolve(directory, 'checkpoint.json'), state)
      await atomic(resolve(directory, 'report.json'), inventory_summary(state))
    },
  }
}

export async function inventory_main(args = process.argv.slice(2)) {
  const options = inventory_arguments(args)
  if (options.help) {
    console.log('pnpm storage:inventory --env=dev|prod [--parts] [--metadata-only] [--output .data/oss-inventory-...] [--prefix content/att/] [--min-age-days 30] [--max-requests 50] [--page-size 25] [--max-seconds 60] [--pause-ms 100]\nGET/SELECT only. Reuse the same output and scan options to resume. Exit 0: selected scope complete; 2: partial/denied/budget; 1: failed. Metadata-only skips DB/protection checks. No delete/abort/enqueue mode.')
    return 0
  }
  const config = load_aliyun_oss_config()
  if (! config)
    throw new Error('oss_inventory_not_configured')
  const database = options.scan.catalog_mode === 'database' ? load_database_config() : null
  const directory = resolve(options.output ?? `.data/oss-inventory-${process.env.NODE_ENV}-${new Date().toISOString().slice(0, 10)}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // Fail closed on concurrent/stale locks. The operator can inspect the PID
  // and remove a stale local lock after proving its process has stopped.
  const lock_path = resolve(directory, 'run.lock')
  const lock = await open(lock_path, 'wx', 0o600)
  let connection: Awaited<ReturnType<typeof mysql.createConnection>> | undefined
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }))
    let state: Checkpoint | undefined
    try {
      state = checkpoint_schema.parse(JSON.parse(await readFile(resolve(directory, 'checkpoint.json'), 'utf8')))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('invalid_inventory_checkpoint')
    }
    let database_identity = ['metadata-only']
    let catalog: (key: string, upload_id?: string) => Promise<Protection> = async () => 'unverified'
    if (database) {
      connection = await mysql.createConnection({ host: database.host, port: database.port, user: database.user, password: database.password,
        database: database.name, timezone: 'Z', connectTimeout: 10000 })
      await connection.query('SET SESSION TRANSACTION READ ONLY')
      await connection.query('SET SESSION time_zone = \'+00:00\'')
      await connection.query('SET SESSION max_execution_time = 5000')
      const [[identity]] = await connection.query<RowDataPacket[]>('SELECT DATABASE() AS name, @@server_uuid AS server_uuid')
      if (identity!.name !== database.name)
        throw new Error('inventory_database_mismatch')
      database_identity = [identity!.server_uuid, database.name]
      // The catalog can only issue SELECTs, independently of its DB credentials.
      catalog = create_inventory_catalog(inventory_execute(connection), { bucket: config.bucket, endpoint: config.endpoint })
    }
    // The server identity survives a changed localhost SSH-forward port.
    const target = createHash('sha256').update(JSON.stringify([process.env.NODE_ENV, config.bucket, new URL(config.endpoint).origin, ... database_identity])).digest('hex')
    state ??= new_checkpoint(target, options.scan)
    if (state.target !== target || ! isDeepStrictEqual(state.options, options.scan))
      throw new Error('inventory_resume_target_or_options_mismatch')
    if (state.pending && state.pending.index > state.pending.rows.length)
      throw new Error('invalid_inventory_checkpoint')
    const summary = await run_inventory(state, create_inventory_reader(config), catalog, inventory_sink(directory), options.budget)
    console.log(JSON.stringify({ environment: process.env.NODE_ENV, bucket: config.bucket, report: resolve(directory, 'report.json'), ... summary }, null, 2))
    return summary.complete ? 0 : 2
  }
  finally {
    try {
      await connection?.end()
    }
    finally {
      try {
        await lock.close()
      }
      finally {
        await unlink(lock_path)
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  inventory_main().then((code) => {
    process.exitCode = code
  }, (error) => {
    const safe = ['invalid_inventory_arguments', 'oss_inventory_not_configured', 'invalid_inventory_checkpoint', 'inventory_resume_target_or_options_mismatch', 'inventory_checkpoint_failed']
    console.error(JSON.stringify({ error: safe.includes(error?.message) ? error.message : error?.code === 'EEXIST' ? 'inventory_output_locked' : inventory_error(error) }))
    process.exitCode = 1
  })
}
