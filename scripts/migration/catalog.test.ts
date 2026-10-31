import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { build_migration_scripts } from './build'
import { migration_script_names, plan_migrations, read_migrations, sha256 } from './catalog'
import { migration_options } from './cli'
import { define_migration } from './contract'

describe('script migration artifacts', () => {
  it('闭包产物跨输出目录一致，修改被引用的 helper 会改变身份', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'stupig-migration-artifact-'))
    const name = '20261024030000_example.ts'
    await writeFile(resolve(dir, name), 'import { value } from "./helper.mjs"; export default {value}')
    await writeFile(resolve(dir, 'helper.mjs'), 'export const value = 1')
    const first = read_migrations(dir, await build_migration_scripts(dir, resolve(dir, 'a')))[0]!
    const second = read_migrations(dir, await build_migration_scripts(dir, resolve(dir, 'b')))[0]!
    expect(first.checksum).toBe(second.checksum)
    const other = await mkdtemp(resolve(tmpdir(), 'stupig-migration-other-checkout-'))
    await writeFile(resolve(other, name), await readFile(resolve(dir, name)))
    await writeFile(resolve(other, 'helper.mjs'), await readFile(resolve(dir, 'helper.mjs')))
    expect(read_migrations(other, await build_migration_scripts(other, resolve(other, 'compiled')))[0]!.checksum).toBe(first.checksum)
    await writeFile(resolve(dir, 'helper.mjs'), 'export const value = 2')
    const third = read_migrations(dir, await build_migration_scripts(dir, resolve(dir, 'c')))[0]!
    expect(third.checksum).not.toBe(first.checksum)
    expect(plan_migrations([third], new Map([[name, first.checksum]])).inconsistent).toEqual([{ filename: name, reason: 'modified' }])
    await writeFile(third.artifact!, `${await readFile(third.artifact!, 'utf8')}\n// tampered`)
    expect(() => read_migrations(dir, resolve(dir, 'c/manifest.json'))).toThrow(/校验失败/)
  })

  it('拒绝未构建、源码过期、目录越界的脚本产物', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'stupig-migration-manifest-'))
    const name = '20261024030000_example.ts'
    await writeFile(resolve(dir, name), 'export default {}')
    expect(() => read_migrations(dir)).toThrow(/缺少构建清单/)
    const path = await build_migration_scripts(dir, resolve(dir, 'compiled'))
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(resolve(dir, name), 'export default {changed:true}')
    expect(() => read_migrations(dir, path)).toThrow(/源码校验/)
    await writeFile(resolve(dir, name), 'export default {}')
    manifest.scripts[0].artifact = '../outside.mjs'
    await writeFile(resolve(dir, 'outside.mjs'), 'export default {}')
    await writeFile(path, JSON.stringify(manifest))
    expect(() => read_migrations(dir, path)).toThrow(/路径无效/)
  })

  it('不允许在已有完成版本之前插入迁移', () => {
    const files = ['20261024030000_a.sql', '20261024040000_b.sql'].map(filename => ({ filename, sql: '', checksum: sha256(filename) }))
    expect(plan_migrations(files, new Map([[files[1]!.filename, files[1]!.checksum]])).inconsistent).toContainEqual({ filename: files[0]!.filename, reason: 'out_of_order' })
  })

  it('非法命名的根目录 TS 不会被静默忽略', () => {
    expect(() => migration_script_names(['helper.ts'])).toThrow(/辅助模块/)
    expect(() => migration_script_names(['20261024030000_Example.ts'])).toThrow()
  })
})

describe('migration CLI and contract', () => {
  it('脚本默认维护模式；默认命令保持正常自动迁移', () => {
    expect(define_migration({ plan: async () => ({ summary: 'fixture' }), apply: async () => {}, verify: async () => true }).execution).toBe('maintenance')
    expect(migration_options([])).toEqual({})
    expect(migration_options(['--maintenance', '--through', 'x.sql', '--retry-sql', 'y.sql'])).toEqual({ maintenance: true, through: 'x.sql', retry_sql: 'y.sql' })
    expect(migration_options(['--dry-run'])).toEqual({ dry_run: true })
    expect(migration_options(['--preflight'])).toEqual({ preflight: true })
    for (const args of [['--preflight', '--maintenance'], ['--preflight', '--status'], ['--preflight', '--baseline']])
      expect(() => migration_options(args)).toThrow()
  })

  it('未知参数、缺参和混合读写参数均拒绝', () => {
    for (const args of [['--apply-all'], ['--through'], ['--retry-sql', '--status'], ['--status', '--maintenance'], ['--dry-run', '--retry-sql', 'x.sql']])
      expect(() => migration_options(args)).toThrow()
  })
})
