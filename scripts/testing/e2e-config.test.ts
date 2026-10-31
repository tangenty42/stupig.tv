import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { load_database_config } from '../../tests/support/e2e-config'

const database = { host: '127.0.0.1', port: 3306, user: 'root', password: 'fixture-password', name: `stupig_e2e_${'b'.repeat(32)}` }
let directory: string

beforeEach(() => {
  mkdirSync(resolve('.dev'), { recursive: true })
  directory = mkdtempSync(resolve('.dev/e2e-config-test-'))
  const runtime_path = resolve(directory, 'runtime.json')
  writeFileSync(runtime_path, JSON.stringify({ db: database }))
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('STUPIG_E2E_RUNTIME', runtime_path)
  vi.stubEnv('MYSQL_DATABASE', 'unrelated-default-database')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

it('bundles the real DB entry with the E2E loader and uses only the isolated runtime target', async () => {
  const outfile = resolve(directory, 'db.mjs')
  await build({
    entryPoints: [resolve('server/lib/db.ts')],
    outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    alias: { '@config/loader': resolve('tests/support/e2e-config.ts') },
    plugins: [{
      name: 'mysql-boundary',
      setup(plugin) {
        plugin.onResolve({ filter: /^mysql2\/promise$/ }, () => ({ path: 'mysql', namespace: 'fixture' }))
        plugin.onLoad({ filter: /^mysql$/, namespace: 'fixture' }, () => ({ contents: 'export default { createPool(options) { return { options, on() {} } } }', loader: 'js' }))
      },
    }],
  })
  const { db } = await import(pathToFileURL(outfile).href)
  const { name, ... connection } = database
  expect(db.options).toMatchObject({ ... connection, database: name, timezone: 'Z' })
})

it.each([
  ['name', 'business-database'],
  ['host', 'remote.example.test'],
  ['port', 0],
] as const)('rejects an E2E target outside the isolated local boundary: %s', (field, value) => {
  writeFileSync(resolve(directory, 'runtime.json'), JSON.stringify({ db: { ... database, [field]: value } }))
  expect(() => load_database_config()).toThrow(/E2E database/)
})

it.each(['production', 'test'])('rejects the E2E loader outside development: %s', (node_env) => {
  vi.stubEnv('NODE_ENV', node_env)
  expect(() => load_database_config()).toThrow(/isolated development runner/)
})

it('requires an explicit isolated runtime file', () => {
  vi.stubEnv('STUPIG_E2E_RUNTIME', undefined)
  expect(() => load_database_config()).toThrow(/isolated development runner/)
})
