import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ mode: 'worker', register: vi.fn(), close: vi.fn(), db: vi.fn(), mqtt: vi.fn(), redis: vi.fn() }))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ app: { backgroundRunner: { mode: state.mode, shutdownTimeoutMs: 100 } } }) }))
vi.mock('@server/services/content/background.service', () => ({
  create_content_background_runner: () => ({ register: state.register, close: state.close }),
  content_background_adapters: () => ['images', 'uploads', 'retirement', 'preload', 'sync', 'receipts', 'storage_audit'].map(id => ({ id })),
}))
vi.mock('@server/lib/db', () => ({ db: { end: state.db } }))
vi.mock('@server/lib/mqtt', () => ({ stop_mqtt_client: state.mqtt }))
vi.mock('@server/lib/redis', () => ({ redis: { disconnect: state.redis } }))
const { run_background_worker } = await import('./worker')
const previous_exit = process.exitCode

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  state.mode = 'worker'
  state.close.mockResolvedValue({ timed_out: [] })
})
afterEach(() => {
  process.exitCode = previous_exit
  vi.useRealTimers()
})

it('registers all adapters and closes existing connections once on repeated stop requests', async () => {
  const before = process.listenerCount('SIGINT')
  const worker = await run_background_worker()
  expect(state.register.mock.calls.map(([adapter]) => adapter.id)).toEqual(['images', 'uploads', 'retirement', 'preload', 'sync', 'receipts', 'storage_audit'])
  expect(process.listenerCount('SIGINT')).toBe(before + 1)
  const first = worker.stop()
  expect(worker.stop()).toBe(first)
  await first
  expect(state.close).toHaveBeenCalledOnce()
  expect(state.db).toHaveBeenCalledOnce()
  expect(state.mqtt).toHaveBeenCalledOnce()
  expect(state.redis).toHaveBeenCalledOnce()
  expect(process.listenerCount('SIGINT')).toBe(before)
  expect(vi.getTimerCount()).toBe(0)
})

it('refuses a second consumer in app mode', async () => {
  state.mode = 'app'
  await expect(run_background_worker()).rejects.toThrow('mode to worker')
  expect(state.register).not.toHaveBeenCalled()
})

it('does not wait indefinitely for a timed-out sweep or close connections underneath it', async () => {
  state.close.mockResolvedValue({ timed_out: ['images'] })
  const worker = await run_background_worker()
  await worker.stop()
  expect(process.exitCode).toBe(1)
  expect(state.db).not.toHaveBeenCalled()
  expect(state.mqtt).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds connection cleanup as part of the same shutdown budget', async () => {
  state.db.mockImplementationOnce(() => new Promise(() => {}))
  const worker = await run_background_worker()
  const stopping = expect(worker.stop()).rejects.toThrow('cleanup timed out')
  await vi.advanceTimersByTimeAsync(100)
  await stopping
  expect(vi.getTimerCount()).toBe(0)
})
