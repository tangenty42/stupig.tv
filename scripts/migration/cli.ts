import type { MigrationOptions } from './runner'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { initialize_cli_environment } from '../../config/lib/environment.mjs'
import { MigrationFailure, run_migrations } from './runner'

export function migration_options(args: string[]): MigrationOptions {
  const options: MigrationOptions = {}
  for (let index = 0; index < args.length; index ++) {
    const arg = args[index]
    if (arg === '--status') {
      options.check_only = true
    }
    else if (arg === '--dry-run') {
      options.dry_run = true
    }
    else if (arg === '--baseline') {
      options.baseline = true
    }
    else if (arg === '--maintenance') {
      options.maintenance = true
    }
    else if (arg === '--through' || arg === '--retry-sql') {
      const value = args[++ index]
      if (! value || value.startsWith('--'))
        throw new MigrationFailure('invalid_options', `${arg} 缺少迁移文件名`)
      if (arg === '--through')
        options.through = value
      else options.retry_sql = value
    }
    else {
      throw new MigrationFailure('invalid_options', '未知迁移参数')
    }
  }
  if ((options.check_only || options.dry_run) && (options.maintenance || options.retry_sql))
    throw new MigrationFailure('invalid_options', '只读模式不能与执行参数组合')
  return options
}

export async function migration_cli(options: MigrationOptions, manifest?: string) {
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    return await run_migrations({ ... options, manifest, signal: controller.signal })
  }
  finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

export function report_migration_error(error: unknown) {
  if (error instanceof MigrationFailure)
    console.error(`${error.code}: ${error.message}`)
  else
    console.error(`migration_failed: ${['ECONNREFUSED', 'ETIMEDOUT', 'ER_ACCESS_DENIED_ERROR'].includes(String((error as { code?: unknown })?.code)) ? (error as { code: string }).code : '请检查配置、数据库连接和迁移产物'}`)
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void Promise.resolve().then(() => {
    initialize_cli_environment()
    return migration_cli(migration_options(process.argv.slice(2)), resolve(import.meta.dirname, 'migration-scripts/manifest.json'))
  }).catch(report_migration_error)
}
