import type { Pool } from 'mysql2/promise'
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('@config/loader', () => ({ runtime_config: vi.fn() }))
vi.mock('@server/lib/db', () => ({ db: {} }))
const { create_object_retirement } = await import('./object-retirement.service')
const { require_adoptable_objects } = await import('./object-adoption.service')
const options = { enabled: true, sweepIntervalSeconds: 5, scanLimit: 20, leaseSeconds: 300, retrySeconds: 30, maxRetrySeconds: 3600, pollSeconds: 5, taskTimeoutSeconds: 600 }
const destination = { bucket: 'dev', endpoint: 'https://oss.example.test', site: '123', base: 'https://edge.example.test' }

it('finishes the active object checkpoint but does not claim another after shutdown', async () => {
  const f = fixture([row('content/att/one'), row('content/att/two')])
  const controller = new AbortController()
  const original = f.storage.soft_delete_object.getMockImplementation()!
  f.storage.soft_delete_object.mockImplementation(async (key) => {
    const result = await original(key)
    controller.abort()
    return result
  })
  await f.service().sweep(undefined, controller.signal)
  expect(f.rows.map(item => item.phase)).toEqual(['purging', 'queued'])
  expect(f.storage.soft_delete_object).toHaveBeenCalledOnce()
})
function row(key = 'content/att/test') {
  return { object_key: key, scope_id: 1, phase: 'queued', storage_bucket: null as string | null, storage_endpoint: null as string | null,
    esa_site_id: null as string | null, esa_base_url: null as string | null, purge_task_id: null as string | null,
    task_age: 0, attempts: 0, lease_token: null as string | null, lease_until: 0, next: 0, last_error_code: null as string | null }
}
function fixture(initial = [row()]) {
  let now = 0
  const rows = initial
  const live = new Set<string>()
  const pinned = new Set<string>()
  const preloads = new Set<string>()
  const migration_pins = new Set<string>()
  const objects = new Set(initial.map(item => item.object_key))
  const storage = {
    head_object: vi.fn(async (key: string) => {
      if (! objects.has(key))
        throw Object.assign(new Error('absent'), { status: 404 })
      return { size: 1, etag: 'etag', version_id: 'version' }
    }),
    soft_delete_object: vi.fn(async (key: string) => {
      objects.delete(key)
      return { delete_marker_version_id: 'marker' }
    }),
  }
  const esa = { submit: vi.fn(async () => 'task'), status: vi.fn(async (): Promise<'Complete' | 'Refreshing' | 'Failed' | 'Missing'> => 'Refreshing') }
  const execute = vi.fn(async (sql: string, args: unknown[] = []): Promise<unknown[]> => {
    if (sql.includes('table_name=\'content_migration_pins\''))
      return [[{ n: 1 }]]
    if (sql.includes('FROM content_migration_pins'))
      return [migration_pins.has(String(args[0])) ? [{ object_key: args[0] }] : []]
    if (sql.startsWith('SELECT id FROM content_stories'))
      return [[{ id: 1 }]]
    if (sql.includes('FROM content_story_attachments'))
      return [live.has(String(args[0])) ? [{ id: 2 }] : []]
    if (sql.includes('FROM content_image_jobs'))
      return [pinned.has(String(args[0])) ? [{ id: 'job' }] : []]
    if (sql.includes('FROM content_preload_jobs'))
      return [preloads.has(String(args[0])) ? [{ id: 1 }] : []]
    if (sql.startsWith('SELECT')) {
      if (sql.includes('WHERE object_key')) {
        const selected = rows.filter(item => item.object_key === args[0] && (! sql.includes('phase <> \'completed\'') || (item.phase !== 'completed' && item.next <= now && item.lease_until <= now)))
        return [structuredClone(selected)]
      }
      return [structuredClone(rows.filter(item => item.phase !== 'completed' && item.next <= now && item.lease_until <= now).sort((a, b) => a.next - b.next))]
    }
    if (! sql.startsWith('UPDATE content_object_retirements'))
      throw new Error(`Unhandled SQL: ${sql}`)
    const fenced = sql.includes('AND lease_token = ?')
    const item = rows.find(item => item.object_key === (fenced ? args.at(- 2) : args.at(- 1)))!
    if (fenced && (item.lease_token !== args.at(- 1) || item.lease_until <= now))
      return [{ affectedRows: 0 }]
    if (sql.includes('phase = IF')) {
      if (item.phase === 'queued')
        item.phase = 'deleting'
      Object.assign(item, { storage_bucket: args[0], storage_endpoint: args[1], esa_site_id: args[2], esa_base_url: args[3], lease_token: args[4], lease_until: now + Number(args[5]), attempts: item.attempts + 1 })
    }
    else if (sql.includes('SET purge_requested_at')) {
      item.task_age = 0
    }
    else {
      if (sql.includes('phase = \'purging\''))
        item.phase = 'purging'
      if (sql.includes('phase = \'completed\''))
        item.phase = 'completed'
      if (sql.includes('purge_task_id = ?'))
        item.purge_task_id = String(args[0])
      if (sql.includes('purge_task_id = NULL'))
        item.purge_task_id = null
      if (sql.includes('last_error_code = ?'))
        item.last_error_code = args[0] as string | null
      if (sql.includes('last_error_code = NULL'))
        item.last_error_code = null
      if (sql.includes('attempts = 0'))
        item.attempts = 0
      item.next = now + Number(fenced ? args.at(- 3) : args[1])
      if (fenced) {
        item.lease_token = null
        item.lease_until = 0
      }
    }
    return [{ affectedRows: 1 }]
  })
  const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }
  const pool = { execute, getConnection: async () => connection } as unknown as Pool
  const service = () => create_object_retirement(pool, storage, esa, destination, options)
  return { rows, live, pinned, preloads, migration_pins, objects, storage, esa, pool, connection, service, advance: (seconds: number) => {
    now += seconds
    rows.forEach(item => item.task_age += seconds)
  } }
}
beforeEach(() => vi.clearAllMocks())

it('retains migration rollback sources until their explicit pin is released', async () => {
  const f = fixture()
  f.migration_pins.add(f.rows[0]!.object_key)
  await f.service().sweep()
  expect(f.rows[0]!.last_error_code).toBe('migration_source_pinned')
  expect(f.storage.soft_delete_object).not.toHaveBeenCalled()
  f.migration_pins.clear()
  f.advance(options.retrySeconds)
  await f.service().sweep()
  expect(f.storage.soft_delete_object).toHaveBeenCalledOnce()
})

it('waits for an in-flight prefetch before deleting and purging an old object', async () => {
  const f = fixture()
  f.preloads.add(row().object_key)
  await f.service().sweep()
  expect(f.rows[0]!.last_error_code).toBe('preload_in_progress')
  expect(f.storage.soft_delete_object).not.toHaveBeenCalled()
  expect(f.esa.submit).not.toHaveBeenCalled()
  f.preloads.clear()
  f.advance(options.retrySeconds)
  await f.service().sweep()
  expect(f.storage.soft_delete_object).toHaveBeenCalledOnce()
})

it('persists each phase across restarts and retains a completed tombstone after confirmed purge', async () => {
  const f = fixture()
  await f.service().sweep()
  expect(f.rows[0]!.phase).toBe('purging')
  expect(f.esa.submit).not.toHaveBeenCalled()
  await f.service().sweep()
  expect(f.rows[0]!.purge_task_id).toBe('task')
  expect(f.rows[0]!.phase).toBe('purging')
  f.advance(5)
  await f.service().sweep()
  expect(f.rows[0]!.phase).toBe('purging')
  f.esa.status.mockResolvedValue('Complete')
  f.advance(5)
  await f.service().sweep()
  expect(f.rows).toHaveLength(1)
  expect(f.rows[0]!.phase).toBe('completed')
  await expect(require_adoptable_objects(f.connection as never, [f.rows[0]!.object_key])).rejects.toMatchObject({ statusCode: 409 })
})

it('origin 404 skips deletion but preserves the edge purge duty', async () => {
  const f = fixture()
  f.objects.clear()
  await f.service().sweep()
  expect(f.storage.soft_delete_object).not.toHaveBeenCalled()
  expect(f.rows[0]!.phase).toBe('purging')
  await f.service().sweep()
  expect(f.esa.submit).toHaveBeenCalledWith(destination.base, f.rows[0]!.object_key)
})

it('requires origin absence even after a successful delete response', async () => {
  const f = fixture()
  f.storage.soft_delete_object.mockResolvedValue({ delete_marker_version_id: 'marker' })
  await f.service().sweep()
  expect(f.rows[0]).toMatchObject({ phase: 'deleting', last_error_code: 'origin_delete_failed', next: 30 })
  expect(f.esa.submit).not.toHaveBeenCalled()
})

it('protects live roles and active image inputs, and still processes other due objects', async () => {
  const f = fixture([row('content/att/live'), row('content/att/input'), row('content/att/free')])
  f.live.add(f.rows[0]!.object_key)
  f.pinned.add(f.rows[1]!.object_key)
  await f.service().sweep()
  expect(f.rows.map(item => item.phase)).toEqual(['queued', 'queued', 'purging'])
  expect(f.storage.soft_delete_object).toHaveBeenCalledExactlyOnceWith('content/att/free')
})

it('reconciles a lost delete acknowledgement and safely resubmits a lost purge acknowledgement', async () => {
  const f = fixture()
  f.storage.soft_delete_object.mockImplementationOnce(async (key) => {
    f.objects.delete(key)
    throw new Error('lost')
  })
  await f.service().sweep()
  f.advance(30)
  await f.service().sweep()
  expect(f.storage.soft_delete_object).toHaveBeenCalledOnce()
  f.esa.submit.mockRejectedValueOnce(new Error('signed request secret'))
  await f.service().sweep()
  expect(f.rows[0]).toMatchObject({ phase: 'purging', purge_task_id: null, last_error_code: 'esa_request_failed' })
  f.advance(30)
  await f.service().sweep()
  expect(f.esa.submit).toHaveBeenCalledTimes(2)
  expect(f.rows[0]!.purge_task_id).toBe('task')
})

it.each(['Failed', 'Missing', 'Refreshing'] as const)('retries %s tasks without treating them as completed', async (status) => {
  const f = fixture([{ ... row(), phase: 'purging', purge_task_id: 'old', task_age: 601 }])
  f.esa.status.mockResolvedValue(status)
  await f.service().sweep()
  expect(f.rows[0]).toMatchObject({ phase: 'purging', purge_task_id: null, next: 30 })
  f.advance(30)
  await f.service().sweep()
  expect(f.esa.submit).toHaveBeenCalledOnce()
})

it('does not checkpoint a late external response after another worker takes the lease', async () => {
  const f = fixture()
  f.storage.soft_delete_object.mockImplementationOnce(async (key) => {
    f.objects.delete(key)
    f.rows[0]!.lease_token = 'new-worker'
    return { delete_marker_version_id: 'marker' }
  })
  await f.service().sweep()
  expect(f.rows[0]).toMatchObject({ phase: 'deleting', lease_token: 'new-worker' })
  expect(f.esa.submit).not.toHaveBeenCalled()
})

it('refuses changed destinations and unsafe keys without touching either external service', async () => {
  const f = fixture([{ ... row(), storage_bucket: 'production' }, row('outside/key')])
  await f.service().sweep()
  expect(f.rows.map(item => item.last_error_code)).toEqual(['destination_changed', 'invalid_object_key'])
  expect(f.storage.head_object).not.toHaveBeenCalled()
  expect(f.esa.submit).not.toHaveBeenCalled()
})

it('backs failures off and allows expired leases to be reclaimed', async () => {
  const f = fixture([{ ... row(), phase: 'deleting', lease_token: 'lost-worker', lease_until: 300 }])
  await f.service().sweep()
  expect(f.storage.head_object).not.toHaveBeenCalled()
  f.advance(300)
  f.storage.head_object.mockRejectedValue(new Error('outage'))
  await f.service().sweep()
  expect(f.rows[0]!.next).toBe(330)
  f.advance(30)
  await f.service().sweep()
  expect(f.rows[0]!.next).toBe(390)
})
