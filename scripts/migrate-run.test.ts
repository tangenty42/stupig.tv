import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 迁移执行器的行为只能靠"真的有没有执行 SQL、有没有记录"来断言，而这些全在 DB 边界上。
// 按仓库约定在边界处 mock（mysql2 / config / log），不碰任何真实数据库。
const state = vi.hoisted(() => ({
  queries: [] as string[],
  /** 迁移文件里的 SQL（不含 schema_migrations 自身的记账语句） */
  executed: [] as string[],
  applied: [] as { filename: string, checksum: string }[],
  table_exists: false,
  /** 业务表（非 schema_migrations）数量：非零模拟"存量未接管"的库 */
  business_tables: 0,
  fail_on: null as string | null,
  warns: [] as string[],
  infos: [] as { msg: string, fields?: Record<string, unknown> }[],
}))

function is_bookkeeping(sql: string) {
  return sql.includes('schema_migrations') || sql.includes('information_schema') || sql.includes('LOCK')
}

vi.mock('mysql2/promise', () => ({
  default: {
    createConnection: async () => ({
      query: async (sql: string) => {
        state.queries.push(sql)
        if (sql.includes('GET_LOCK')) {
          return [[{ acquired: 1 }], []]
        }
        if (sql.includes('information_schema.TABLES')) {
          if (sql.includes('COUNT(*)')) {
            return [[{ n: state.business_tables }], []]
          }
          return [state.table_exists ? [{ exists: 1 }] : [], []]
        }
        if (sql.includes('FROM schema_migrations')) {
          return [state.applied, []]
        }
        if (state.fail_on && sql.includes(state.fail_on)) {
          throw new Error(`模拟 SQL 失败: ${sql.slice(0, 40)}`)
        }
        if (! is_bookkeeping(sql) && ! sql.includes('SET time_zone')) {
          state.executed.push(sql)
        }
        return [{}, []]
      },
      end: async () => {},
    }),
  },
}))

vi.mock('@server/shared/config', () => ({
  load_config: () => ({ db: { host: 'db', port: 3306, user: 'u', password: 'p', name: 'stupig_tv' } }),
}))

vi.mock('@server/lib/log', () => ({
  log_info: (msg: string, fields?: Record<string, unknown>) => {
    state.infos.push({ msg, fields })
  },
  log_warn: (msg: string) => {
    state.warns.push(msg)
  },
  log_error: () => {},
  error_fields: () => ({}),
}))

const { run_migrations } = await import('./migrate')

const checksum_of = (sql: string) => createHash('sha256').update(sql).digest('hex')

let dir: string

beforeEach(async () => {
  state.queries = []
  state.executed = []
  state.applied = []
  state.table_exists = false
  state.business_tables = 0
  state.fail_on = null
  state.warns = []
  state.infos = []
  dir = await mkdtemp(resolve(tmpdir(), 'stupig-migrate-run-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const write_migration = (name: string, sql: string) => writeFile(resolve(dir, name), sql)

describe('run_migrations', () => {
  it('按文件名顺序执行待应用迁移，并逐条记录', async () => {
    await write_migration('20260902_b.sql', 'SELECT 2;')
    await write_migration('20260901_a.sql', 'SELECT 1;')
    await run_migrations({ dir })

    expect(state.executed).toEqual(['SELECT 1;', 'SELECT 2;'])
    expect(state.queries.filter(sql => sql.includes('INSERT INTO schema_migrations'))).toHaveLength(2)
  })

  it('已记录的迁移不重复执行（幂等）', async () => {
    await write_migration('20260901_a.sql', 'SELECT 1;')
    state.table_exists = true
    state.applied = [{ filename: '20260901_a.sql', checksum: checksum_of('SELECT 1;') }]

    await run_migrations({ dir })
    expect(state.executed).toEqual([])
  })

  it('迁移执行失败时抛出，不记录该文件、不继续后面的文件', async () => {
    await write_migration('20260901_a.sql', 'BROKEN STATEMENT')
    await write_migration('20260902_b.sql', 'SELECT 2;')
    state.fail_on = 'BROKEN STATEMENT'

    await expect(run_migrations({ dir })).rejects.toThrowError(/20260901_a\.sql/)
    expect(state.queries.filter(sql => sql.includes('INSERT INTO schema_migrations'))).toHaveLength(0)
    expect(state.executed).not.toContain('SELECT 2;')
  })

  it('--status 全程只读：不建表、不执行迁移、不写记录', async () => {
    await write_migration('20260901_a.sql', 'SELECT 1;')
    await run_migrations({ dir, check_only: true })

    expect(state.executed).toEqual([])
    expect(state.queries.some(sql => sql.includes('CREATE TABLE'))).toBe(false)
    expect(state.queries.some(sql => sql.includes('INSERT INTO'))).toBe(false)
  })

  it('--baseline 只记录不执行 SQL', async () => {
    await write_migration('20260901_a.sql', 'SELECT 1;')
    await run_migrations({ dir, baseline: true })

    expect(state.executed).toEqual([])
    expect(state.queries.filter(sql => sql.includes('INSERT INTO schema_migrations'))).toHaveLength(1)
  })

  it('已应用的迁移文件被改动时拒绝执行，且一条都不应用', async () => {
    await write_migration('20260901_a.sql', 'SELECT 1; -- 改了')
    await write_migration('20260902_b.sql', 'SELECT 2;')
    state.table_exists = true
    state.applied = [{ filename: '20260901_a.sql', checksum: '0'.repeat(64) }]

    await expect(run_migrations({ dir })).rejects.toThrowError(/改动/)
    expect(state.executed).toEqual([])
  })

  it('迁移失败时仍然释放锁，并把连接用到的会话时区设置好', async () => {
    await write_migration('20260901_a.sql', 'BROKEN')
    state.fail_on = 'BROKEN'
    await expect(run_migrations({ dir })).rejects.toThrow()
    expect(state.queries.some(sql => sql.includes('RELEASE_LOCK'))).toBe(true)
    expect(state.queries.some(sql => sql.includes('SET time_zone'))).toBe(true)
  })

  it('--baseline 与 --status 同用时报错（语义冲突）', async () => {
    await expect(run_migrations({ dir, baseline: true, check_only: true })).rejects.toThrowError(/不能与/)
  })

  it('存量库（有业务表但无迁移记录）自动 baseline：登记而不执行 SQL', async () => {
    await write_migration('20260901_a.sql', 'SELECT 1;')
    state.business_tables = 7

    await run_migrations({ dir })

    expect(state.executed).toEqual([])
    expect(state.queries.filter(sql => sql.includes('INSERT INTO schema_migrations'))).toHaveLength(1)
    expect(state.warns.some(msg => msg.includes('no migration records'))).toBe(true)
  })

  it('已有迁移记录时照常执行新迁移，绝不自动 baseline', async () => {
    await write_migration('20260901_a.sql', 'SELECT 1;')
    await write_migration('20260902_b.sql', 'SELECT 2;')
    state.table_exists = true
    state.business_tables = 7
    state.applied = [{ filename: '20260901_a.sql', checksum: checksum_of('SELECT 1;') }]

    await run_migrations({ dir })

    expect(state.executed).toEqual(['SELECT 2;'])
    expect(state.warns).toEqual([])
  })

  it('--status 报告存量库将被自动 baseline（仍全程只读）', async () => {
    await write_migration('20260901_a.sql', 'SELECT 1;')
    state.business_tables = 7

    await run_migrations({ dir, check_only: true })

    expect(state.executed).toEqual([])
    expect(state.queries.some(sql => sql.includes('CREATE TABLE'))).toBe(false)
    expect(state.queries.some(sql => sql.includes('INSERT INTO'))).toBe(false)
    expect(state.infos.some(entry => entry.msg === 'migrations pending' && entry.fields?.auto_baseline === true)).toBe(true)
  })
})
