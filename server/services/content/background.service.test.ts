import { observe_database_wait, observe_upload } from '@server/lib/upload-observation'
import { wake_background } from '@server/services/background/wakeup'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ mode: 'app', real_receipts: false, execute: vi.fn(), images: vi.fn(), uploads: vi.fn(), retirement: vi.fn(), preload: vi.fn(), sync: vi.fn(), receipts: vi.fn(), storage_audit: vi.fn(), log: vi.fn(), info: vi.fn(), dispatch: vi.fn() }))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ app: {
  backgroundRunner: { mode: boundary.mode, shutdownTimeoutMs: 100, resources: { image: 1, oss: 2, esa: 1, notification: 1 } },
  contentImages: { enabled: false, sweepIntervalSeconds: 5 }, contentUploads: { enabled: false, sweepIntervalSeconds: 5 },
  contentRetirement: { sweepIntervalSeconds: 5 }, contentPreload: { enabled: false, sweepIntervalSeconds: 5 }, contentSync: { sweepIntervalSeconds: 1 },
  contentReceipts: { enabled: true, sweepIntervalSeconds: 60, scanLimit: 100 },
  storageAudit: { sweepIntervalSeconds: 30 },
}, aliyun: { oss: null } }) }))
vi.mock('@server/lib/db', () => ({ db: { execute: boundary.execute } }))
vi.mock('@server/lib/mqtt', () => ({ publish_sync_confirmed: boundary.dispatch }))
vi.mock('@server/lib/log', () => ({ log_error: boundary.log, log_info: boundary.info }))
vi.mock('./upload-api.service', () => ({ sweep_content_images: boundary.images, sweep_content_uploads: boundary.uploads }))
vi.mock('./object-retirement.service', () => ({ sweep_object_retirements: boundary.retirement }))
vi.mock('./preload.service', () => ({ sweep_preloads: boundary.preload }))
vi.mock('./sync-outbox.service', () => ({ create_content_sync_dispatcher: () => boundary.sync }))
vi.mock('./command-receipts.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./command-receipts.service')>()
  return { create_content_receipt_compactor: (... args: Parameters<typeof actual.create_content_receipt_compactor>) =>
    boundary.real_receipts ? actual.create_content_receipt_compactor(... args) : boundary.receipts }
})
vi.mock('@server/services/storage-audit/service', () => ({ sweep_storage_audit: boundary.storage_audit }))
const { register_content_background, local_background_status, content_background_adapters } = await import('./background.service')

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  boundary.mode = 'app'
  boundary.real_receipts = false
  boundary.execute.mockReset()
  for (const key of ['images', 'uploads', 'retirement', 'preload', 'sync', 'receipts', 'storage_audit'] as const)
    boundary[key].mockReset().mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

it('detaches background scans from the request identity and connection accounting that woke them', async () => {
  boundary.images.mockImplementation(async () => {
    const acquired = observe_database_wait()
    acquired()
    await observe_upload('image_source_info', async () => {})
  })
  const image = content_background_adapters().find(adapter => adapter.id === 'images')!
  await observe_upload('upload_seal', () => image.sweep(new AbortController().signal), {
    session_id: 'a'.repeat(32), job_id: 'b'.repeat(32), execution_epoch: 4,
  })
  const request = boundary.info.mock.calls.find(([, fields]) => fields.stage === 'upload_seal')![1]
  const background = boundary.info.mock.calls.find(([, fields]) => fields.stage === 'image_source_info')![1]
  expect(request).toMatchObject({ session_id: 'a'.repeat(32), db_acquisitions: 0 })
  expect(background).not.toHaveProperty('session_id')
  expect(background).not.toHaveProperty('job_id')
  expect(background).not.toHaveProperty('execution_epoch')
})

it('runs all seven adapters through one lifecycle, forwards stop signals and continues after scan errors', async () => {
  const host = { hooks: { hook: vi.fn() } }
  boundary.images.mockRejectedValueOnce(new Error('secret'))
  for (const adapter of content_background_adapters())
    register_content_background(host, adapter.id)
  await vi.advanceTimersByTimeAsync(0)
  expect(host.hooks.hook).toHaveBeenCalledOnce()
  for (const key of ['images', 'uploads', 'retirement', 'preload', 'sync', 'receipts', 'storage_audit'] as const)
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
  wake_background('images')
  await vi.advanceTimersByTimeAsync(10000)
  expect(host.hooks.hook).not.toHaveBeenCalled()
  for (const key of ['images', 'uploads', 'retirement', 'preload', 'sync', 'receipts', 'storage_audit'] as const)
    expect(boundary[key]).not.toHaveBeenCalled()
})

it('delivers local image hints through the app runner and removes them on close', async () => {
  const host = { hooks: { hook: vi.fn() } }
  register_content_background(host, 'images')
  await vi.advanceTimersByTimeAsync(0)
  expect(boundary.images).toHaveBeenCalledOnce()
  wake_background('images')
  await vi.advanceTimersByTimeAsync(0)
  expect(boundary.images).toHaveBeenCalledTimes(2)
  await host.hooks.hook.mock.calls[0]![1]()
  wake_background('images')
  await vi.advanceTimersByTimeAsync(5000)
  expect(boundary.images).toHaveBeenCalledTimes(2)
  expect(local_background_status()).toBeNull()
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
  expect(boundary.receipts).toHaveBeenCalledOnce()
  expect(boundary.sync.mock.calls.length).toBeGreaterThan(1)
  const close = host.hooks.hook.mock.calls[0]![1]()
  await vi.advanceTimersByTimeAsync(100)
  await close
  expect(boundary.log).toHaveBeenCalledWith('background execution failed', { adapter: 'retirement', code: 'shutdown_timeout' })
  finish()
  await vi.advanceTimersByTimeAsync(10000)
  expect(boundary.preload).not.toHaveBeenCalled()
})

it('runs receipt compaction without OSS slots, retries failures, and forwards cooperative shutdown', async () => {
  const host = { hooks: { hook: vi.fn() } }
  boundary.uploads.mockImplementation(() => new Promise(() => {}))
  boundary.retirement.mockImplementation(() => new Promise(() => {}))
  boundary.receipts.mockRejectedValueOnce(new Error('database temporarily unavailable'))
  for (const adapter of content_background_adapters())
    register_content_background(host, adapter.id)
  await vi.advanceTimersByTimeAsync(0)
  expect(local_background_status()?.resources.oss?.used).toBe(2)
  expect(boundary.receipts).toHaveBeenCalledOnce()
  expect(boundary.log).toHaveBeenCalledWith('background execution failed', { adapter: 'receipts', code: 'sweep_failed' })
  await vi.advanceTimersByTimeAsync(60000)
  expect(boundary.receipts).toHaveBeenCalledTimes(2)
  const signal = boundary.receipts.mock.calls[1]![0] as AbortSignal
  const stopping = host.hooks.hook.mock.calls[0]![1]()
  expect(signal.aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(100)
  await stopping
  await vi.advanceTimersByTimeAsync(60000)
  expect(boundary.receipts).toHaveBeenCalledTimes(2)
})

it('compacts through the real DB adapter with OSS unconfigured and all cloud consumers disabled', async () => {
  boundary.real_receipts = true
  boundary.execute.mockResolvedValueOnce([[{ actor_id: '7', request_id: 'old', expired: 1 }]])
    .mockResolvedValueOnce([{ affectedRows: 1 }])
  const host = { hooks: { hook: vi.fn() } }
  register_content_background(host, 'receipts')
  await vi.advanceTimersByTimeAsync(0)
  expect(boundary.execute).toHaveBeenCalledTimes(2)
  expect(boundary.execute.mock.calls[0]![1]).toEqual([100])
  expect(boundary.execute.mock.calls[1]![1]).toEqual(['7', 'old'])
  expect(local_background_status()?.adapters).toEqual([expect.objectContaining({ id: 'receipts', runs: 1, failures: 0 })])
  expect(boundary.images).not.toHaveBeenCalled()
  expect(boundary.uploads).not.toHaveBeenCalled()
  await host.hooks.hook.mock.calls[0]![1]()
})
