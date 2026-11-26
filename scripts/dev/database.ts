import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Run the database bootstrap with the same TypeScript paths and env preload as `pnpm migrate:dev`. */
export function prepare_dev_database_process(env: NodeJS.ProcessEnv) {
  const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url))
  const child = spawn(process.execPath, [
    root('node_modules/tsx/dist/cli.mjs'),
    '--tsconfig',
    root('scripts/tsconfig.json'),
    '--import',
    // Node treats a Windows drive letter in an absolute --import path as a URL scheme.
    new URL('../env/preload.mjs', import.meta.url).href,
    root('scripts/migration/dev-bootstrap.ts'),
    '--env=dev',
  ], { stdio: 'inherit', windowsHide: true, env })
  return new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Development database is not ready; see the messages above')))
  })
}
