import type { ScriptMigration } from './contract'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface MigrationFile {
  filename: string
  sql: string
  checksum: string
  artifact?: string
}

export function sharp_package(request: NodeJS.Require) {
  let dir = dirname(request.resolve('sharp'))
  for (;;) {
    const path = resolve(dir, 'package.json')
    if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).name === 'sharp')
      return path
    const parent = dirname(dir)
    if (parent === dir)
      throw new Error('迁移图片运行时包信息缺失')
    dir = parent
  }
}
export interface InconsistentMigration {
  filename: string
  reason: 'modified' | 'missing' | 'out_of_order'
}
export interface MigrationPlan {
  pending: MigrationFile[]
  inconsistent: InconsistentMigration[]
}
export const runtime_migration = '20261024020000_migration_runs.sql'
export const single_ledger_migration = '20261024030000_single_migration_ledger.sql'
// Freeze the historical adoption boundary; future SQL and scripts must actually run.
export const legacy_baseline_through = '20261024010000_content_preload.sql'

export function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

export function migration_script_names(names: string[]) {
  const scripts = names.filter(name => name.endsWith('.ts'))
  if (scripts.some(name => ! /^\d{14}_[a-z\d_]+\.ts$/.test(name)))
    throw new Error('迁移 TS 入口须使用十四位时间戳和小写名称；辅助模块请放入子目录')
  return scripts.sort()
}

export function read_migrations(dir: string, manifest_path?: string): MigrationFile[] {
  if (! existsSync(dir))
    return []
  const names = readdirSync(dir)
  const files: MigrationFile[] = names.filter(name => name.endsWith('.sql')).sort().map((filename) => {
    const sql = readFileSync(resolve(dir, filename), 'utf8')
    return { filename, sql, checksum: sha256(sql) }
  })
  const scripts = migration_script_names(names)
  if (! scripts.length)
    return files
  if (! manifest_path || ! existsSync(manifest_path))
    throw new Error('脚本迁移缺少构建清单，请通过 pnpm migrate 或 maintenance:build 构建')
  const manifest = JSON.parse(readFileSync(manifest_path, 'utf8')) as { version: number, scripts: { filename: string, checksum: string, source_checksum: string, artifact: string }[] }
  if (manifest.version !== 1 || ! Array.isArray(manifest.scripts) || manifest.scripts.length !== scripts.length)
    throw new Error('脚本迁移构建清单不匹配')
  const seen = new Set<string>()
  for (const item of manifest.scripts) {
    if (! scripts.includes(item.filename) || seen.has(item.filename) || item.filename <= runtime_migration)
      throw new Error('脚本迁移名称、顺序或构建清单无效')
    seen.add(item.filename)
    const root = realpathSync(dirname(manifest_path))
    const artifact = realpathSync(resolve(root, item.artifact))
    const artifact_relative = relative(root, artifact)
    if (isAbsolute(artifact_relative) || artifact_relative.startsWith('..') || ! artifact.endsWith('.mjs'))
      throw new Error('脚本迁移产物路径无效')
    if (sha256(readFileSync(artifact)) !== item.checksum || sha256(readFileSync(resolve(dir, item.filename))) !== item.source_checksum)
      throw new Error(`脚本迁移产物或源码校验失败：${item.filename}`)
    files.push({ filename: item.filename, sql: '', checksum: item.checksum, artifact })
  }
  return files.sort((a, b) => a.filename.localeCompare(b.filename))
}

export function plan_migrations(files: MigrationFile[], applied: Map<string, string>): MigrationPlan {
  const by_name = new Map(files.map(file => [file.filename, file]))
  const inconsistent: InconsistentMigration[] = []
  for (const [filename, checksum] of applied) {
    const file = by_name.get(filename)
    if (! file)
      inconsistent.push({ filename, reason: 'missing' })
    else if (file.checksum !== checksum)
      inconsistent.push({ filename, reason: 'modified' })
  }
  const latest = [... applied.keys()].sort().at(- 1)
  const pending = files.filter(file => ! applied.has(file.filename))
  for (const file of pending) {
    // The additive runtime table can be introduced into an existing SQL history.
    if (latest && file.filename < latest && file.filename !== runtime_migration)
      inconsistent.push({ filename: file.filename, reason: 'out_of_order' })
  }
  return { pending, inconsistent: inconsistent.sort((a, b) => a.filename.localeCompare(b.filename)) }
}

export async function load_script(file: MigrationFile): Promise<ScriptMigration> {
  if (! file.artifact || sha256(readFileSync(file.artifact)) !== file.checksum)
    throw new Error('脚本迁移产物校验失败')
  const url = pathToFileURL(file.artifact)
  const native = readFileSync(file.artifact, 'utf8').match(/^\/\/ migration-native-sharp:([a-f\d]{64})\n/)
  if (native) {
    const request = createRequire(url)
    if (sha256(readFileSync(sharp_package(request))) !== native[1])
      throw new Error('迁移图片运行时版本不匹配')
    const root = resolve(dirname(file.artifact), '..')
    const manifest_path = resolve(root, 'native-manifest.json')
    if (existsSync(manifest_path)) {
      const manifest = JSON.parse(readFileSync(manifest_path, 'utf8')) as { sharp: string, files: Record<string, string> }
      if (manifest.sharp !== native[1] || ! Object.keys(manifest.files).length)
        throw new Error('迁移图片运行时清单无效')
      for (const [name, checksum] of Object.entries(manifest.files)) {
        const path = realpathSync(resolve(root, name))
        const inside = relative(realpathSync(root), path)
        if (isAbsolute(inside) || inside.startsWith('..') || ! inside.replaceAll('\\', '/').startsWith('node_modules/') || sha256(readFileSync(path)) !== checksum)
          throw new Error('迁移图片运行时文件校验失败')
      }
    }
    else if (process.env.NODE_ENV === 'production') {
      throw new Error('迁移图片运行时缺少清单')
    }
  }
  url.searchParams.set('checksum', file.checksum)
  const script = (await import(url.href)).default as ScriptMigration
  if (! script || ! ['automatic', 'maintenance'].includes(script.execution) || ['plan', 'apply', 'verify'].some(key => typeof script[key as keyof ScriptMigration] !== 'function'))
    throw new Error(`脚本迁移接口无效：${file.filename}`)
  return script
}
