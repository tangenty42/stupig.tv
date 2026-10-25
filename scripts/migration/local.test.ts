import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const { compile, native } = vi.hoisted(() => ({ compile: vi.fn(async (_dir: string, output: string) => resolve(output, 'manifest.json')), native: vi.fn(async () => {}) }))
vi.mock('./build', () => ({ build_migration_scripts: compile }))
vi.mock('./native', () => ({ package_native_runtime: native }))
const { prepare_migration_scripts } = await import('./local')
const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it.each(['production', 'development'])('prepares %s source migrations with the required native boundary', async (environment) => {
  vi.stubEnv('NODE_ENV', environment)
  const directory = mkdtempSync(join(tmpdir(), 'stupig-migration-entry-'))
  directories.push(directory)
  writeFileSync(join(directory, '20261025180000_fixture.ts'), 'export default {}')
  const output = resolve(directory, environment === 'production' ? '.compiled-runtime/migration-scripts' : '.compiled')
  expect(await prepare_migration_scripts(directory)).toBe(resolve(output, 'manifest.json'))
  expect(compile).toHaveBeenCalledWith(directory, output)
  if (environment === 'production')
    expect(native).toHaveBeenCalledWith(resolve(directory, '.compiled-runtime'))
  else
    expect(native).not.toHaveBeenCalled()
})
