import type { Connection, Pool } from 'mysql2/promise'
import type { UploadRow } from './upload-session.repository'
import { beforeEach, expect, it, vi } from 'vitest'
import { create_upload_sessions } from './upload-session.service'

const id = 'a'.repeat(32)
const attempt_id = 'b'.repeat(32)
let row: UploadRow
const list = vi.fn()
const authorize = vi.fn()
// Exercise the real service and repositories; only SQL and OSS are boundaries.
const execute = vi.fn(async (sql: string): Promise<unknown[]> => {
  if (sql.startsWith('SELECT intent'))
    return [[{ intent: row.intent }]]
  if (sql.includes('FROM content_transfer_sessions'))
    return [[structuredClone(row)]]
  if (sql.includes('FROM content_transfer_attempts'))
    return [[{ id: attempt_id, upload_id: 'upload', target_key: 'stage', part_size: 262144, cleanup_required: 0 }]]
  if (sql.startsWith('SELECT'))
    return [[]]
  if (sql.startsWith('INSERT INTO content_sync_outbox'))
    return [{ affectedRows: 1 }]
  throw new Error(`Unexpected write: ${sql}`)
})
const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() } as unknown as Connection
const dependencies: Parameters<typeof create_upload_sessions>[0] = {
  pool: { getConnection: async () => connection } as Pick<Pool, 'getConnection'>,
  storage: { list_multipart_parts: list } as unknown as Parameters<typeof create_upload_sessions>[0]['storage'],
  target: { bucket: 'test', region: 'test', endpoint: 'https://test' }, authorize,
  limits: { part_size: 262144, max_size: 1048576, lifetime_seconds: 3600, lease_seconds: 60, heartbeat_seconds: 10, url_ttl_seconds: 60 },
}
const service = create_upload_sessions(dependencies)
beforeEach(() => {
  vi.clearAllMocks()
  list.mockReset()
  authorize.mockReset()
  row = {
    id, actor_id: 1, scope_id: 10, expected_size: 3, status: 'uploading', active_attempt_id: attempt_id,
    remaining_seconds: 100, busy: 0, execution_epoch: 1, revision: 1, result: null,
    intent: { scope_id: 10, operation: 'upload', target_path: 'file.bin', target_location: 'aliyun', target_access: 'public', expected_size: 3, sha256: 'a'.repeat(64), purpose: 'create' },
  } as UploadRow
})

it('authorizes a scope-wide reservation projection without disclosing upload credentials or actor identities', async () => {
  execute.mockResolvedValueOnce([[{ id: 'foreign', target_parent_id: 2, target_path: 'docs/new.txt', source_attachment_id: 3,
    replacement_attachment_id: null, actor_id: 99, intent: { key: 'private-staging-key' }, expected_size: 123 }]])
  expect(await service.reservations(10, 1)).toEqual([{ id: 'foreign', parent_id: 2, path: 'docs/new.txt', source_id: 3, replacement_id: undefined }])
  expect(authorize).toHaveBeenCalledWith(connection, 1, { scope_id: 10, target_access: 'public' })
  const sql = execute.mock.calls[0]![0]
  expect(sql).toContain('status IN (\'queued\', \'running\', \'uploading\', \'verifying\')')
  expect(sql).toContain('expires_at > CURRENT_TIMESTAMP(3)')
  expect(sql).not.toContain('actor_id =')
})

it('does not disclose reservations after authorization is revoked', async () => {
  const error = new Error('permission revoked')
  authorize.mockRejectedValueOnce(error)
  await expect(service.reservations(10, 1)).rejects.toBe(error)
  expect(execute).not.toHaveBeenCalled()
})

it.each(['image/gif', 'image/svg+xml'])('initializes original uploads with %s rather than generic binary content type', async (mime) => {
  Object.assign(row, { status: 'queued', active_attempt_id: null, operation: 'upload' })
  row.intent.mime_type = mime
  row.intent.target_path = 'retained-name.jpg'
  let attempt: Record<string, unknown> | null = null
  const sql = vi.fn(async (query: string, args: unknown[] = []): Promise<unknown[]> => {
    if (query.startsWith('SELECT intent'))
      return [[{ intent: row.intent }]]
    if (query.includes('FROM content_transfer_sessions'))
      return [[structuredClone(row)]]
    if (query.includes('FROM content_transfer_attempts'))
      return [attempt ? [structuredClone(attempt)] : []]
    if (query.startsWith('INSERT INTO content_transfer_attempts')) {
      attempt = { id: args[0], target_key: args[3], part_size: args[4], cleanup_required: 0, upload_id: null, status: 'created' }
    }
    if (query.includes('SET executor_id = ?')) {
      row.status = 'running'
      row.execution_epoch ++
    }
    if (query.includes('SET active_attempt_id = ?'))
      row.active_attempt_id = String(args[0])
    if (query.includes('SET upload_id = ?') && attempt)
      Object.assign(attempt, { upload_id: args[0], status: 'uploading' })
    if (query.includes('SET status = ?, executor_id = NULL'))
      row.status = String(args[0])
    return [{ affectedRows: 1 }]
  })
  const create = vi.fn().mockResolvedValue('upload-id')
  const uploads = create_upload_sessions({ ... dependencies,
    pool: { getConnection: async () => ({ execute: sql, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }) } as unknown as Pool,
    storage: { ... dependencies.storage, create_multipart_upload: create },
  })
  await uploads.initialize(id, 1)
  expect(create).toHaveBeenCalledWith(expect.stringMatching(/^content\/att\/staging\//), mime)
})

it.each(['verifying', 'completed', 'cancelled'])('returns the current %s receipt if another client advanced during ListParts', async (status) => {
  list.mockImplementation(async () => {
    row.status = status
    row.revision = 2
    if (status === 'verifying')
      row.result = { key: 'stage', etag: 'etag', oss_version_id: 'v1', size: 3, sha256: 'a'.repeat(64) }
    return { parts: [], next_marker: null }
  })
  await expect(service.resume(id, 1)).resolves.toMatchObject({ status: status === 'verifying' ? 'ready' : status, revision: 2 })
  expect(execute.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false)
})

it.each(['completed', 'cancelled'])('reconciles NoSuchUpload against a concurrent %s receipt', async (status) => {
  list.mockImplementation(async () => {
    row.status = status
    row.revision = 2
    throw Object.assign(new Error('multipart no longer exists'), { code: 'NoSuchUpload' })
  })
  await expect(service.resume(id, 1)).resolves.toMatchObject({ status, revision: 2 })
})

it('does not reinterpret missing multipart or temporary storage failure as success while still uploading', async () => {
  for (const code of ['NoSuchUpload', 'ServiceUnavailable']) {
    const error = Object.assign(new Error(code), { code })
    list.mockRejectedValueOnce(error)
    await expect(service.resume(id, 1)).rejects.toBe(error)
  }
})

it('rechecks authorization before accepting a concurrent terminal receipt', async () => {
  const denied = Object.assign(new Error('permission revoked'), { statusCode: 403 })
  list.mockImplementation(async () => {
    row.status = 'cancelled'
    authorize.mockRejectedValueOnce(denied)
    throw Object.assign(new Error('multipart no longer exists'), { code: 'NoSuchUpload' })
  })
  await expect(service.resume(id, 1)).rejects.toBe(denied)
})

it('returns the current target path and revision after a concurrent directory move', async () => {
  list.mockImplementation(async () => {
    row.target_path = 'moved/file.bin'
    row.revision = 2
    return { parts: [], next_marker: null }
  })
  await expect(service.resume(id, 1)).resolves.toMatchObject({ path: 'moved/file.bin', revision: 2 })
})

it('commits cancellation and cleanup facts before best-effort OSS abort, and does not replay its hook', async () => {
  let cleanup = false
  const sql = vi.fn(async (query: string): Promise<unknown[]> => {
    if (query.startsWith('SELECT intent'))
      return [[{ intent: row.intent }]]
    if (query.startsWith('SELECT * FROM content_transfer_sessions') || query.includes('TIMESTAMPDIFF'))
      return [[structuredClone(row)]]
    if (query.startsWith('SELECT * FROM content_transfer_attempts'))
      return [[{ id: attempt_id, upload_id: 'upload', target_key: 'stage', part_size: 262144, cleanup_required: 0 }]]
    if (query.startsWith('UPDATE content_transfer_sessions'))
      row.status = 'cancelled'
    else if (query.startsWith('UPDATE content_transfer_attempts'))
      cleanup = true
    else if (query.startsWith('INSERT INTO content_sync_outbox'))
      return [{ affectedRows: 1 }]
    else
      throw new Error(`Unhandled SQL: ${query}`)
    return [{ affectedRows: 1 }]
  })
  const commit = vi.fn()
  const cancel = vi.fn(async () => {
    expect(row.status).toBe('cancelled')
    expect(cleanup).toBe(true)
  })
  const abort = vi.fn(async () => {
    expect(commit).toHaveBeenCalledOnce()
    throw new Error('temporary OSS outage')
  })
  const uploads = create_upload_sessions({ ... dependencies,
    pool: { getConnection: async () => ({ execute: sql, beginTransaction: vi.fn(), commit, rollback: vi.fn(), release: vi.fn() }) } as unknown as Pool,
    storage: { ... dependencies.storage, abort_multipart_upload: abort }, on_cancel: cancel,
  })
  await expect(uploads.cancel(id, 1)).resolves.toMatchObject({ status: 'cancelled' })
  await expect(uploads.cancel(id, 1)).resolves.toMatchObject({ status: 'cancelled' })
  expect(cancel).toHaveBeenCalledOnce()
  expect(abort).toHaveBeenCalledExactlyOnceWith('stage', 'upload')
})
