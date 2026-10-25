import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ mode: 'app', images: vi.fn(), uploads: vi.fn(), retirement: vi.fn(), preload: vi.fn(), sync: vi.fn(), storage_audit: vi.fn(), log: vi.fn(), dispatch: vi.fn() }))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ app: {
  backgroundRunner: { mode: boundary.mode, shutdownTimeoutMs: 100, resources: { image: 1, oss: 2, esa: 1, notification: 1 } },
  contentImages: { enabled: false, sweepIntervalSeconds: 5 }, contentUploads: { enabled: false, sweepIntervalSeconds: 5 },
  contentRetirement: { sweepIntervalSeconds: 5 }, contentPreload: { enabled: false, sweepIntervalSeconds: 5 }, contentSync: { sweepIntervalSeconds: 1 },
  storageAudit: { sweepIntervalSeconds: 30 },
} }) }))
vi.mock('@server/lib/db', () => ({ db: {} }))
vi.mock('@server/lib/mqtt', () => ({ publish_sync_confirmed: boundary.dispatch }))
vi.mock('@server/lib/log', () => ({ log_error: boundary.log }))
vi.mock('./upload-api.service', () => ({ sweep_content_images: boundary.images, sweep_content_uploads: boundary.uploads }))
vi.mock('./object-retirement.service', () => ({ sweep_object_retirements: boundary.retirement }))
vi.mock('./preload.service', () => ({ sweep_preloads: boundary.preload }))
vi.mock('./sync-outbox.service', () => ({ create_content_sync_dispatcher: () => boundary.sync }))
vi.mock('@server/services/storage-audit/service', () => ({ sweep_storage_audit: boundary.storage_audit }))
const { register_content_background, local_background_status, content_background_adapters } = await import('./background.service')

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  boundary.mode = 'app'
  for (const key of ['images', 'uploads', 'retirement', 'preload', 'sync', 'storage_audit'] as const)
    boundary[key].mockReset().mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

it('runs all six adapters through one lifecycle, forwards stop signals and continues after scan errors', async () => {
  const host = { hooks: { hook: vi.fn() } }
  boundary.images.mockRejectedValueOnce(new Error('secret'))
  for (const adapter of content_background_adapters())
    register_content_background(host, adapter.id)
  await vi.advanceTimersByTimeAsync(0)
  expect(host.hooks.hook).toHaveBeenCalledOnce()
  for (const key of ['images', 'uploads', 'retirement', 'preload', 'sync', 'storage_audit'] as const)
    expect(boundary[key]).toHaveBeenCalledOnce()
  expect(boundary.log).toHaveBeenCalledExactlyOnceWith('background execution failed', { adapter: 'images', code: 'sweep_failed' })
  await vi.advanceTimersByTimeAsync(5000)
  expect(boundary.images).toHaveBeenCalledTimes(2)
  expect(local_background_status()?.adapters.find(adapter => adapter.id === 'images')?.failures).toBe(1)
  const signal = boundary.images.mock.calls[1]![0] as AbortSignal
  expect(boundary.retirement.mock.calls[0]![0]).toBeUndefined()
  expect(boundary.retirement.mock.calls[0]![1]).toBeInstanceOf(AbortSignal)
  await host.hooks.hook.mock.calls[0]![1]()
  expect(signal.aborted).toBe(true)
  expect(local_background_status()).toBeNull()
  await vi.advanceTimersByTimeAsync(10000)
  expect(boundary.images).toHaveBeenCalledTimes(2)
})

it.each(['worker', 'disabled'])('starts no app consumer in %s mode', async (mode) => {
  boundary.mode = mode
  const host = { hooks: { hook: vi.fn() } }
  for (const adapter of content_background_adapters())
    register_content_background(host, adapter.id)
  await vi.advanceTimersByTimeAsync(10000)
  expect(host.hooks.hook).not.toHaveBeenCalled()
  for (const key of ['images', 'uploads', 'retirement', 'preload', 'sync', 'storage_audit'] as const)
    expect(boundary[key]).not.toHaveBeenCalled()
})

it('does not let a hanging ESA sweep block notification delivery or app shutdown', async () => {
  const host = { hooks: { hook: vi.fn() } }
  let finish!: () => void
  boundary.retirement.mockImplementation(() => new Promise<void>((resolve) => {
    finish = resolve
  }))
  for (const adapter of content_background_adapters())
    register_content_background(host, adapter.id)
  await vi.advanceTimersByTimeAsync(5000)
  expect(boundary.retirement).toHaveBeenCalledOnce()
  expect(boundary.preload).not.toHaveBeenCalled()
  expect(boundary.sync.mock.calls.length).toBeGreaterThan(1)
  const close = host.hooks.hook.mock.calls[0]![1]()
  await vi.advanceTimersByTimeAsync(100)
  await close
  expect(boundary.log).toHaveBeenCalledWith('background execution failed', { adapter: 'retirement', code: 'shutdown_timeout' })
  finish()
  await vi.advanceTimersByTimeAsync(10000)
  expect(boundary.preload).not.toHaveBeenCalled()
})
