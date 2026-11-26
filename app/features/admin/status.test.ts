import type { AdminBackgroundStatus } from './status'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { task_backlog, task_cards, useAdminBackgroundStatus } from './status'

function group(values: Partial<AdminBackgroundStatus['database']['ledgers'][number]['groups'][number]>) {
  return { phase: 'queued', error_code: null, total: 0, pending: 0, due: 0, leased: 0, oldest_pending_at: null, ... values }
}

beforeEach(() => vi.stubGlobal('ref', ref))
afterEach(() => vi.unstubAllGlobals())

it('adds up a task\'s groups and keeps the earliest pending time', () => {
  expect(task_backlog([
    group({ pending: 2, due: 1, leased: 1, oldest_pending_at: '2026-11-12T08:00:00.000Z' }),
    group({ phase: 'failed', error_code: 'decode_failed', total: 4 }),
    group({ phase: 'processing', pending: 3, leased: 2, oldest_pending_at: '2026-11-12T07:30:00.000Z' }),
  ])).toEqual({ pending: 5, due: 1, leased: 3, oldest_pending_at: '2026-11-12T07:30:00.000Z' })
  expect(task_backlog([])).toEqual({ pending: 0, due: 0, leased: 0, oldest_pending_at: null })
})

it('lists every known task in a fixed order, without runner state when the process runs none, and keeps unnamed tasks', () => {
  const ledgers = [{ id: 'sync', interval_seconds: 1, groups: [] }, { id: 'future_task', interval_seconds: null, groups: [] }]
  const idle = { id: 'sync', phase: 'idle' } as NonNullable<AdminBackgroundStatus['process']>['adapters'][number]

  const detached = task_cards({ process: null, database: { ledgers } as unknown as AdminBackgroundStatus['database'] })
  expect(detached.map(card => card.task.id)).toEqual(['images', 'uploads', 'retirement', 'preload', 'sync', 'receipts', 'storage_audit', 'future_task'])
  expect(detached.every(card => card.runner === null)).toBe(true)
  expect(detached.find(card => card.task.id === 'sync')!.ledger).toBe(ledgers[0])
  expect(detached.find(card => card.task.id === 'images')!.ledger).toBeNull()
  expect(detached.at(- 1)!.task.name).toBe('future_task')

  const local = task_cards({
    process: { closed: false, resources: {}, adapters: [idle, { ... idle, id: 'runner_only' }] },
    database: { ledgers } as unknown as AdminBackgroundStatus['database'],
  })
  expect(local.find(card => card.task.id === 'sync')!.runner).toBe(idle)
  expect(local.find(card => card.task.id === 'images')!.runner).toBeNull()
  expect(local.at(- 1)).toMatchObject({ task: { name: 'runner_only' }, ledger: null, runner: { id: 'runner_only' } })
})

it('fetches the status in the browser only, unshared, and polls it every few seconds', async () => {
  const admin = { get_background_status: vi.fn(async () => ({ mode: 'app' })) }
  const toast_error = vi.fn()
  const synced = vi.fn(async (... _args: unknown[]) => ({ refresh: async () => {} }))
  vi.stubGlobal('useApi', () => ({ admin }))
  vi.stubGlobal('useMyToast', () => ({ error: toast_error }))
  vi.stubGlobal('useSyncedData', synced)
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { app: { admin: { statusPollIntervalSeconds: 5 } } } }))

  const { status, stale, updated_at, ready } = useAdminBackgroundStatus()
  await ready
  const [resource, fetcher, data, , options] = synced.mock.calls[0]! as [unknown, () => Promise<unknown>, unknown, unknown, { on_data: (v: unknown) => void, on_error: () => void }]
  expect(resource).toBeNull()
  expect(data).toBe(status)
  expect(options).toMatchObject({ server: false, share: false, fetch_without_resource: true, polling_interval: 5000 })
  expect(updated_at.value).toBeNull()
  options.on_error()
  expect(stale.value).toBe(true)
  options.on_error()
  expect(toast_error).toHaveBeenCalledExactlyOnceWith('WTF，运行状态更新失败？！')
  options.on_data(await fetcher())
  expect(stale.value).toBe(false)
  const last_update = updated_at.value
  expect(last_update).toBeInstanceOf(Date)
  options.on_error()
  expect(updated_at.value).toBe(last_update)
  expect(toast_error).toHaveBeenCalledTimes(2)
  expect(admin.get_background_status).toHaveBeenCalledOnce()
})
