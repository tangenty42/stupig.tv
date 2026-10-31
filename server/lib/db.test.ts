import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
  pool: { on: vi.fn() },
  create_pool: vi.fn(),
}))

vi.mock('mysql2/promise', () => ({ default: { createPool: boundary.create_pool } }))

let directory: string

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  boundary.create_pool.mockReturnValue(boundary.pool)
  directory = mkdtempSync(join(tmpdir(), 'stupig-db-config-'))
  mkdirSync(join(directory, 'config'))
  writeFileSync(join(directory, 'config/shared.yaml'), `
db:
  host: \${MYSQL_HOST}
  port: \${MYSQL_PORT}
  user: \${MYSQL_USER}
  password: \${MYSQL_PASSWORD}
  name: \${MYSQL_DATABASE}
aliyun:
  oss:
    accessKeyId: \${UNCONFIGURED_OSS_ACCESS_KEY_ID}
`)
  for (const name of ['dev', 'prod']) {
    writeFileSync(join(directory, `config/${name}.yaml`), '{}')
    writeFileSync(join(directory, `.env.${name}`), 'MYSQL_HOST=db\nMYSQL_PORT=3306\nMYSQL_USER=app\nMYSQL_PASSWORD=test-password\nMYSQL_DATABASE=test-db\n')
  }
  vi.spyOn(process, 'cwd').mockReturnValue(directory)
  // Isolate the real loader from credentials injected into the test runner.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('MYSQL_') || name === 'UNCONFIGURED_OSS_ACCESS_KEY_ID')
      vi.stubEnv(name, undefined)
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

it.each(['development', 'production'])('creates a UTC pool using only database configuration in %s', async (node_env) => {
  vi.stubEnv('NODE_ENV', node_env)
  const { db } = await import('./db')
  expect(db).toBe(boundary.pool)
  expect(boundary.create_pool).toHaveBeenCalledExactlyOnceWith({
    host: 'db', port: 3306, user: 'app', password: 'test-password', database: 'test-db',
    waitForConnections: true, connectionLimit: 10, queueLimit: 0, timezone: 'Z',
  })
  expect(boundary.pool.on).toHaveBeenCalledExactlyOnceWith('connection', expect.any(Function))
  const connection = { query: vi.fn() }
  boundary.pool.on.mock.calls[0]![1](connection)
  expect(connection.query).toHaveBeenCalledExactlyOnceWith('SET time_zone = "+00:00"')
})

it('rejects invalid database configuration before creating a pool', async () => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MYSQL_PORT', 'invalid')
  await expect(import('./db')).rejects.toThrow(/db\.port/)
  expect(boundary.create_pool).not.toHaveBeenCalled()
})
