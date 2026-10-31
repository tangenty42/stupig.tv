import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const filename = '20261024030000_fixture.ts'

// Real compiled handlers run against the MySQL boundary; no handler/runtime mocks.
const state = vi.hoisted(() => ({
  schema: false, runtime: false, business_tables: 0, lock: 1, owned: 1,
  legacy: new Map<string, string>(),
  runs: new Map<string, { filename: string, checksum: string, status: string, phase: string, checkpoint: unknown, attempts: number, finished_at: string | null }>(),
  rows: new Set<number>(), queries: [] as string[], errors: [] as unknown[],
  fail_row: 0, verify: true, lose_on_insert: false, fail_sql: '',
  fenced: '',
  transaction: null as null | { rows: Set<number>, runs: Map<string, object> },
}))

function completed() {
  return new Map([... state.runs.values()].filter(row => row.status === 'completed').map(row => [row.filename, row.checksum]))
}

function sql_call(sql: string, values: unknown[] = []): [unknown, unknown[]] {
  state.queries.push(sql)
  if ((state.fenced === 'checkpoint' && sql.includes('UPDATE migration_runs SET checkpoint'))
    || (state.fenced === 'phase' && sql.includes('UPDATE migration_runs SET phase'))
    || (state.fenced === 'completion' && values[0] === filename && sql.includes('UPDATE migration_runs SET status') && sql.includes('completed'))) {
    return [{ affectedRows: 0 }, []]
  }
  if (sql.includes('GET_LOCK'))
    return [[{ acquired: state.lock }], []]
  if (sql.includes('IS_USED_LOCK'))
    return [[{ owned: state.owned }], []]
  if (sql.includes('@@server_uuid'))
    return [[{ server_uuid: '11111111-1111-1111-1111-111111111111' }], []]
  if (sql.includes('information_schema')) {
    if (sql.includes('COUNT'))
      return [[{ n: state.business_tables }], []]
    return [(values[0] === 'migration_runs' ? state.runtime : state.schema) ? [{}] : [], []]
  }
  if (sql.includes('FROM schema_migrations'))
    return [[... state.legacy].map(([filename, checksum]) => ({ filename, checksum })), []]
  if (sql.includes('FROM migration_runs'))
    return [[... state.runs.values()].map(row => structuredClone(row)), []]
  if (sql.includes('CREATE TABLE IF NOT EXISTS `migration_runs`'))
    state.runtime = true
  if (sql.includes('INSERT INTO migration_runs')) {
    const [filename, checksum, phase, checkpoint, attempts] = values
    const old = state.runs.get(String(filename))
    const baseline = sql.includes('\'completed\'')
    state.runs.set(String(filename), { filename: String(filename), checksum: String(checksum), status: baseline ? 'completed' : 'running', phase: baseline ? 'verify' : old?.phase ?? String(phase), checkpoint: baseline ? null : old?.checkpoint ?? JSON.parse(String(checkpoint)), attempts: baseline ? 0 : Number(attempts), finished_at: baseline ? '2026-10-24' : null })
  }
  if (sql.includes('UPDATE migration_runs SET checkpoint')) {
    const row = state.runs.get(String(values[1]))!
    if (row.attempts !== values[3])
      return [{ affectedRows: 0 }, []]
    row.checkpoint = JSON.parse(String(values[0]))
  }
  if (sql.includes('UPDATE migration_runs SET phase'))
    state.runs.get(String(values[1]))!.phase = String(values[0])
  if (sql.includes('UPDATE migration_runs SET status')) {
    const failed = sql.includes('failed')
    const row = state.runs.get(String(values[failed ? 1 : 0]))!
    row.status = failed ? 'failed' : 'completed'
    row.finished_at = failed ? null : '2026-10-24'
  }
  if (sql.includes('INSERT INTO fixture_rows')) {
    const n = Number(values[0])
    if (n === state.fail_row)
      throw new Error('SECRET https://signed.invalid/?token=secret')
    state.rows.add(n)
    if (state.lose_on_insert)
      state.owned = 0
  }
  if (sql.includes('SELECT fixture_count'))
    return [[{ n: state.verify ? state.rows.size : - 1 }], []]
  if (state.fail_sql && sql.includes(state.fail_sql))
    throw new Error('sensitive SQL or SDK payload')
  return [{ affectedRows: 1 }, []]
}

vi.mock('mysql2/promise', () => ({
  default: {
    createConnection: async () => ({
      query: async (sql: string, values?: unknown[]) => sql_call(sql, values),
      execute: async (sql: string, values?: unknown[]) => sql_call(sql, values),
      on: () => {}, off: () => {}, end: async () => {},
      beginTransaction: async () => { state.transaction = structuredClone({ rows: state.rows, runs: state.runs }) },
      commit: async () => { state.transaction = null },
      rollback: async () => {
        if (state.transaction) {
          state.rows = state.transaction.rows
          state.runs = state.transaction.runs as typeof state.runs
          state.transaction = null
        }
      },
    }),
  },
}))
vi.mock('@config/loader', () => ({ load_database_config: () => ({ host: 'db', port: 3306, user: 'u', password: 'p', name: 'qa' }) }))
vi.mock('@server/lib/log', () => ({ log_info: () => {}, log_warn: () => {}, log_error: (... args: unknown[]) => state.errors.push(args) }))

const { run_migrations } = await import('./local')
const { runtime_migration, sha256, single_ledger_migration } = await import('./catalog')
const script = `export default {
  execution: 'maintenance',
  async plan({db}) { await db.query('SELECT fixture_count'); return {summary:'fixture',counts:{rows:3}} },
  async apply(ctx) {
    await ctx.db.query('SELECT apply_called');
    for (let n = (ctx.checkpoint.value?.n ?? 0) + 1; n <= 3; n++) {
      await ctx.transaction(async db => {
        await db.execute('INSERT INTO fixture_rows VALUES (?)', [n]);
        await ctx.checkpoint.save({n});
      });
    }
  },
  async verify({db}) { const [rows] = await db.query('SELECT fixture_count'); return rows[0].n === 3 }
}`
let dir: string
beforeEach(async () => {
  Object.assign(state, { schema: false, runtime: false, business_tables: 0, lock: 1, owned: 1, legacy: new Map(), runs: new Map(), rows: new Set(), queries: [], errors: [], fail_row: 0, verify: true, lose_on_insert: false, fail_sql: '', fenced: '', transaction: null })
  dir = await mkdtemp(resolve(tmpdir(), 'stupig-migration-runtime-'))
  await writeFile(resolve(dir, runtime_migration), await readFile(resolve(import.meta.dirname, '../../migrations', runtime_migration)))
  await writeFile(resolve(dir, filename), script)
})

describe('mixed migration runtime', () => {
  it('rejects a later maintenance script before any preceding SQL or metadata writes', async () => {
    await expect(run_migrations({ dir })).rejects.toThrow(/maintenance|维护/)
    expect(state.queries.some(sql => /CREATE|INSERT|UPDATE|ALTER|DELETE|DROP/.test(sql))).toBe(false)
    expect(state.runtime).toBe(false)
  })

  it('classifies the entire pending chain without invoking plans or writing receipts', async () => {
    const sql_file = '20261031010000_late.sql'
    await writeFile(resolve(dir, sql_file), 'SELECT late_sql')
    const result = await run_migrations({ dir, preflight: true })
    expect(result.preflight?.requires_maintenance).toBe(true)
    expect(result.preflight?.pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ filename, execution: 'maintenance' }),
      expect.objectContaining({ filename: sql_file, execution: 'maintenance' }),
    ]))
    expect(state.queries).not.toContain('SELECT fixture_count')
    expect(state.queries.some(sql => /CREATE|INSERT|UPDATE|ALTER|DELETE|DROP/.test(sql))).toBe(false)
    const again = await run_migrations({ dir, preflight: true })
    expect(again.preflight?.fingerprint).toBe(result.preflight?.fingerprint)
  })

  it('allows new SQL online only when its exact digest is declared', async () => {
    const sql_file = '20261031010000_online.sql'
    const sql = 'SELECT online_sql'
    await writeFile(resolve(dir, filename), script.replace('execution: \'maintenance\'', 'execution: \'automatic\''))
    await writeFile(resolve(dir, sql_file), sql)
    await expect(run_migrations({ dir })).rejects.toThrow(/维护/)
    await writeFile(resolve(dir, 'deployment.json'), JSON.stringify({ version: 1, automatic_sql: { [sql_file]: sha256(sql) } }))
    await run_migrations({ dir })
    expect(state.queries).toContain(sql)
    await writeFile(resolve(dir, sql_file), `${sql} `)
    await expect(run_migrations({ dir, preflight: true })).rejects.toThrow(/改动|inconsistent/)
  })

  it('新库只使用新账本，完成后没有旧表也不会重新执行', async () => {
    await run_migrations({ dir, maintenance: true })
    const before = state.queries.filter(sql => sql === 'SELECT apply_called').length
    expect(state.schema).toBe(false)
    expect(state.queries.some(sql => /(?:CREATE|INSERT INTO)\s+schema_migrations/i.test(sql))).toBe(false)
    await run_migrations({ dir, maintenance: true })
    expect(state.queries.filter(sql => sql === 'SELECT apply_called')).toHaveLength(before)
  })

  it('旧表仅作为升级输入，已完成 SQL 不重跑，状态查询不做迁移', async () => {
    const legacy_file = '20261024010000_legacy.sql'
    const sql = 'SELECT legacy_must_not_repeat'
    await writeFile(resolve(dir, legacy_file), sql)
    state.schema = true
    state.legacy.set(legacy_file, sha256(sql))
    await run_migrations({ dir, check_only: true })
    expect(state.runtime).toBe(false)
    expect(state.queries.some(sql => /INSERT|CREATE|UPDATE|DROP/.test(sql))).toBe(false)
    await run_migrations({ dir, through: runtime_migration })
    expect(state.queries).not.toContain(sql)
    expect(state.legacy.get(legacy_file)).toBe(sha256(sql))
  })

  it.each(['checksum', 'status'])('新旧账本 %s 冲突时禁止推进或删除旧表', async (conflict) => {
    const legacy_file = '20261024010000_legacy.sql'
    const sql = 'SELECT legacy_must_not_repeat'
    await writeFile(resolve(dir, legacy_file), sql)
    state.schema = true
    state.runtime = true
    state.legacy.set(legacy_file, sha256(sql))
    state.runs.set(legacy_file, { filename: legacy_file, checksum: conflict === 'checksum' ? '0'.repeat(64) : sha256(sql), status: conflict === 'status' ? 'failed' : 'completed', phase: 'apply', checkpoint: null, attempts: 1, finished_at: '2026-10-24' })
    await expect(run_migrations({ dir, maintenance: true })).rejects.toThrow(/新旧迁移账本冲突/)
    expect(state.schema).toBe(true)
    expect(state.queries.some(sql => /INSERT|CREATE|UPDATE|DROP/.test(sql))).toBe(false)
  })

  it('已经退休的旧表重新出现时拒绝静默接管', async () => {
    state.schema = true
    state.runtime = true
    state.runs.set(single_ledger_migration, { filename: single_ledger_migration, checksum: '0'.repeat(64), status: 'completed', phase: 'apply', checkpoint: null, attempts: 1, finished_at: '2026-10-24' })
    await expect(run_migrations({ dir })).rejects.toThrow(/重新出现/)
  })

  it('有未完成 SQL 执行记录时不能自动 baseline 吞掉失败', async () => {
    const file = '20261008000000_old.sql'
    await writeFile(resolve(dir, file), 'SELECT old_schema')
    state.runtime = true
    state.business_tables = 8
    state.runs.set(file, { filename: file, checksum: sha256('SELECT old_schema'), status: 'failed', phase: 'apply', checkpoint: null, attempts: 1, finished_at: null })
    await expect(run_migrations({ dir })).rejects.toThrow(/retry-sql/)
    expect(state.runs.get(file)?.status).toBe('failed')
  })
  it.each(['checkpoint', 'phase', 'completion'])('执行权 %s 的围栏拒绝假成功，恢复后仍可续跑', async (fenced) => {
    state.fenced = fenced
    await expect(run_migrations({ dir, maintenance: true })).rejects.toThrow(/已终止/)
    expect(completed().has(filename)).toBe(false)
    expect(state.runs.get(filename)?.status).toBe('failed')
    state.fenced = ''
    await run_migrations({ dir, maintenance: true })
    expect(completed().has(filename)).toBe(true)
  })
  it('按顺序执行 SQL／脚本／SQL，脚本默认维护门禁阻止后续步骤', async () => {
    await writeFile(resolve(dir, '20261024040000_after.sql'), 'SELECT after_script')
    await expect(run_migrations({ dir })).rejects.toThrow(/维护窗口/)
    expect(completed().has(runtime_migration)).toBe(false)
    expect(state.rows.size).toBe(0)
    expect(state.queries.some(sql => sql.includes('after_script'))).toBe(false)
    await run_migrations({ dir, maintenance: true })
    expect([... completed().keys()]).toEqual([runtime_migration, filename, '20261024040000_after.sql'])
    const writes = state.queries.filter(sql => sql.includes('INSERT INTO fixture_rows')).length
    await run_migrations({ dir, maintenance: true })
    expect(state.queries.filter(sql => sql.includes('INSERT INTO fixture_rows'))).toHaveLength(writes)
  })

  it('失败保留事务检查点，续跑从最后提交的项目开始且隐藏原始错误', async () => {
    state.fail_row = 3
    await expect(run_migrations({ dir, maintenance: true })).rejects.toThrow(/已终止/)
    expect(state.runs.get(filename)).toMatchObject({ status: 'failed', phase: 'apply', checkpoint: { n: 2 }, attempts: 1 })
    expect(completed().has(filename)).toBe(false)
    expect(JSON.stringify(state.errors)).not.toMatch(/SECRET|token|sensitive/)
    state.fail_row = 0
    await run_migrations({ dir, maintenance: true })
    expect(state.runs.get(filename)).toMatchObject({ status: 'completed', attempts: 2 })
    expect([... state.rows]).toEqual([1, 2, 3])
    expect(state.queries.filter(sql => sql.includes('INSERT INTO fixture_rows'))).toHaveLength(4)
  })

  it('验证失败不登记成功，重跑只验证，不重新产生副作用', async () => {
    state.verify = false
    await expect(run_migrations({ dir, maintenance: true })).rejects.toThrow(/已终止/)
    expect(state.runs.get(filename)).toMatchObject({ status: 'failed', phase: 'verify' })
    expect(completed().has(filename)).toBe(false)
    state.verify = true
    await run_migrations({ dir, maintenance: true })
    expect(state.queries.filter(sql => sql.includes('INSERT INTO fixture_rows'))).toHaveLength(3)
    expect(state.queries.filter(sql => sql === 'SELECT apply_called')).toHaveLength(1)
    expect(completed().has(filename)).toBe(true)
  })

  it('已失败脚本及依赖不能改字节后继续执行', async () => {
    state.fail_row = 2
    await expect(run_migrations({ dir, maintenance: true })).rejects.toThrow()
    await writeFile(resolve(dir, filename), script.replace('rows:3', 'rows:4'))
    await expect(run_migrations({ dir, maintenance: true })).rejects.toThrow(/改动/)
    expect(state.rows.size).toBe(1)
  })

  it('锁丢失后回滚当前数据库事务，停止检查点和后续步骤', async () => {
    state.lose_on_insert = true
    await expect(run_migrations({ dir, maintenance: true })).rejects.toThrow(/已终止/)
    expect(state.rows.size).toBe(0)
    expect(state.runs.get(filename)?.checkpoint).toBeNull()
    expect(state.queries.filter(sql => sql.includes('INSERT INTO fixture_rows'))).toHaveLength(1)
    expect(completed().has(filename)).toBe(false)
  })

  it('只读状态不建表、不写账本；预演不执行被待迁移 SQL 阻挡的脚本', async () => {
    await run_migrations({ dir, dry_run: true })
    expect(state.queries.some(sql => /INSERT|UPDATE|CREATE/.test(sql))).toBe(false)
    expect(state.queries).not.toContain('SELECT fixture_count')
    await run_migrations({ dir, through: runtime_migration })
    const writes = state.queries.length
    await run_migrations({ dir, dry_run: true })
    expect(state.queries.slice(writes)).toContain('SELECT fixture_count')
    expect(state.rows.size).toBe(0)
  })

  it('预演与验证不能通过上下文执行写 SQL', async () => {
    await writeFile(resolve(dir, filename), script.replace('await db.query(\'SELECT fixture_count\')', 'await db.query(\'DELETE FROM fixture_rows\')'))
    await run_migrations({ dir, through: runtime_migration })
    await expect(run_migrations({ dir, dry_run: true })).rejects.toThrow(/只读/)
    expect(state.queries).not.toContain('DELETE FROM fixture_rows')
  })

  it('自动 baseline 只接管历史 SQL，脚本仍须实际运行', async () => {
    state.business_tables = 8
    await writeFile(resolve(dir, '20261008000000_old.sql'), 'SELECT old_schema')
    await expect(run_migrations({ dir })).rejects.toThrow(/维护窗口/)
    expect(completed().has('20261008000000_old.sql')).toBe(false)
    expect(state.queries).not.toContain('SELECT old_schema')
    expect(completed().has(filename)).toBe(false)
    expect(state.runtime).toBe(false)
  })

  it('显式 baseline 不得把脚本或新 SQL 标为完成', async () => {
    await expect(run_migrations({ dir, baseline: true })).rejects.toThrow(/历史 SQL/)
    expect(completed().size).toBe(0)
  })

  it('status 不导入脚本模块；未知结果及失败检查点不泄漏', async () => {
    await run_migrations({ dir, through: runtime_migration })
    await writeFile(resolve(dir, filename), 'throw new Error("must not import during status"); export default {}')
    await expect(run_migrations({ dir, check_only: true })).resolves.toBeDefined()
    expect(completed().has(filename)).toBe(false)
  })

  it('部分 SQL 失败后重跑要求明确恢复指令，不能自动重复部分执行', async () => {
    await writeFile(resolve(dir, '20261024025000_partial.sql'), 'SELECT partial_failure')
    state.fail_sql = 'partial_failure'
    await expect(run_migrations({ dir, maintenance: true })).rejects.toThrow(/已终止/)
    state.fail_sql = ''
    await expect(run_migrations({ dir, maintenance: true })).rejects.toThrow(/retry-sql/)
    await run_migrations({ dir, maintenance: true, retry_sql: '20261024025000_partial.sql' })
    expect(completed().has(filename)).toBe(true)
  })

  it('非法超大检查点不会写入，完成账本被破坏时不继续执行', async () => {
    await writeFile(resolve(dir, filename), script.replace('await ctx.checkpoint.save({n})', 'await ctx.checkpoint.save({data:"x".repeat(65537)})'))
    await expect(run_migrations({ dir, maintenance: true })).rejects.toThrow(/已终止/)
    expect(state.runs.get(filename)?.checkpoint).toBeNull()
    expect(state.rows.size).toBe(0)
    state.runs.get(filename)!.status = 'completed'
    await expect(run_migrations({ dir, maintenance: true })).rejects.toThrow(/缺少完成时间/)
  })

  it('无法获得锁以及已停止的调用都不能产生业务写入', async () => {
    state.lock = 0
    await expect(run_migrations({ dir, maintenance: true })).rejects.toThrow(/没抢到/)
    expect(state.rows.size).toBe(0)
    state.lock = 1
    state.queries = []
    const controller = new AbortController()
    controller.abort()
    await expect(run_migrations({ dir, maintenance: true, signal: controller.signal })).rejects.toThrow(/停止/)
    expect(state.rows.size).toBe(0)
    expect(state.queries.some(sql => /CREATE|INSERT|UPDATE/.test(sql))).toBe(false)
  })
})
