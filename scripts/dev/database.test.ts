import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('loads the environment preload in the database child process', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'stupig-dev-db-'))
  const env_file = join(cwd, '.env.dev')
  try {
    // Stop inside the preload with a known error before any database access.
    writeFileSync(env_file, 'NODE_ENV=production\n')
    const launcher = new URL('./database.ts', import.meta.url).href
    const result = spawnSync(process.execPath, [
      '--import', import.meta.resolve('tsx'),
      '--input-type=module',
      '-e', `
        import { prepare_dev_database_process } from ${JSON.stringify(launcher)}
        await prepare_dev_database_process(process.env).catch(() => { process.exitCode = 1 })
      `,
    ], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      timeout: 10_000,
      windowsHide: true,
    })
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('NODE_ENV in .env.dev must be development')
  }
  finally {
    rmSync(env_file, { force: true })
    rmdirSync(cwd)
  }
})
