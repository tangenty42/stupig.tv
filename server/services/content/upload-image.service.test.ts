import type { runtime_config } from '@config/loader'
import type { create_aliyun_oss } from '@server/lib/aliyun-oss'
import type { Connection, Pool } from 'mysql2/promise'
import type { UploadRow } from './upload-session.repository'
import type { create_upload_sessions } from './upload-session.service'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { create_upload_images } from './upload-image.service'

vi.mock('@server/lib/db', () => ({ db: {} }))
const options: ReturnType<typeof runtime_config>['app']['contentImages'] = {
  enabled: true, leaseSeconds: 60, heartbeatSeconds: 10, concurrency: 1, scanLimit: 10, sweepIntervalSeconds: 5, profileVersion: 1,
  profile: { maxInputBytes: 1000, maxPixels: 1000, avifQuality: 60, avifEffort: 0, jpegQuality: 85, jpegBackground: '#ffffff', lqipMaxDimension: 24, lqipQuality: 40, timeoutSeconds: 10 },
}
const storage = {} as ReturnType<typeof create_aliyun_oss>

it('stops claiming more images after the active publication reaches its checkpoint', async () => {
  const controller = new AbortController()
  const execute = vi.fn().mockResolvedValue([[{ id: 'one', actor_id: 7, image_status: 'ready' }, { id: 'two', actor_id: 7, image_status: 'ready' }]])
  const pool = { execute, getConnection: vi.fn() } as unknown as Pool
  const uploads = { adopt: vi.fn(async (_session: string) => {
    controller.abort()
  }) }
  const images = create_upload_images(pool, storage, options)
  await images.sweep(uploads as unknown as ReturnType<typeof create_upload_sessions>, controller.signal)
  expect(uploads.adopt).toHaveBeenCalledOnce()
  expect(uploads.adopt.mock.calls[0]![0]).toBe('one')
  expect(pool.getConnection).not.toHaveBeenCalled()
})

it('refreshes only execution budgets on explicit failed-image retry and preserves the admitted encoding intent', async () => {
  const job_id = 'b'.repeat(32)
  const intent = {
    scope_id: 1, actor_id: 7, mode: 'upload', is_private: false, source: null,
    original_name: 'photo.jpg', original_mime: 'image/jpeg', profile_version: 1,
    input: { key: 'content/att/staging/a/b', etag: 'etag', version_id: 'version', size: 50, sha256: 'a'.repeat(64) },
    profile: { ... options.profile, maxPixels: 10, maxInputBytes: 100, timeoutSeconds: 5, avifQuality: 45 },
  }
  const execute = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes('FROM content_stories'))
      return [[{ id: 1 }]]
    if (sql.includes('FROM users'))
      return [[{ id: 7, is_admin: 1, is_banned: 0 }]]
    if (sql.includes('FROM content_image_jobs'))
      return [[{ id: job_id, intent, status: 'failed', fingerprint: 'original-request' }]]
    return [{ affectedRows: 1 }]
  })
  const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }
  const pool = { execute: vi.fn().mockResolvedValue([[{ id: job_id, status: 'failed' }]]), getConnection: vi.fn().mockResolvedValue(connection) }
  const pipeline = create_upload_images(pool as unknown as Pool, storage, options)
  await pipeline.retry('a'.repeat(32), 7)
  const update = execute.mock.calls.find(([sql]) => sql.includes('UPDATE content_image_jobs'))!
  expect(update[0]).toContain('intent = CAST(? AS JSON)')
  expect(update[0]).toContain('result = NULL')
  expect(update[0]).not.toContain('fingerprint =')
  expect(JSON.parse(update[1]![0] as string)).toEqual({ ... intent, profile: { ... intent.profile,
    maxPixels: options.profile.maxPixels, maxInputBytes: options.profile.maxInputBytes, timeoutSeconds: options.profile.timeoutSeconds } })
  expect(connection.commit).toHaveBeenCalledOnce()
  expect(connection.release).toHaveBeenCalledOnce()
  execute.mockClear()
  pool.execute.mockResolvedValue([[{ id: job_id, status: 'processing' }]])
  await pipeline.retry('a'.repeat(32), 7)
  expect(execute).not.toHaveBeenCalled()
})

it('commits one versioned processing intent on the caller connection before linking its upload', async () => {
  let job: object | null = null
  const execute = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('FROM content_stories'))
      return [[{ id: 1 }]]
    if (sql.includes('FROM users'))
      return [[{ id: 7, is_admin: 1, is_banned: 0 }]]
    if (sql.includes('INSERT IGNORE INTO content_image_jobs'))
      job = { id: values[0], status: 'queued', fingerprint: values[4] }
    if (sql.includes('FROM content_image_jobs'))
      return [job ? [job] : []]
    return [{ affectedRows: 1 }]
  })
  const pool = { getConnection: vi.fn() } as unknown as Pool
  const pipeline = create_upload_images(pool, storage, options)
  const row = { id: randomUUID().replaceAll('-', ''), scope_id: 1, actor_id: 7,
    intent: { target_access: 'public', image: { mode: 'upload', source: null, original_name: 'a.png', original_mime: 'image/png' } },
    result: { key: 'content/att/staging/a/b', etag: 'etag', oss_version_id: 'version', size: 100, sha256: 'a'.repeat(64) } } as UploadRow
  await pipeline.sealed({ execute } as unknown as Connection, row)
  const insert = execute.mock.calls.find(([sql]) => sql.includes('INSERT IGNORE INTO content_image_jobs'))!
  expect(JSON.parse(insert[1]![5] as string)).toMatchObject({ profile_version: 1, mode: 'upload', input: { version_id: 'version' }, profile: options.profile })
  expect(execute.mock.calls.at(- 1)).toEqual(['INSERT IGNORE INTO content_upload_images (session_id, job_id) VALUES (?, ?)', [row.id, expect.any(String)]])
  expect(pool.getConnection).not.toHaveBeenCalled()
  await pipeline.sealed({ execute } as unknown as Connection, row)
  expect(execute.mock.calls.filter(([sql]) => sql.includes('INSERT IGNORE INTO content_image_jobs'))).toHaveLength(1)
  await expect(create_upload_images(pool, storage, { ... options, enabled: false }).sealed({ execute } as unknown as Connection, row)).rejects.toMatchObject({ statusCode: 503 })
})

it('recovers ready jobs without processing them again and fences stale scan errors by epoch', async () => {
  const item = { id: 'a'.repeat(32), job_id: 'b'.repeat(32), actor_id: 7, scope_id: 1, image_status: 'ready', image_epoch: 4, expired: 0 }
  const execute = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.startsWith('UPDATE') || sql.startsWith('INSERT'))
      return [{ affectedRows: 1 }]
    if (sql.startsWith('SELECT session_id'))
      return [[{ session_id: item.id }]]
    return [[item]]
  })
  const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }
  const pipeline = create_upload_images({ execute, getConnection: async () => connection } as unknown as Pool, storage, options)
  const adopt = vi.fn().mockResolvedValue({ attachment_id: 2, refresh: { attachments: true } })
  await pipeline.sweep({ adopt } as unknown as ReturnType<typeof create_upload_sessions>)
  expect(adopt).toHaveBeenCalledWith(item.id, 7, pipeline.publish)
  // Adoption owns its atomic outbox (covered through the real upload API).
  expect(connection.commit).not.toHaveBeenCalled()
  adopt.mockRejectedValue(new Error('source changed'))
  await pipeline.sweep({ adopt } as unknown as ReturnType<typeof create_upload_sessions>)
  const failed = execute.mock.calls.find(([sql]) => String(sql).includes('image_publish_failed'))!
  expect(failed[0]).toContain('execution_epoch = ?')
  expect(failed[1]).toEqual([item.job_id, 4])
  const events = execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO content_sync_outbox'))
  expect(events.map(([, args]) => args![1]).sort()).toEqual([`content_upload_session:${item.id}`, 'content_uploads:1'])
  expect(connection.commit).toHaveBeenCalledOnce()
})

it('does not scan when disabled or publish an image before both outputs are ready', async () => {
  const execute = vi.fn().mockResolvedValue([[{ status: 'processing' }]])
  const pool = { execute, getConnection: vi.fn() } as unknown as Pool
  const pipeline = create_upload_images(pool, storage, { ... options, enabled: false })
  await pipeline.sweep({} as ReturnType<typeof create_upload_sessions>)
  expect(execute).not.toHaveBeenCalled()
  await expect(pipeline.publish({ execute } as unknown as Connection, { intent: { image: {} } } as UploadRow)).rejects.toMatchObject({ statusCode: 409 })
})

// Session expiry and input reconciliation now exercise the shared lifecycle
// entry points in upload-lifecycle.service.test.ts, for files and images alike.
it('invalidates an image worker on cancellation without resetting completed or already cancelled jobs', async () => {
  const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }])
  const pipeline = create_upload_images({} as Pool, storage, { ... options, enabled: false })
  await pipeline.cancel({ execute } as unknown as Connection, { id: 'a'.repeat(32), actor_id: 7, intent: { image: {} } } as UploadRow)
  expect(execute).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('j.status NOT IN (\'completed\', \'cancelled\')'), ['a'.repeat(32), 7])
  execute.mockClear()
  await pipeline.cancel({ execute } as unknown as Connection, { intent: {} } as UploadRow)
  expect(execute).not.toHaveBeenCalled()
})

it.each([false, true])('does not create another event for a stale scanner or an already recorded failure (failed=%s)', async (failed) => {
  const item = { id: 'a'.repeat(32), job_id: 'b'.repeat(32), actor_id: 7, scope_id: 1, image_status: 'processing', image_epoch: 4 }
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes('ORDER BY expires_at'))
      return [[]]
    if (sql.startsWith('UPDATE'))
      return [{ affectedRows: 0 }]
    if (sql.startsWith('SELECT status, execution_epoch'))
      return [[{ status: failed ? 'failed' : 'processing', execution_epoch: failed ? 5 : 4 }]]
    return [[item]]
  })
  // The real processor fails before claiming (no matching job); the boundary
  // snapshot covers a failure committed by another worker versus no change.
  const connection = { execute: vi.fn(async (sql: string) => sql.startsWith('UPDATE') ? [{ affectedRows: 0 }] : [[]]), beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }
  const pipeline = create_upload_images({ execute, getConnection: async () => connection } as unknown as Pool, storage, options)
  await pipeline.sweep({ adopt: vi.fn() } as unknown as ReturnType<typeof create_upload_sessions>)
  expect(connection.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false)
  expect(connection.commit).toHaveBeenCalledOnce()
})
