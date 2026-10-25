import type { MigrationOptions } from './runner'
// Local entry builds immutable script artifacts; the container uses migration/cli.ts.
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { initialize_cli_environment } from '../../config/lib/environment.mjs'
import { migration_script_names } from './catalog'
import { migration_cli, migration_options, report_migration_error } from './cli'
import { run_migrations as run } from './runner'

export { plan_migrations, read_migrations } from './catalog'
export type { InconsistentMigration, MigrationFile, MigrationPlan } from './catalog'
export type { MigrationOptions } from './runner'

export async function prepare_migration_scripts(dir = resolve(process.cwd(), 'migrations')) {
  if (! existsSync(dir) || ! migration_script_names(readdirSync(dir)).length)
    return undefined
  const { build_migration_scripts } = await import('./build')
  const production = process.env.NODE_ENV === 'production'
  const runtime = dir === resolve(process.cwd(), 'migrations') ? resolve(process.cwd(), '.nuxt/migration-runtime') : resolve(dir, '.compiled-runtime')
  const output = production ? resolve(runtime, 'migration-scripts') : dir === resolve(process.cwd(), 'migrations') ? resolve(process.cwd(), '.nuxt/migration-scripts') : resolve(dir, '.compiled')
  const manifest = await build_migration_scripts(dir, output)
  if (production) {
    const { package_native_runtime } = await import('./native')
    await package_native_runtime(runtime)
  }
  return manifest
}

export async function run_migrations(options: MigrationOptions = {}) {
  const manifest = options.manifest ?? await prepare_migration_scripts(options.dir)
  return run({ ... options, manifest })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void (async () => {
    initialize_cli_environment()
    const options = migration_options(process.argv.slice(2))
    const manifest = await prepare_migration_scripts(options.dir)
    return migration_cli(options, manifest)
  })().catch(report_migration_error)
}
