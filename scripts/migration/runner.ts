import type mysql from 'mysql2/promise'
import type { MigrationCheckpoint, MigrationContext, MigrationDatabase, MigrationReadContext } from './contract'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load_database_config } from '@config/loader'
import { log_error, log_info, log_warn } from '@server/lib/log'
import driver from 'mysql2/promise'
import { legacy_baseline_through, load_script, plan_migrations, read_migrations, runtime_migration, single_ledger_migration } from './catalog'
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

async function read_legacy_applied(connection: mysql.Connection) {
  if (! await table_exists(connection, 'schema_migrations'))
    return new Map<string, string>()
  const [rows] = await connection.query<mysql.RowDataPacket[]>('SELECT filename, checksum FROM schema_migrations')
  return new Map(rows.map(row => [String(row.filename), String(row.checksum)]))
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
  if (baseline && (check_only || dry_run || options.preflight || maintenance || options.retry_sql))
    throw new MigrationFailure('invalid_options', '--baseline 不能与 --status/--dry-run/--maintenance/--retry-sql 一起使用')
  const files = read_migrations(options.dir ?? `${process.cwd()}/migrations`, options.manifest)
  if (options.through && ! files.some(file => file.filename === options.through))
    throw new MigrationFailure('unknown_target', '--through 必须指定存在的完整迁移文件名')
  if (options.retry_sql && ! files.some(file => file.filename === options.retry_sql && ! file.artifact))
    throw new MigrationFailure('invalid_retry', '--retry-sql 必须指定存在的 SQL 迁移文件名')
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
    const has_legacy = await table_exists(connection, 'schema_migrations')
    const legacy = has_legacy ? await read_legacy_applied(connection) : new Map<string, string>()
    const has_runtime = await table_exists(connection, 'migration_runs')
    const runs = new Map((has_runtime ? await read_runs(connection) : []).map(row => [row.filename, row]))
    for (const [filename, checksum] of legacy) {
      const row = runs.get(filename)
      if (row && (row.checksum !== checksum || row.status !== 'completed'))
        throw new MigrationFailure('receipt_inconsistent', '新旧迁移账本冲突，请人工核对；旧表未删除')
    }
    if ([... runs.values()].some(row => row.status === 'completed' && row.finished_at == null))
      throw new MigrationFailure('completion_inconsistent', '已完成迁移缺少完成时间，请人工核对')
    if (has_legacy && runs.get(single_ledger_migration)?.status === 'completed')
      throw new MigrationFailure('legacy_ledger_reappeared', '已退休的旧迁移表重新出现，请核对恢复或回滚操作')
    // Legacy rows are a read-only upgrade input until the retirement SQL copies and verifies them.
    const applied = new Map([... legacy, ... [... runs.values()].filter(row => row.status === 'completed').map(row => [row.filename, row.checksum] as const)])
    const plan = plan_migrations(files, applied)
    const started_plan = plan_migrations(files, new Map([... runs.values()].map(row => [row.filename, row.checksum])))
    // A started script's bytes are immutable even before it has a completion receipt.
    const inconsistent = [... plan.inconsistent, ... started_plan.inconsistent.filter(item => item.reason !== 'out_of_order' || plan.pending.some(file => file.filename === item.filename))]
    if (inconsistent.length) {
      log_error('migrations inconsistent', { inconsistent })
      throw new MigrationFailure('inconsistent', '已应用或已开始的迁移文件被改动、删除了，或插入了历史迁移，需要人工确认后再跑')
    }
    const pending = plan.pending.filter(file => ! options.through || file.filename <= options.through)
    const [counts] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT IN (?, ?)', ['schema_migrations', 'migration_runs'],
    )
    const auto_baseline = applied.size === 0 && runs.size === 0 && Number(counts[0]?.n ?? 0) > 0
    const adopted = (baseline || auto_baseline) ? pending.filter(file => ! file.artifact && file.filename <= legacy_baseline_through) : []
    if (baseline && pending.some(file => file.artifact || file.filename > legacy_baseline_through))
      throw new MigrationFailure('baseline_boundary', 'baseline 仅适用于冻结的历史 SQL；请用 --through 指定历史边界，脚本和新 SQL 必须执行')

    if (options.preflight) {
      const classify_sql = sql_execution(files, options.dir ?? `${process.cwd()}/migrations`)
      const [identity] = await connection.query<mysql.RowDataPacket[]>('SELECT @@server_uuid AS server_uuid')
      const details = []
      for (const file of pending.filter(file => ! adopted.includes(file))) {
        const previous = runs.get(file.filename)
        const execution = file.artifact ? (await load_script(file)).execution : classify_sql(file)
        details.push({ filename: file.filename, checksum: file.checksum, status: previous?.status ?? 'pending', phase: previous?.phase ?? 'apply', execution })
      }
      const report = {
        version: 1 as const,
        database: { host: config.host, port: config.port, name: config.name, server_uuid: String(identity[0]?.server_uuid ?? '') },
        catalog: files.map(({ filename, checksum }) => ({ filename, checksum })),
        legacy: [... legacy].map(([filename, checksum]) => ({ filename, checksum })).sort((a, b) => a.filename.localeCompare(b.filename)),
        ledger: [... runs.values()].map(({ filename, checksum, status, phase, attempts, finished_at }) => ({ filename, checksum, status, phase, attempts, finished: Boolean(finished_at) })).sort((a, b) => a.filename.localeCompare(b.filename)),
        pending: details,
        requires_maintenance: details.some(file => file.execution === 'maintenance'),
        sql_recovery_required: pending.filter(file => ! file.artifact && runs.has(file.filename) && runs.get(file.filename)?.status !== 'completed').map(file => file.filename),
      }
      return { applied: [... applied.keys()], pending: [], preflight: { ... report, fingerprint: deployment_fingerprint(report) } }
    }
    if (check_only || dry_run) {
      const details = []
      let blocked_by: string | null = null
      for (const file of pending) {
        let report = null
        let execution: string = 'automatic'
        if (file.artifact) {
          execution = 'script'
          if (dry_run && ! blocked_by) {
            const script = await load_script(file)
            execution = script.execution
            report = await read_only(connection, controller.signal, { filename: file.filename, checkpoint: runs.get(file.filename)?.checkpoint ?? null }, script.plan)
          }
        }
        details.push({ filename: file.filename, status: runs.get(file.filename)?.status ?? 'pending', phase: runs.get(file.filename)?.phase ?? 'apply', execution, blocked_by, report })
        if (! adopted.includes(file))
          blocked_by ??= file.filename
      }
      const executions = [... runs.values()].map(({ filename, status, phase, attempts, last_error_code }) => ({ filename, status, phase, attempts, last_error_code }))
      log_info('migrations pending', { applied: [... applied.keys()], pending: pending.map(file => file.filename), legacy_ledger: has_legacy, auto_baseline, baseline: adopted.map(file => file.filename), details, executions })
      return { applied: [... applied.keys()], pending: details }
    }
    if (! pending.length) {
      log_info('migrations up to date', { applied: applied.size })
      return { applied: [... applied.keys()], pending: [] }
    }
    // Classify the complete chain before metadata DDL or any earlier SQL can commit.
    const classify_sql = sql_execution(files, options.dir ?? `${process.cwd()}/migrations`)
    const scripts = new Map<string, Awaited<ReturnType<typeof load_script>>>()
    for (const file of pending.filter(file => ! adopted.includes(file))) {
      const script = file.artifact ? await load_script(file) : null
      if (script)
        scripts.set(file.filename, script)
      if (! maintenance && (script?.execution ?? classify_sql(file)) === 'maintenance')
        throw new MigrationFailure('maintenance_required', `迁移 ${file.filename} 需要维护窗口，请显式运行 pnpm migrate --maintenance`)
      const previous = runs.get(file.filename)
      if (! script && previous && previous.status !== 'completed' && options.retry_sql !== file.filename)
        throw new MigrationFailure('sql_recovery_required', `SQL ${file.filename} 可能已部分执行，请核对后显式使用 --retry-sql ${file.filename}`)
    }
    await assert_active()
    if (! has_runtime) {
      // Bootstrap only the metadata DDL from its immutable SQL source. Its version
      // receipt is still written at the normal position in the ordered chain.
      const metadata_sql = files.find(file => file.filename === runtime_migration)?.sql
        ?? readFileSync(resolve(process.cwd(), 'migrations', runtime_migration), 'utf8')
      await connection.query(metadata_sql)
    }
    if (auto_baseline)
      log_warn('database has tables but no migration records; adopting historical SQL only', { baselined: adopted.map(file => file.filename) })
    for (const file of adopted) {
      await assert_active()
      await connection.query('INSERT INTO migration_runs (filename, checksum, status, phase, attempts, finished_at) VALUES (?, ?, \'completed\', \'verify\', 0, CURRENT_TIMESTAMP)', [file.filename, file.checksum])
      applied.set(file.filename, file.checksum)
    }
    if (baseline)
      return { applied: [... applied.keys()], pending: [] }

    for (const file of pending.filter(file => ! adopted.includes(file))) {
      await assert_active()
      const script = scripts.get(file.filename) ?? null
      if (script?.execution === 'maintenance' && ! maintenance)
        throw new MigrationFailure('maintenance_required', `迁移 ${file.filename} 需要维护窗口，请显式运行 pnpm migrate --maintenance`)
      const previous = runs.get(file.filename)
      if (! script && previous && previous.status !== 'completed' && options.retry_sql !== file.filename)
        throw new MigrationFailure('sql_recovery_required', `SQL ${file.filename} 可能已部分执行，请核对后显式使用 --retry-sql ${file.filename}`)
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
          await connection.commit()
        }
        catch (error) {
          await connection.rollback()
          throw error
        }
        applied.set(file.filename, file.checksum)
        log_info('migration applied', { filename: file.filename })
      }
      catch (error) {
        // Never print raw SDK errors, SQL text, signed URLs, or checkpoint contents.
        const code = error instanceof MigrationFailure ? error.code : 'execution_failed'
        if (! controller.signal.aborted) {
          await connection.rollback()
          await assert_active()
          await connection.execute('UPDATE migration_runs SET status = \'failed\', last_error_code = ? WHERE filename = ? AND attempts = ?', [code, file.filename, attempt])
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
