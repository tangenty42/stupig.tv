import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { create_background_runner } from './runner'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const options = { shutdownTimeoutMs: 100, resources: { esa: 1, oss: 1, notification: 1 } }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('starts immediately, prevents overlap, retries failures and reports safe metadata', async () => {
  const report = vi.fn()
  const runner = create_background_runner(options, report)
  const waiting = deferred()
  const sweep = vi.fn().mockRejectedValueOnce(new Error('secret URL')).mockImplementation(() => waiting.promise)
  runner.register({ id: 'preload', intervalSeconds: 1, resources: { esa: 1 }, sweep })
  await vi.advanceTimersByTimeAsync(1000)
  expect(sweep).toHaveBeenCalledTimes(2)
  expect(report).toHaveBeenCalledExactlyOnceWith('preload', 'sweep_failed')
  await vi.advanceTimersByTimeAsync(5000)
  expect(sweep).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(runner.snapshot())).not.toContain('secret')
  const close = runner.close()
  waiting.resolve()
  expect(await close).toEqual({ timed_out: [] })
  await vi.advanceTimersByTimeAsync(5000)
  expect(sweep).toHaveBeenCalledTimes(2)
})

it('shares ESA capacity across adapters while unrelated notifications continue', async () => {
  const runner = create_background_runner(options, vi.fn())
  const waiting = deferred()
  const preload = vi.fn(async () => waiting.promise)
  const retirement = vi.fn(async () => {})
  const sync = vi.fn(async () => {})
  runner.register({ id: 'preload', intervalSeconds: 1, resources: { esa: 1 }, sweep: preload })
  runner.register({ id: 'retirement', intervalSeconds: 1, resources: { esa: 1, oss: 1 }, sweep: retirement })
  runner.register({ id: 'sync', intervalSeconds: 1, resources: { notification: 1 }, sweep: sync })
  await vi.advanceTimersByTimeAsync(0)
  expect(preload).toHaveBeenCalledOnce()
  expect(retirement).not.toHaveBeenCalled()
  expect(sync).toHaveBeenCalledOnce()
  expect(runner.snapshot().resources.esa).toEqual({ capacity: 1, used: 1 })
  waiting.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(retirement).toHaveBeenCalledOnce()
  expect(await runner.close()).toEqual({ timed_out: [] })
})

it('does not starve a multi-resource adapter or deadlock resources acquired together', async () => {
  const runner = create_background_runner(options, vi.fn())
  const waiting = deferred()
  const order: string[] = []
  runner.register({ id: 'first', intervalSeconds: 1, resources: { esa: 1 }, sweep: async () => waiting.promise })
  runner.register({ id: 'both', intervalSeconds: 1, resources: { esa: 1, oss: 1 }, sweep: async () => {
    order.push('both')
  } })
  runner.register({ id: 'last', intervalSeconds: 1, resources: { oss: 1 }, sweep: async () => {
    order.push('last')
  } })
  await vi.advanceTimersByTimeAsync(0)
  expect(order).toEqual([])
  waiting.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(order).toEqual(['both', 'last'])
  await runner.close()
})

it('aborts cooperatively, discards queued scans and bounds shutdown without freeing hung slots', async () => {
  const report = vi.fn()
  const runner = create_background_runner(options, report)
  const waiting = deferred()
  const active = vi.fn(async (_signal: AbortSignal) => waiting.promise)
  const queued = vi.fn(async () => {})
  runner.register({ id: 'active', intervalSeconds: 1, resources: { esa: 1 }, sweep: active })
  runner.register({ id: 'queued', intervalSeconds: 1, resources: { esa: 1 }, sweep: queued })
  await vi.advanceTimersByTimeAsync(0)
  const close = runner.close()
  expect(runner.close()).toBe(close)
  expect(active.mock.calls[0]![0].aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(100)
  expect(await close).toEqual({ timed_out: ['active'] })
  expect(report).toHaveBeenCalledExactlyOnceWith('active', 'shutdown_timeout')
  expect(runner.snapshot().resources.esa!.used).toBe(1)
  waiting.resolve()
  await vi.advanceTimersByTimeAsync(1000)
  expect(runner.snapshot().resources.esa!.used).toBe(0)
  expect(queued).not.toHaveBeenCalled()
  expect(active).toHaveBeenCalledOnce()
})

it('rejects impossible or duplicate registrations before starting another timer', async () => {
  const runner = create_background_runner(options, vi.fn())
  const adapter = { id: 'valid', intervalSeconds: 1, resources: { esa: 1 }, sweep: vi.fn(async () => {}) }
  runner.register(adapter)
  expect(() => runner.register(adapter)).toThrow()
  expect(() => runner.register({ ... adapter, id: 'oversized', resources: { esa: 2 } })).toThrow()
  expect(() => runner.register({ ... adapter, id: 'unknown', resources: { missing: 1 } })).toThrow()
  expect(() => runner.register({ ... adapter, id: 'zero', intervalSeconds: 0 })).toThrow()
  await runner.close()
  expect(adapter.sweep).not.toHaveBeenCalled()
  expect(() => runner.register({ ... adapter, id: 'closed' })).toThrow()
})
