import { expect, it, vi } from 'vitest'

vi.mock('@config/loader', () => ({ load_database_config: vi.fn() }))
vi.mock('./local', () => ({ run_migrations: vi.fn() }))
const { prepare_dev_database } = await import('./dev-bootstrap')

function database(tables: number) {
  return { query: vi.fn(async () => [[{ n: tables }]]), end: vi.fn(async () => {}) }
}

it('applies every migration, including maintenance steps, to an empty database', async () => {
  const migrate = vi.fn(async () => ({ pending: [] }))
  const log = vi.fn()
  expect(await prepare_dev_database({ connect: async () => database(0), migrate, log })).toBe('migrated')
  expect(migrate).toHaveBeenCalledExactlyOnceWith({ maintenance: true })
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Empty development database'))
})

it.each([
  [[], 'current'],
  [[{ filename: 'x.sql' }], 'pending'],
] as const)('only checks a database that already has tables (pending: %j)', async (pending, result) => {
  const migrate = vi.fn(async () => ({ pending: [... pending] }))
  const log = vi.fn()
  expect(await prepare_dev_database({ connect: async () => database(3), migrate, log })).toBe(result)
  expect(migrate).toHaveBeenCalledExactlyOnceWith({ check_only: true })
  expect(log).toHaveBeenCalledTimes(pending.length)
})

it('waits for the database to accept connections and gives up after the attempt limit', async () => {
  const refused = () => Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
  const sleep = vi.fn(async () => {})
  const connect = vi.fn()
    .mockRejectedValueOnce(refused())
    .mockResolvedValueOnce(database(0))
  const migrate = vi.fn(async () => ({ pending: [] }))
  expect(await prepare_dev_database({ connect, migrate, sleep, log: vi.fn() }, { attempts: 3, interval_ms: 5 })).toBe('migrated')
  expect(sleep).toHaveBeenCalledExactlyOnceWith(5)

  const down = vi.fn(async () => {
    throw refused()
  })
  await expect(prepare_dev_database({ connect: down, migrate, sleep, log: vi.fn() }, { attempts: 2, interval_ms: 5 }))
    .rejects
    .toThrow('Development database is not reachable')
  expect(down).toHaveBeenCalledTimes(2)
})

it('fails at once on configuration or credential errors instead of waiting', async () => {
  const sleep = vi.fn(async () => {})
  const connect = vi.fn(async () => {
    throw Object.assign(new Error('Access denied'), { code: 'ER_ACCESS_DENIED_ERROR' })
  })
  await expect(prepare_dev_database({ connect, migrate: vi.fn(), sleep, log: vi.fn() })).rejects.toThrow('Access denied')
  expect(connect).toHaveBeenCalledOnce()
  expect(sleep).not.toHaveBeenCalled()
})

it('closes a connection that fails the readiness query before retrying', async () => {
  const stale = database(0)
  stale.query.mockRejectedValueOnce(Object.assign(new Error('lost connection'), { code: 'ECONNRESET' }))
  const ready = database(0)
  const connect = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(ready)
  const migrate = vi.fn(async () => ({ pending: [] }))
  await prepare_dev_database({ connect, migrate, sleep: vi.fn(async () => {}), log: vi.fn() })
  expect(stale.end).toHaveBeenCalledOnce()
  expect(ready.end).toHaveBeenCalledOnce()
})
