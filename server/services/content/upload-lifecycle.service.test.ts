import type { Connection, Pool } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { require_adoptable_objects } from './object-adoption.service'
import { create_upload_lifecycle } from './upload-lifecycle.service'

const config = vi.hoisted(() => ({ aliyun: { oss: { bucket: 'dev', endpoint: 'https://oss.example.test' }, esa: { baseUrl: 'https://edge.example.test' }, esaPurge: { siteId: '123' } } }))
vi.mock('@config/loader', () => ({ runtime_config: () => config }))
vi.mock('@server/lib/log', () => ({ log_error: vi.fn() }))
const options = { enabled: true, scanLimit: 2, sweepIntervalSeconds: 5 }

it('does not discover or mutate upload attempts after shutdown and preserves the cleanup cursor', async () => {
  const execute = vi.fn()
  const pool = { execute, getConnection: vi.fn() } as unknown as Pool
  const storage = { abort_multipart_upload: vi.fn(), list_multipart_uploads: vi.fn(), head_object: vi.fn() }
  const lifecycle = create_upload_lifecycle(pool, storage as never, options, vi.fn())
  const controller = new AbortController()
  controller.abort()
  await lifecycle.expire(controller.signal)
  expect(await lifecycle.cleanup('a'.repeat(32), controller.signal)).toBe('a'.repeat(32))
  expect(execute).not.toHaveBeenCalled()
  expect(pool.getConnection).not.toHaveBeenCalled()
})
function fixture(image = false) {
  const session = { id: 'a'.repeat(32), actor_id: 7, scope_id: 1, target_location: 'aliyun', active_attempt_id: 'b'.repeat(32),
    status: 'uploading', expired: true, result: null, intent: {
      scope_id: 1, operation: 'upload', target_location: 'aliyun', target_access: 'public', target_path: 'file.txt', expected_size: 10, sha256: 'd'.repeat(64),
      ... (image ? { image: { mode: 'upload', source: null, original_name: 'photo.png', original_mime: 'image/png' } } : {}),
    } }
  const attempt = { id: 'b'.repeat(32), session_id: session.id, target_key: `content/att/staging/${session.id}/${'b'.repeat(32)}`,
    upload_id: 'known-upload' as string | null, status: 'uploading', cleanup_required: 0 }
  const retirements = new Map<string, { phase: string, reason: string, bucket: string, endpoint: string, lease: boolean }>()
  const notify = vi.fn()
  let pending: string[] = []
  let live = false
  let listed = false
  let before_lock: (() => void) | undefined
  const execute = vi.fn(async (sql: string, args: unknown[] = []): Promise<unknown[]> => {
    if (sql.startsWith('INSERT INTO content_sync_outbox')) {
      pending.push(String(args[1]))
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('SELECT id, scope_id FROM content_transfer_sessions'))
      return [[{ id: session.id, scope_id: 1 }]] // Deliberately stale discovery on repeat scans.
    if (sql.startsWith('SELECT a.id, a.session_id')) {
      listed = true
      return [[{ id: attempt.id, session_id: session.id, scope_id: 1 }]]
    }
    if (sql.startsWith('SELECT id FROM content_stories')) {
      if (listed) {
        before_lock?.()
        before_lock = undefined
      }
      return [[{ id: 1 }]]
    }
    if (sql.startsWith('SELECT * FROM content_transfer_sessions'))
      return [[structuredClone(session)]]
    if (sql.startsWith('UPDATE content_transfer_sessions')) {
      if (! session.expired || ! ['uploading', 'queued', 'running', 'verifying'].includes(session.status))
        return [{ affectedRows: 0 }]
      session.status = 'expired'
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('UPDATE content_transfer_attempts')) {
      if (attempt.status !== 'adopted')
        attempt.cleanup_required = 1
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('SELECT * FROM content_transfer_attempts'))
      return [[structuredClone(attempt)]]
    if (sql.includes('FROM content_story_attachments'))
      return [live ? [{ id: 2 }] : []]
    if (sql.startsWith('INSERT IGNORE INTO content_object_retirements')) {
      const key = String(args[0])
      if (! retirements.has(key))
        retirements.set(key, { phase: 'queued', reason: String(args[2]), bucket: String(args[3]), endpoint: String(args[4]), lease: false })
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('SELECT object_key FROM content_object_retirements')) {
      const item = retirements.get(String(args[0]))
      return [item && (! sql.includes('storage_bucket') || (item.bucket === args[2] && item.endpoint === args[3])) ? [{ object_key: args[0] }] : []]
    }
    if (sql.startsWith('UPDATE content_object_retirements')) {
      const item = retirements.get(String(args[0]))
      if (item?.phase === 'completed' && ! item.lease && item.bucket === args[2] && item.endpoint === args[3])
        item.phase = 'queued'
      return [{ affectedRows: 1 }]
    }
    throw new Error(`Unhandled SQL: ${sql}`)
  })
  let transactions = 0
  const connection = { execute, beginTransaction: vi.fn(async () => {
    transactions ++
  }), commit: vi.fn(async () => {
    transactions --
    pending.forEach(resource => notify(resource))
    pending = []
  }), rollback: vi.fn(async () => {
    transactions --
    pending = []
  }), release: vi.fn() }
  const storage = {
    list_multipart_uploads: vi.fn(async () => {
      expect(transactions).toBe(0)
      return [] as string[]
    }),
    abort_multipart_upload: vi.fn(async () => { expect(transactions).toBe(0) }),
    head_object: vi.fn(async (): Promise<{ size: number, etag: string, version_id: string }> => {
      expect(transactions).toBe(0)
      throw Object.assign(new Error('missing'), { status: 404 })
    }),
  }
  const pool = { execute, getConnection: async () => connection } as unknown as Pool
  const cancel_image = vi.fn()
  const service = () => create_upload_lifecycle(pool, storage, options, cancel_image)
  return { session, attempt, retirements, execute, connection, storage, pool, service, notify, cancel_image,
    set_live: (value: boolean) => {
      live = value
    }, race: (action: () => void) => {
      before_lock = action
    } }
}

it.each([false, true])('expires unsealed uploads and commits notification duties without replaying stale expiry (image=%s)', async (image) => {
  const f = fixture(image)
  await f.service().expire()
  expect(f.session.status).toBe('expired')
  expect(f.attempt.cleanup_required).toBe(1)
  expect(f.retirements.has(f.attempt.target_key)).toBe(true)
  expect(f.notify.mock.calls.flat().sort()).toEqual([`content_upload_session:${f.session.id}`, 'content_uploads:1'])
  expect(f.connection.commit.mock.invocationCallOrder[0]).toBeLessThan(f.notify.mock.invocationCallOrder[0]!)
  expect(f.cancel_image).toHaveBeenCalledOnce()
  expect(f.storage.head_object).not.toHaveBeenCalled()
  f.notify.mockClear()
  await f.service().expire()
  expect(f.notify).not.toHaveBeenCalled()
  expect(f.cancel_image).toHaveBeenCalledOnce()
})

it('rolls back expiry without a success notification if its cancellation hook fails', async () => {
  const f = fixture(true)
  f.cancel_image.mockRejectedValueOnce(new Error('database unavailable'))
  await f.service().expire()
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.commit).not.toHaveBeenCalled()
  expect(f.notify).not.toHaveBeenCalled()
})

it('retains cleanup after 404, discovers lost init replies and re-arms a completed retirement after a late Complete', async () => {
  const f = fixture()
  f.session.status = 'cancelled'
  f.attempt.cleanup_required = 1
  f.attempt.upload_id = null
  await f.service().cleanup()
  const item = f.retirements.get(f.attempt.target_key)!
  expect(item.phase).toBe('queued')
  expect(f.storage.abort_multipart_upload).not.toHaveBeenCalled()
  item.phase = 'completed'
  f.storage.list_multipart_uploads.mockResolvedValue(['lost-init'])
  f.storage.head_object.mockResolvedValueOnce({ size: 10, etag: 'etag', version_id: 'v2' })
  await f.service().cleanup()
  expect(f.storage.abort_multipart_upload).toHaveBeenCalledWith(f.attempt.target_key, 'lost-init')
  expect(item.phase).toBe('queued')
  expect(f.attempt.cleanup_required).toBe(1)
  expect(f.execute.mock.calls.every(([sql]) => ! sql.startsWith('DELETE'))).toBe(true)
  await expect(require_adoptable_objects(f.connection as unknown as Connection, [f.attempt.target_key])).rejects.toMatchObject({ statusCode: 409 })
})

it('retries abort/discovery failures, also aborts the known upload and retains a single retirement across scanners', async () => {
  const f = fixture()
  f.session.status = 'cancelled'
  f.attempt.cleanup_required = 1
  f.storage.list_multipart_uploads.mockRejectedValueOnce(new Error('outage'))
  f.storage.abort_multipart_upload.mockRejectedValueOnce(new Error('outage'))
  await f.service().cleanup()
  await f.service().cleanup()
  expect(f.storage.abort_multipart_upload).toHaveBeenCalledTimes(2)
  expect(f.retirements.size).toBe(1)
  expect(f.attempt.cleanup_required).toBe(1)
})

it.each(['adopted', 'active', 'referenced', 'destination', 'foreign-key', 'foreign-attempt', 'legacy'])(
  'does not touch storage for %s, including changes after candidate discovery', async (mode) => {
    const f = fixture()
    f.attempt.cleanup_required = 1
    f.session.status = 'cancelled'
    f.race(() => {
      if (mode === 'adopted') {
        f.attempt.status = 'adopted'
        f.attempt.cleanup_required = 0
        f.session.status = 'completed'
      }
      if (mode === 'active')
        f.session.status = 'uploading'
      if (mode === 'referenced')
        f.set_live(true)
      if (mode === 'destination')
        f.retirements.set(f.attempt.target_key, { phase: 'queued', reason: 'upload-abandoned-attempt', bucket: 'prod', endpoint: 'https://oss.example.test', lease: false })
      if (mode === 'foreign-key')
        f.attempt.target_key = 'content/att/production-file'
      if (mode === 'foreign-attempt')
        f.attempt.target_key = `content/att/staging/${f.session.id}/${'c'.repeat(32)}`
      if (mode === 'legacy')
        f.session.target_location = 'legacy_public'
    })
    await f.service().cleanup()
    expect(f.storage.head_object).not.toHaveBeenCalled()
    expect(f.storage.list_multipart_uploads).not.toHaveBeenCalled()
    expect(f.storage.abort_multipart_upload).not.toHaveBeenCalled()
  },
)

it('cleans a superseded attempt while preserving a live replacement upload and its image job', async () => {
  const f = fixture()
  f.session.active_attempt_id = 'c'.repeat(32)
  f.attempt.cleanup_required = 1
  await f.service().cleanup()
  expect(f.storage.abort_multipart_upload).toHaveBeenCalledWith(f.attempt.target_key, 'known-upload')
  expect(f.cancel_image).not.toHaveBeenCalled()
  expect(f.session.status).toBe('uploading')
})

it('expires a sealed ordinary file without publishing it and retries failed-attempt cleanup after restart', async () => {
  const f = fixture()
  f.session.status = 'verifying'
  f.attempt.status = 'verified'
  await f.service().expire()
  expect(f.session.status).toBe('expired')
  expect(f.retirements.size).toBe(1)
  f.session.status = 'failed'
  await f.service().cleanup()
  expect(f.storage.abort_multipart_upload).toHaveBeenCalledWith(f.attempt.target_key, 'known-upload')
  await f.service().cleanup()
  expect(f.retirements.size).toBe(1)
})

it('re-arms historical input retirements without permitting adoption or resetting in-flight purge', async () => {
  const f = fixture(true)
  f.session.status = 'expired'
  f.attempt.cleanup_required = 1
  const item = { phase: 'completed', reason: 'image-cancelled-input', bucket: 'dev', endpoint: 'https://oss.example.test', lease: false }
  f.retirements.set(f.attempt.target_key, item)
  f.storage.head_object.mockResolvedValueOnce({ size: 10, etag: 'etag', version_id: 'late' })
  await f.service().cleanup()
  expect(item.phase).toBe('queued')
  await expect(require_adoptable_objects(f.connection as unknown as Connection, [f.attempt.target_key])).rejects.toMatchObject({ statusCode: 409 })
})

it.each(['deleting', 'purging', 'completed'])('does not reset a %s retirement while another worker owns its lease', async (phase) => {
  const f = fixture()
  f.session.status = 'cancelled'
  f.attempt.cleanup_required = 1
  const item = { phase, reason: 'upload-abandoned-attempt', bucket: 'dev', endpoint: 'https://oss.example.test', lease: true }
  f.retirements.set(f.attempt.target_key, item)
  f.storage.head_object.mockResolvedValueOnce({ size: 10, etag: 'etag', version_id: 'v1' })
  await f.service().cleanup()
  expect(item.phase).toBe(phase)
})
