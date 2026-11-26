import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup_browser_fixture } from './browser'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stupig-e2e-cleanup-'))
  await writeFile(join(directory, 'runtime.json'), '{}')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('cleans the remaining fixture resources and preserves setup and teardown failures', async () => {
  const setup_error = new Error('fixture setup failed')
  const broker_error = new Error('broker unavailable')
  const app_error = new Error('process tree unavailable')
  const database_error = new Error('database unavailable')
  const database = `stupig_e2e_${'a'.repeat(32)}`
  const admin = { query: vi.fn().mockRejectedValue(database_error), end: vi.fn() }
  const stop_application = vi.fn().mockRejectedValue(app_error)
  const cleanup = cleanup_browser_fixture({
    directory, database, admin, stop_application, logs: ['application output'],
    stop_broker: vi.fn().mockRejectedValue(broker_error),
  }, setup_error)
  await expect(cleanup).rejects.toMatchObject({ errors: [setup_error, broker_error, app_error, database_error] })
  expect(stop_application).toHaveBeenCalledOnce()
  await expect(readFile(join(directory, 'server.log'), 'utf8')).resolves.toBe('application output')
  await expect(readFile(join(directory, 'runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(admin.query).toHaveBeenCalledExactlyOnceWith(`DROP DATABASE \`${database}\``)
  expect(admin.end).toHaveBeenCalledOnce()
})

it('closes the admin connection even when the database name is unsafe', async () => {
  const admin = { query: vi.fn(), end: vi.fn() }
  await expect(cleanup_browser_fixture({ directory, database: 'business', admin, logs: [] })).rejects.toThrow('Unsafe E2E cleanup identity')
  expect(admin.query).not.toHaveBeenCalled()
  expect(admin.end).toHaveBeenCalledOnce()
})
