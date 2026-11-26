import type mysql from 'mysql2/promise'
import type { MigrationFile } from './catalog'
import type { MigrationCheckpoint, MigrationContext, MigrationDatabase, MigrationReadContext } from './contract'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load_database_config } from '@config/loader'
import { log_error, log_info } from '@server/lib/log'
import driver from 'mysql2/promise'
import { baseline_migration, baseline_sql_checksums, retired_migrations } from './baseline'
import { load_script, plan_migrations, read_migrations, runtime_migration } from './catalog'
import { deployment_fingerprint, sql_execution } from './deployment'

const lock_name = 'stupig_tv_migrate'
interface RunRow {
  filename: string
  checksum: string
  status: 'running' | 'failed' | 'completed'
  phase: 'apply' | 'verify'
  checkpoint: MigrationCheckpoint
  attempts: number
  last_error_code?: string | null
  finished_at: Date | string | null
}
export interface MigrationOptions {
  /** Programmatic isolation for verification; CLI always uses layered database config. */
  database_config?: ReturnType<typeof load_database_config>
  baseline?: boolean
  check_only?: boolean
  dry_run?: boolean
  preflight?: boolean
  maintenance?: boolean
  through?: string
  retry_sql?: string
  dir?: string
  manifest?: string
  signal?: AbortSignal
}

export class MigrationFailure extends Error {
  constructor(public code: string, message: string) { super(message) }
}

async function table_exists(connection: mysql.Connection, table: string) {
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1', [table],
  )
  return rows.length > 0
}

async function read_runs(connection: mysql.Connection): Promise<RunRow[]> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>('SELECT filename, checksum, status, phase, checkpoint, attempts, last_error_code, finished_at FROM migration_runs')
  return rows.map(row => ({
    ... row,
    checkpoint: typeof row.checkpoint === 'string' ? JSON.parse(row.checkpoint) : row.checkpoint,
    attempts: Number(row.attempts),
  } as RunRow))
}

function checkpoint_json(value: MigrationCheckpoint) {
  const json = JSON.stringify(value, (_key, item) => {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || (typeof item === 'number' && ! Number.isFinite(item)))
      throw new MigrationFailure('invalid_checkpoint', '检查点必须是有限的 JSON 值')
    return item
  })
  if (Buffer.byteLength(json) > 65536)
    throw new MigrationFailure('checkpoint_too_large', '检查点超过 64 KiB，请使用领域迁移账本保存逐对象明细')
  return json
}

/** Read-only transaction plus one-statement driver calls; scripts are trusted code, not a sandbox. */
async function read_only<T>(connection: mysql.Connection, signal: AbortSignal, file: { filename: string, checkpoint: MigrationCheckpoint }, work: (ctx: MigrationReadContext) => Promise<T>) {
  await connection.query('START TRANSACTION READ ONLY')
  const read_query = async (sql: unknown, values?: unknown) => {
    signal.throwIfAborted()
    if (typeof sql !== 'string' || ! /^\s*(?:SELECT|SHOW|EXPLAIN)\s/i.test(sql) || /;|\bINTO\s+(?:OUTFILE|DUMPFILE)\b|\b(?:GET_LOCK|RELEASE_LOCK)\s*\(/i.test(sql))
      throw new MigrationFailure('read_only', '预演和验证仅允许单条只读 SELECT／SHOW／EXPLAIN')
    return connection.execute(sql, values as Parameters<mysql.Connection['execute']>[1])
  }
  const db = { query: read_query, execute: read_query } as MigrationDatabase
  try {
    return await work({ db, signal, filename: file.filename, checkpoint: { value: structuredClone(file.checkpoint) } })
  }
  finally { await connection.rollback() }
}

export async function run_migrations(options: MigrationOptions = {}) {
  const { baseline = false, check_only = false, dry_run = false, maintenance = false } = options
  if (baseline)
    throw new MigrationFailure('baseline_removed', '--baseline 已废弃；新基线会自动处理')
  const dir = options.dir ?? resolve(process.cwd(), 'migrations')
  const files = read_migrations(dir, options.manifest)
  if (options.through && ! files.some(file => file.filename === options.through))
    throw new MigrationFailure('unknown_target', '--through 必须指定存在的完整迁移文件名')
  if (options.retry_sql && ! files.some(file => file.filename === options.retry_sql && ! file.artifact))
    throw new MigrationFailure('invalid_retry', '--retry-sql 必须指定存在的 SQL 迁移文件名')
  const baseline_file = files.find(file => file.filename === baseline_migration)
  const historical = baseline_file ? files.filter(file => file.filename < baseline_migration) : []
  if (baseline_file && (historical.length !== Object.keys(baseline_sql_checksums).length
    || historical.some(file => file.artifact || baseline_sql_checksums[file.filename] !== file.checksum))) {
    throw new MigrationFailure('baseline_catalog', '基线之前的 SQL 文件与冻结清单不一致')
  }
  if (baseline_file && [options.through, options.retry_sql].some(target => target && target < baseline_migration))
    throw new MigrationFailure('baseline_boundary', '请使用定基线前的发布版本执行历史迁移')
  const config = options.database_config ?? load_database_config()
  const connection = await driver.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.name, timezone: 'Z', multipleStatements: true })
  const controller = new AbortController()
  const abort = () => controller.abort(new MigrationFailure('interrupted', '迁移已停止；重跑时从持久检查点恢复'))
  const lost = () => controller.abort(new MigrationFailure('connection_lost', '迁移连接已断开；请核对已发送的外部操作'))
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted)
    abort()
  connection.on('error', lost)
  const assert_active = async () => {
    controller.signal.throwIfAborted()
    const [rows] = await connection.query<mysql.RowDataPacket[]>('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned', [lock_name])
    if (Number(rows[0]?.owned) !== 1) {
      lost()
      controller.signal.throwIfAborted()
    }
  }
  let locked = false
  try {
    await connection.query('SET time_zone = "+00:00"')
    const [locks] = await connection.query<mysql.RowDataPacket[]>('SELECT GET_LOCK(?, 30) AS acquired', [lock_name])
    if (Number(locks[0]?.acquired) !== 1)
      throw new MigrationFailure('lock_busy', '没抢到迁移锁，可能有另一次迁移正在跑')
    locked = true
    await assert_active()
    const has_runtime = await table_exists(connection, 'migration_runs')
    const runs = new Map((has_runtime ? await read_runs(connection) : []).map(row => [row.filename, row]))
    if (baseline_file && await table_exists(connection, 'schema_migrations'))
      throw new MigrationFailure('legacy_ledger', '发现旧迁移账本，请用定基线前的发布版本核对并完成账本迁移')
    if ([... runs.values()].some(row => row.status === 'completed' && row.finished_at == null))
      throw new MigrationFailure('completion_inconsistent', '已完成迁移缺少完成时间，请人工核对')
    const applied = new Map([... runs.values()].filter(row => row.status === 'completed').map(row => [row.filename, row.checksum] as const))
    const started = new Map([... runs.values()].filter(row => row.status !== 'completed').map(row => [row.filename, row.checksum] as const))
    const plan = plan_migrations(files, applied, started)
    // A new database writes the running baseline row before DDL. Until the final
    // transaction commits, its covered SQL receipts are intentionally absent.
    const retry_baseline = Boolean(baseline_file && runs.size === 1 && started.has(baseline_migration))
    const inconsistent = plan.inconsistent.filter(item => ! (retry_baseline
      && item.reason === 'out_of_order' && Object.hasOwn(baseline_sql_checksums, item.filename)))
    if (inconsistent.length) {
      log_error('migrations inconsistent', { inconsistent })
      throw new MigrationFailure('inconsistent', '已应用或已开始的迁移文件被改动、删除了，或插入了历史迁移，需要人工确认后再跑')
    }
    const pending = plan.pending.filter(file => ! options.through || file.filename <= options.through)
    let baseline_action: 'initialize' | 'record' | undefined
    if (baseline_file && ! applied.has(baseline_migration)) {
      let initialize_baseline = retry_baseline
      if (! runs.size) {
        const [counts] = await connection.query<mysql.RowDataPacket[]>(
          'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME != ?', ['migration_runs'],
        )
        initialize_baseline = Number(counts[0]?.n ?? 0) === 0
      }
      if (! initialize_baseline) {
        const missing_receipts = [... historical.map(file => file.filename), ... retired_migrations.keys()].filter(filename => ! applied.has(filename))
        if (started.has(baseline_migration) || missing_receipts.length) {
          log_error('migration baseline prerequisites not met', { missing_receipts, baseline_started: started.has(baseline_migration) })
          throw new MigrationFailure('baseline_prerequisites', '现有库尚未达到基线要求，请先用定基线前的发布版本核对并完成历史迁移')
        }
      }
      baseline_action = initialize_baseline ? 'initialize' : 'record'
    }
    const covered = baseline_action === 'initialize' ? historical : []
    const executable = pending.filter(file => ! covered.includes(file))
    const classify_sql = sql_execution(files, dir)
    const sql_mode = (file: MigrationFile) => file.filename === baseline_migration
      ? (baseline_action === 'initialize' ? 'automatic' : 'maintenance')
      : classify_sql(file)

    if (options.preflight) {
      const [identity] = await connection.query<mysql.RowDataPacket[]>('SELECT @@server_uuid AS server_uuid')
      const details = []
      for (const file of executable) {
        const previous = runs.get(file.filename)
        const execution = file.artifact ? (await load_script(file)).execution : sql_mode(file)
        details.push({ filename: file.filename, checksum: file.checksum, status: previous?.status ?? 'pending', phase: previous?.phase ?? 'apply', execution, ... (file.filename === baseline_migration ? { action: baseline_action } : {}) })
      }
      const report = {
        version: 1 as const,
        database: { host: config.host, port: config.port, name: config.name, server_uuid: String(identity[0]?.server_uuid ?? '') },
        catalog: files.map(({ filename, checksum }) => ({ filename, checksum })),
        ledger: [... runs.values()].map(({ filename, checksum, status, phase, attempts, finished_at }) => ({ filename, checksum, status, phase, attempts, finished: Boolean(finished_at) })).sort((a, b) => a.filename.localeCompare(b.filename)),
        pending: details,
        requires_maintenance: details.some(file => file.execution === 'maintenance'),
        sql_recovery_required: executable.filter(file => ! file.artifact && started.has(file.filename)).map(file => file.filename),
      }
      return { applied: [... applied.keys()], pending: [], preflight: { ... report, fingerprint: deployment_fingerprint(report) } }
    }
    if (check_only || dry_run) {
      const details = []
      let blocked_by: string | null = null
      for (const file of executable) {
        let report = null
        let execution: string = sql_mode(file)
        if (file.artifact) {
          execution = 'script'
          if (dry_run && ! blocked_by) {
            const script = await load_script(file)
            execution = script.execution
            report = await read_only(connection, controller.signal, { filename: file.filename, checkpoint: runs.get(file.filename)?.checkpoint ?? null }, script.plan)
          }
        }
        details.push({ filename: file.filename, status: runs.get(file.filename)?.status ?? 'pending', phase: runs.get(file.filename)?.phase ?? 'apply', execution, ... (file.filename === baseline_migration ? { action: baseline_action } : {}), blocked_by, report })
        blocked_by ??= file.filename
      }
      const executions = [... runs.values()].map(({ filename, status, phase, attempts, last_error_code }) => ({ filename, status, phase, attempts, last_error_code }))
      log_info('migrations pending', { applied: [... applied.keys()], pending: executable.map(file => file.filename), baseline_covers: covered.map(file => file.filename), details, executions })
      return { applied: [... applied.keys()], pending: details }
    }
    if (! executable.length) {
      log_info('migrations up to date', { applied: applied.size })
      return { applied: [... applied.keys()], pending: [] }
    }
    // Classify the complete chain before metadata DDL or any earlier SQL can commit.
    const scripts = new Map<string, Awaited<ReturnType<typeof load_script>>>()
    for (const file of executable) {
      const script = file.artifact ? await load_script(file) : null
      if (script)
        scripts.set(file.filename, script)
      if (! maintenance && (script?.execution ?? sql_mode(file)) === 'maintenance')
        throw new MigrationFailure('maintenance_required', `迁移 ${file.filename} 需要维护窗口，请显式指定 --maintenance`)
      const previous = runs.get(file.filename)
      if (! script && previous && previous.status !== 'completed' && options.retry_sql !== file.filename)
        throw new MigrationFailure('sql_recovery_required', `SQL ${file.filename} 可能已部分执行，请核对后显式使用 --retry-sql ${file.filename}`)
    }
    await assert_active()
    if (! has_runtime) {
      const metadata_sql = files.find(file => file.filename === runtime_migration)?.sql
        ?? readFileSync(resolve(process.cwd(), 'migrations', runtime_migration), 'utf8')
      await connection.query(metadata_sql)
    }
    const record_completed = async (file: MigrationFile) => {
      await connection.execute('INSERT INTO migration_runs (filename, checksum, status, phase, attempts, finished_at) VALUES (?, ?, \'completed\', \'verify\', 0, CURRENT_TIMESTAMP)', [file.filename, file.checksum])
    }

    for (const file of executable) {
      await assert_active()
      if (baseline_action === 'record' && file.filename === baseline_migration) {
        await record_completed(file)
        applied.set(file.filename, file.checksum)
        log_info('migration baseline recorded', { filename: file.filename })
        continue
      }
      const script = scripts.get(file.filename)
      const previous = runs.get(file.filename)
      if (script) {
        const report = await read_only(connection, controller.signal, { filename: file.filename, checkpoint: previous?.checkpoint ?? null }, script.plan)
        log_info('migration planned', { filename: file.filename, report })
        if (report.blocked)
          throw new MigrationFailure('plan_blocked', `迁移预检未通过：${file.filename}`)
      }
      const attempt = (previous?.attempts ?? 0) + 1
      let phase = previous?.phase ?? 'apply'
      let checkpoint = previous?.checkpoint ?? null
      let in_transaction = false
      await connection.query(`INSERT INTO migration_runs (filename, checksum, status, phase, checkpoint, attempts)
          VALUES (?, ?, 'running', ?, ?, ?) ON DUPLICATE KEY UPDATE status = 'running', attempts = ?, last_error_code = NULL, finished_at = NULL`,
      [file.filename, file.checksum, phase, checkpoint_json(checkpoint), attempt, attempt])
      const db_call = async (method: 'query' | 'execute', sql: unknown, values?: unknown) => {
        await assert_active()
        return method === 'query' ? connection.query(sql as string, values as Parameters<mysql.Connection['query']>[1]) : connection.execute(sql as string, values as Parameters<mysql.Connection['execute']>[1])
      }
      const db = { query: (sql: unknown, values?: unknown) => db_call('query', sql, values), execute: (sql: unknown, values?: unknown) => db_call('execute', sql, values) } as MigrationDatabase
      const ctx: MigrationContext = {
        filename: file.filename, db, signal: controller.signal, assert_active,
        checkpoint: {
          get value() { return structuredClone(checkpoint) },
          async save(value) {
            await assert_active()
            const [result] = await connection.execute<mysql.ResultSetHeader>(
              `UPDATE migration_runs SET checkpoint = ? WHERE filename = ? AND checksum = ? AND attempts = ? AND status = 'running'`,
              [checkpoint_json(value), file.filename, file.checksum, attempt],
            )
            if (result.affectedRows !== 1)
              throw new MigrationFailure('checkpoint_fenced', '检查点执行权已失效')
            checkpoint = JSON.parse(checkpoint_json(value))
          },
        },
        async transaction(work) {
          await assert_active()
          if (in_transaction)
            throw new MigrationFailure('nested_transaction', '迁移事务不能嵌套')
          const saved_checkpoint = structuredClone(checkpoint)
          await connection.beginTransaction()
          in_transaction = true
          try {
            const result = await work(db)
            await assert_active()
            await connection.commit()
            return result
          }
          catch (error) {
            await connection.rollback()
            checkpoint = saved_checkpoint
            throw error
          }
          finally { in_transaction = false }
        },
        async oss() {
          await assert_active()
          const { create_aliyun_oss } = await import('@server/lib/aliyun-oss')
          const { load_aliyun_oss_config } = await import('@config/loader')
          const client = create_aliyun_oss(load_aliyun_oss_config())
          return new Proxy(client, {
            get(target, key) {
              const value = Reflect.get(target, key)
              return typeof value === 'function'
                ? async (... args: unknown[]) => {
                  await assert_active()
                  if (in_transaction)
                    throw new MigrationFailure('external_in_transaction', 'OSS 操作必须在数据库事务之外执行')
                  return value.apply(target, args)
                }
                : value
            },
          })
        },
      }
      log_info('migration applying', { filename: file.filename, attempt, phase })
      try {
        if (script) {
          if (phase === 'apply') {
            await script.apply(ctx)
            await assert_active()
            phase = 'verify'
            const [advanced] = await connection.execute<mysql.ResultSetHeader>('UPDATE migration_runs SET phase = ? WHERE filename = ? AND attempts = ? AND status = \'running\'', [phase, file.filename, attempt])
            if (advanced.affectedRows !== 1)
              throw new MigrationFailure('execution_fenced', '迁移执行权已失效')
          }
          if (await read_only(connection, controller.signal, { filename: file.filename, checkpoint }, script.verify) !== true)
            throw new MigrationFailure('verification_failed', `迁移完成验证未通过：${file.filename}`)
        }
        else {
          await connection.query(file.sql)
        }
        await assert_active()
        await connection.beginTransaction()
        try {
          const [finished] = await connection.execute<mysql.ResultSetHeader>('UPDATE migration_runs SET status = \'completed\', finished_at = CURRENT_TIMESTAMP, last_error_code = NULL WHERE filename = ? AND attempts = ? AND status = \'running\'', [file.filename, attempt])
          if (finished.affectedRows !== 1)
            throw new MigrationFailure('execution_fenced', '迁移完成回执的执行权已失效')
          if (file.filename === baseline_migration) {
            for (const historical_file of covered)
              await record_completed(historical_file)
          }
          controller.signal.throwIfAborted()
          await connection.commit()
        }
        catch (error) {
          await connection.rollback()
          throw error
        }
        applied.set(file.filename, file.checksum)
        if (file.filename === baseline_migration) {
          for (const historical_file of covered)
            applied.set(historical_file.filename, historical_file.checksum)
        }
        log_info('migration applied', { filename: file.filename })
      }
      catch (error) {
        // Never print raw SDK errors, SQL text, signed URLs, or checkpoint contents.
        const code = error instanceof MigrationFailure ? error.code : 'execution_failed'
        if (! controller.signal.aborted) {
          await connection.rollback()
          await assert_active()
          await connection.execute('UPDATE migration_runs SET status = \'failed\', last_error_code = ? WHERE filename = ? AND attempts = ? AND status = \'running\'', [code, file.filename, attempt])
        }
        log_error('migration failed', { filename: file.filename, code })
        throw new MigrationFailure(code, `迁移 ${file.filename} 执行失败，已终止；请检查状态与恢复步骤`)
      }
    }
    return { applied: [... applied.keys()], pending: [] }
  }
  finally {
    options.signal?.removeEventListener('abort', abort)
    connection.off('error', lost)
    try {
      if (locked && ! controller.signal.aborted)
        await connection.query('SELECT RELEASE_LOCK(?)', [lock_name])
    }
    finally { await connection.end() }
  }
}
