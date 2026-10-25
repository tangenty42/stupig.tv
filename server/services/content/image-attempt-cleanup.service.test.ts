import type { Connection, Pool } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { create_image_attempt_cleanup } from './image-attempt-cleanup.service'
import { image_original_key } from './image-original-object'
import { require_adoptable_objects } from './object-adoption.service'

vi.mock('@config/loader', () => ({ runtime_config: () => ({ aliyun: {
  oss: { bucket: 'dev', endpoint: 'https://oss.example.test' }, esa: { baseUrl: 'https://edge.example.test' }, esaPurge: { siteId: '123' },
} }) }))

function fixture() {
  const job = { id: 'a'.repeat(32), scope_id: 1, status: 'failed', active_attempt_id: 'b'.repeat(32) as string | null }
  const attempt = { id: 'b'.repeat(32), job_id: job.id, cleanup_required: 1, adopted: 0,
    avif_key: `content/att/images/${job.id}/${'b'.repeat(32)}.avif`, jpeg_key: `content/att/images/${job.id}/${'b'.repeat(32)}.jpg` }
  const keys = [attempt.avif_key, attempt.jpeg_key, image_original_key(job.id, attempt.id)]
  const live = new Set<string>()
  const objects = new Set<string>()
  interface Retirement { phase: string, scope: number, bucket: string, endpoint: string, site: string, base: string, lease: boolean }
  const retirements = new Map<string, Retirement>()
  let snapshot = structuredClone(retirements)
  let depth = 0
  let before_lock: (() => void) | undefined
  const execute = vi.fn(async (sql: string, args: unknown[] = []): Promise<unknown[]> => {
    if (sql.includes('FROM content_image_attempts a'))
      return [[{ id: attempt.id, job_id: job.id, scope_id: 1 }]] // Stale discovery must be rechecked.
    if (sql.startsWith('SELECT id FROM content_stories')) {
      before_lock?.()
      before_lock = undefined
      return [[{ id: 1 }]]
    }
    if (sql.startsWith('SELECT * FROM content_image_jobs'))
      return [[structuredClone(job)]]
    if (sql.startsWith('SELECT * FROM content_image_attempts'))
      return [[structuredClone(attempt)]]
    if (sql.includes('FROM content_story_attachments'))
      return [live.has(String(args[0])) ? [{ id: 2 }] : []]
    if (sql.startsWith('INSERT IGNORE INTO content_object_retirements')) {
      if (! retirements.has(String(args[0]))) {
        retirements.set(String(args[0]), { phase: 'queued', scope: Number(args[1]), bucket: String(args[3]), endpoint: String(args[4]),
          site: String(args[5]), base: String(args[6]), lease: false })
      }
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('SELECT object_key FROM content_object_retirements')) {
      const row = retirements.get(String(args[0]))
      return [row && (! sql.includes('storage_bucket') || (row.scope === args[1] && row.bucket === args[2] && row.endpoint === args[3])) ? [{ object_key: args[0] }] : []]
    }
    if (sql.startsWith('UPDATE content_object_retirements')) {
      const row = retirements.get(String(args[0]))
      if (row?.phase === 'completed' && ! row.lease && row.scope === args[1] && row.bucket === args[2] && row.endpoint === args[3] && row.site === args[4] && row.base === args[5])
        row.phase = 'queued'
      return [{ affectedRows: 1 }]
    }
    throw new Error(`Unhandled SQL: ${sql}`)
  })
  const connection = { execute, beginTransaction: async () => {
    depth ++
    snapshot = structuredClone(retirements)
  }, commit: vi.fn(async () => { depth -- }), rollback: vi.fn(async () => {
    depth --
    retirements.clear()
    snapshot.forEach((row, key) => retirements.set(key, row))
  }), release: vi.fn() }
  const storage = { head_object: vi.fn(async (key: string) => {
    expect(depth).toBe(0)
    expect(retirements.has(key)).toBe(true)
    if (! objects.has(key))
      throw Object.assign(new Error('missing'), { status: 404 })
    return { size: 1, etag: 'etag', version_id: 'late' }
  }) }
  const pool = { getConnection: async () => connection } as unknown as Pool
  const cleanup = () => create_image_attempt_cleanup(pool, storage)()
  return { job, attempt, keys, live, objects, retirements, execute, connection, storage, pool, cleanup,
    race: (action: () => void) => { before_lock = action } }
}

it('commits all deterministic image roles to shared retirement before storage, preserving facts after 404 and repeated scans', async () => {
  const f = fixture()
  await f.cleanup()
  await f.cleanup()
  expect([... f.retirements.keys()]).toEqual(f.keys)
  expect(f.attempt.cleanup_required).toBe(1)
  expect(f.execute.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(false)
  expect(f.connection.commit.mock.invocationCallOrder[1]).toBeLessThan(f.storage.head_object.mock.invocationCallOrder[0]!)
  await expect(require_adoptable_objects(f.connection as unknown as Connection, f.keys)).rejects.toMatchObject({ statusCode: 409 })
})

it.each(['adopted', 'active', 'ready', 'not-required', 'scope'])(
  'rejects stale %s candidates before recording retirement or touching storage', async (mode) => {
    const f = fixture()
    f.race(() => {
      if (mode === 'adopted')
        f.attempt.adopted = 1
      if (mode === 'active')
        f.job.status = 'processing'
      if (mode === 'ready')
        f.job.status = 'ready'
      if (mode === 'not-required')
        f.attempt.cleanup_required = 0
      if (mode === 'scope')
        f.job.scope_id = 2
    })
    await f.cleanup()
    expect(f.retirements.size).toBe(0)
    expect(f.storage.head_object).not.toHaveBeenCalled()
  },
)

it('preserves adopted roles even if discovered before adoption committed', async () => {
  const f = fixture()
  f.race(() => {
    f.job.status = 'completed'
    f.attempt.adopted = 1
    f.keys.forEach(key => f.live.add(key))
  })
  await f.cleanup()
  expect(f.retirements.size).toBe(0)
  expect(f.storage.head_object).not.toHaveBeenCalled()
})

it('rechecks each formal role and does not retire referenced output or archive objects', async () => {
  const f = fixture()
  f.keys.forEach(key => f.live.add(key))
  expect(await f.cleanup()).toMatchObject({ pending: 3 })
  expect(f.retirements.size).toBe(0)
  expect(f.storage.head_object).not.toHaveBeenCalled()
})

it.each(['cancelled', 'superseded', 'null-active'])('reclaims %s attempts without adopting or changing job state', async (mode) => {
  const f = fixture()
  if (mode === 'cancelled')
    f.job.status = 'cancelled'
  if (mode === 'superseded') {
    f.job.status = 'processing'
    f.job.active_attempt_id = 'c'.repeat(32)
  }
  if (mode === 'null-active') {
    f.job.status = 'queued'
    f.job.active_attempt_id = null
  }
  const before = structuredClone(f.job)
  await f.cleanup()
  expect(f.retirements.size).toBe(3)
  expect(f.job).toEqual(before)
})

it('re-arms completed retirement on late output writes, including original Copy, without dropping adoption tombstones', async () => {
  const f = fixture()
  await f.cleanup()
  f.retirements.forEach(row => row.phase = 'completed')
  await f.cleanup()
  expect([... f.retirements.values()].every(row => row.phase === 'completed')).toBe(true)
  f.keys.forEach(key => f.objects.add(key))
  await f.cleanup()
  expect([... f.retirements.values()].every(row => row.phase === 'queued')).toBe(true)
  expect(f.retirements.size).toBe(3)
  await expect(require_adoptable_objects(f.connection as unknown as Connection, f.keys)).rejects.toMatchObject({ statusCode: 409 })
})

it.each(['deleting', 'purging', 'completed'])('does not steal a %s retirement lease during repeated scans', async (phase) => {
  const f = fixture()
  await f.cleanup()
  f.retirements.forEach((row) => {
    row.phase = phase
    row.lease = true
  })
  f.keys.forEach(key => f.objects.add(key))
  await f.cleanup()
  expect([... f.retirements.values()].every(row => row.phase === phase && row.lease)).toBe(true)
})

it('does not probe storage when a retirement belongs to another destination', async () => {
  const f = fixture()
  await f.cleanup()
  f.retirements.forEach(row => row.bucket = 'prod')
  f.storage.head_object.mockClear()
  await f.cleanup()
  expect(f.storage.head_object).not.toHaveBeenCalled()
})

it('retains committed duties on transient HEAD failures and retries with a fresh reconciler', async () => {
  const f = fixture()
  f.storage.head_object.mockRejectedValueOnce(new Error('temporary'))
  expect(await f.cleanup()).toMatchObject({ pending: 1 })
  await f.cleanup()
  expect(f.retirements.size).toBe(3)
  expect(f.attempt.cleanup_required).toBe(1)
})

it('rolls back the whole role set on retirement insertion failure before calling storage', async () => {
  const f = fixture()
  const execute = f.execute.getMockImplementation()!
  f.execute.mockImplementation(async (sql, args) => {
    if (sql.startsWith('INSERT IGNORE') && args?.[0] === f.keys[1])
      throw new Error('insert failed')
    return execute(sql, args)
  })
  await expect(f.cleanup()).rejects.toThrow('insert failed')
  expect(f.retirements.size).toBe(0)
  expect(f.storage.head_object).not.toHaveBeenCalled()
  expect(f.connection.rollback).toHaveBeenCalledOnce()
})

it('rejects foreign object ownership and malformed cursors without touching storage', async () => {
  const f = fixture()
  f.attempt.avif_key = 'content/att/images/foreign.avif'
  await expect(f.cleanup()).rejects.toMatchObject({ statusCode: 409 })
  expect(f.retirements.size).toBe(0)
  await expect(create_image_attempt_cleanup(f.pool, f.storage)('invalid')).rejects.toMatchObject({ statusCode: 400 })
  expect(f.storage.head_object).not.toHaveBeenCalled()
})
