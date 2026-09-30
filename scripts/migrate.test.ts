import type { MigrationFile } from './migrate'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { plan_migrations, read_migrations } from './migrate'

function file(filename: string, sql: string): MigrationFile {
  return { filename, sql, checksum: createHash('sha256').update(sql).digest('hex') }
}

describe('read_migrations', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(resolve(tmpdir(), 'stupig-migrations-'))
    // 刻意乱序写入，断言按文件名排序
    await writeFile(resolve(dir, '20260902_b.sql'), 'SELECT 2;\n')
    await writeFile(resolve(dir, '20260901_a.sql'), 'SELECT 1;\n')
    await writeFile(resolve(dir, 'notes.txt'), 'ignored')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('只收 .sql 且按文件名排序（时间戳前缀即执行顺序）', () => {
    expect(read_migrations(dir).map(item => item.filename)).toEqual(['20260901_a.sql', '20260902_b.sql'])
  })

  it('目录不存在时返回空，不抛错', () => {
    expect(read_migrations(resolve(dir, 'nope'))).toEqual([])
  })
})

describe('plan_migrations', () => {
  it('未记录的文件进 pending，已记录且 checksum 一致的跳过', () => {
    const first = file('20260901_a.sql', 'SELECT 1;')
    const second = file('20260902_b.sql', 'SELECT 2;')
    const plan = plan_migrations([first, second], new Map([[first.filename, first.checksum]]))
    expect(plan.pending.map(item => item.filename)).toEqual(['20260902_b.sql'])
    expect(plan.inconsistent).toEqual([])
  })

  it('已应用的文件被改动 → 标记 modified', () => {
    const applied = file('20260901_a.sql', 'SELECT 1;')
    const edited = file('20260901_a.sql', 'SELECT 1; -- 偷偷改了')
    const plan = plan_migrations([edited], new Map([[applied.filename, applied.checksum]]))
    expect(plan.inconsistent).toEqual([{ filename: '20260901_a.sql', reason: 'modified' }])
  })

  it('已应用的文件被删 → 标记 missing', () => {
    const applied = file('20260901_a.sql', 'SELECT 1;')
    const plan = plan_migrations([], new Map([[applied.filename, applied.checksum]]))
    expect(plan.inconsistent).toEqual([{ filename: '20260901_a.sql', reason: 'missing' }])
  })

  it('一切正常时 pending 为空（幂等：重复跑不会重放）', () => {
    const first = file('20260901_a.sql', 'SELECT 1;')
    const plan = plan_migrations([first], new Map([[first.filename, first.checksum]]))
    expect(plan.pending).toEqual([])
    expect(plan.inconsistent).toEqual([])
  })
})
