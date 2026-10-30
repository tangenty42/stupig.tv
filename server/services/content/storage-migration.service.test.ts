import type { UploadedPart } from '@server/lib/storage'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  row: {} as Record<string, unknown>, record: null as Record<string, unknown> | null,
  data: new Uint8Array(8 * 1024 ** 2 + 3).fill(37), target: null as Uint8Array | null,
  parts: new Map<number, Uint8Array>(), lock: true, owned: true,
  fail_part: 0, lost_complete: false, corrupt: false, racing: false, lost_commit: false, source_retired: false, shared_source: false,
  get: vi.fn(), upload: vi.fn(), complete: vi.fn(), digest: vi.fn(), connection: vi.fn(), sign: vi.fn(), events: [] as unknown[],
  writes: [] as string[],
}))

vi.mock('@server/lib/db', () => {
  const execute = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM content_story_drafts'))
      return [[]]
    if (sql.includes('GET_LOCK'))
      return [[{ acquired: Number(state.lock) }]]
    if (sql.includes('IS_USED_LOCK'))
      return [[{ owned: Number(state.owned) }]]
    if (sql.includes('RELEASE_LOCK'))
      return [[{ released: 1 }]]
    if (sql.includes('UNION SELECT'))
      return [state.shared_source ? [{ id: 12 }] : []]
    if (sql.startsWith('SELECT') && sql.includes('content_attachment_storage_migrations'))
      return [state.record && (! sql.includes('state = \'adopted\'') || state.record.state === 'adopted') ? [structuredClone(state.record)] : []]
    if (sql.includes('FROM content_stories'))
      return [[{ namespace_revision: 0, markdown: '[](att://file.bin)', cover: '', cover_version: null }]]
    if (sql.startsWith('SELECT') && sql.includes('content_story_attachments')) {
      if (sql.includes('storage_bucket = \'public\'') && state.row.storage_bucket !== 'public')
        return [[]]
      return [[{ ... state.row }]]
    }
    state.writes.push(sql)
    if (sql.startsWith('INSERT INTO content_attachment_storage_migrations')) {
      state.record = { attachment_id: params[0], story_id: params[1], source_key: params[2], source_version: params[3], source_etag: params[4], source_size: params[5], target_key: params[6], part_size: params[7], parts: [], upload_id: null, target_version: null, sha256: null, state: 'copying' }
    }
    if (sql.startsWith('UPDATE content_attachment_storage_migrations SET upload_id'))
      Object.assign(state.record!, { upload_id: params[0], parts: JSON.parse(String(params[1])), target_version: params[2], sha256: params[3], state: params[4] })
    if (sql.startsWith('UPDATE content_story_attachments'))
      Object.assign(state.row, { object_key: params[0], version: params[1], storage_bucket: sql.includes('storage_bucket = \'private\'') ? 'private' : 'public' })
    if (sql.includes('SET state = \'adopted\''))
      state.record!.state = 'adopted'
    if (sql.includes('SET state = \'rolled_back\''))
      state.record!.state = 'rolled_back'
    if (sql.includes('SET state = \'retired\''))
      state.record!.state = 'retired'
    return [{ affectedRows: 1 }]
  }
  return { db: { execute, getConnection: state.connection.mockImplementation(async () => ({
    execute, beginTransaction: async () => {}, rollback: async () => {}, release: () => {},
    commit: async () => {
      if (state.lost_commit)
        throw new Error('acknowledgement lost')
    },
  })) } }
})

vi.mock('@server/lib/storage', () => ({
  storage_bucket_name: (bucket: string) => `${bucket}-bucket`,
  head_object: async (bucket: string) => {
    if (bucket === 'public' && state.source_retired)
      throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } })
    if (bucket === 'private' && ! state.target)
      throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } })
    return { size: bucket === 'public' ? state.data.length : state.target!.length, etag: bucket === 'public' ? 'source-etag' : 'target-etag', content_type: null }
  },
  get_object_range: state.get,
  upload_part: state.upload,
  delete_object: async (bucket: string) => {
    expect(bucket).toBe('public')
    state.source_retired = true
  },
  create_multipart_upload: async () => 'upload-1',
  list_parts: async () => [... state.parts].map(([part_number, bytes]) => ({ part_number, etag: `part-${part_number}`, size: bytes.length })),
  complete_multipart_upload: state.complete,
  object_sha256: state.digest,
  put_object: async (_bucket: string, _key: string, bytes: Uint8Array) => {
    state.target = bytes
    return 'target-etag'
  },
}))
vi.mock('@server/lib/sync', () => ({ publish_refresh: (event: unknown) => state.events.push(event), sync_resource: (type: string, id: number) => `${type}:${id}` }))
const { migrate_content_storage } = await import('./storage-migration.service')

beforeEach(() => {
  vi.clearAllMocks()
  state.row = { id: 11, story_id: 1, file_name: 'file.bin', is_folder: 0, is_private: 0, encryption_key: null, object_key: 'content/att/source', version: 'source-version', file_size: state.data.length, mime_type: 'application/octet-stream', storage_bucket: 'public' }
  Object.assign(state, { record: null, target: null, lock: true, owned: true, fail_part: 0, lost_complete: false, corrupt: false, racing: false, lost_commit: false, source_retired: false, shared_source: false, events: [], writes: [] })
  state.parts.clear()
  state.get.mockImplementation(async (bucket: string, _key: string, start: number, end: number, etag: string) => {
    expect(bucket).toBe('public')
    expect(etag).toBe('source-etag')
    return state.data.slice(start, end + 1)
  })
  state.upload.mockImplementation(async (bucket: string, _key: string, upload_id: string, part_number: number, bytes: Uint8Array) => {
    expect(bucket).toBe('private')
    expect(upload_id).toBe('upload-1')
    if (state.fail_part === part_number)
      throw new Error('interrupted')
    state.parts.set(part_number, bytes)
    return { part_number, etag: `part-${part_number}`, size: bytes.length }
  })
  state.complete.mockImplementation(async (_bucket: string, _key: string, _upload: string, parts: UploadedPart[]) => {
    state.target = Buffer.concat(parts.map(part => state.parts.get(part.part_number)!))
    if (state.lost_complete)
      throw new Error('completion response lost')
    return 'target-etag'
  })
  state.digest.mockImplementation(async (bucket: string) => {
    if (state.racing)
      state.row.version = 'concurrent-version'
    const bytes = bucket === 'public' ? state.data : state.target!
    return { size: bytes.length, sha256: state.corrupt ? 'corrupt' : createHash('sha256').update(bytes).digest('hex') }
  })
})

describe('resumable ordinary attachment migration to secret storage', () => {
  it('dry-runs without storage IO, a database write, or locking', async () => {
    expect(await migrate_content_storage({ apply: false })).toEqual([{ id: 11, status: 'candidate' }])
    expect(state.connection).not.toHaveBeenCalled()
    expect(state.get).not.toHaveBeenCalled()
    expect(state.upload).not.toHaveBeenCalled()
    expect(state.writes).toEqual([])
    expect(state.events).toEqual([])
  })

  it('moves bounded parts using independent credentials, verifies the full digest and retains a rollback receipt', async () => {
    expect(await migrate_content_storage({ apply: true })).toEqual([{ id: 11, status: 'migrated' }])
    expect(state.row).toMatchObject({ storage_bucket: 'private', is_private: 0, version: 'target-etag', object_key: state.record!.target_key })
    expect(state.record).toMatchObject({ state: 'adopted', source_key: 'content/att/source', sha256: createHash('sha256').update(state.data).digest('hex') })
    expect(state.upload).toHaveBeenCalledTimes(2)
    expect(state.get.mock.calls.map(call => [call[2], call[3]])).toEqual([[0, 8 * 1024 ** 2 - 1], [8 * 1024 ** 2, state.data.length - 1]])
    expect(state.events).toContainEqual({ resource: 'content_attachments:1' })
    expect(await migrate_content_storage({ apply: true })).toEqual([])
    expect(state.upload).toHaveBeenCalledTimes(2)
  })

  it('resumes confirmed parts after interruption without starting a second business result', async () => {
    state.fail_part = 2
    expect(await migrate_content_storage({ apply: true })).toMatchObject([{ status: 'failed' }])
    expect(state.row.storage_bucket).toBe('public')
    expect(state.record).toMatchObject({ upload_id: 'upload-1', state: 'copying', parts: [{ part_number: 1, etag: 'part-1', size: 8 * 1024 ** 2 }] })
    const target = state.record!.target_key
    state.fail_part = 0
    state.upload.mockClear()
    expect(await migrate_content_storage({ apply: true })).toEqual([{ id: 11, status: 'migrated' }])
    expect(state.upload).toHaveBeenCalledOnce()
    expect(state.upload.mock.calls[0]![3]).toBe(2)
    expect(state.row.object_key).toBe(target)
  })

  it('recovers a lost complete response using HEAD and SHA-256 before adoption', async () => {
    state.lost_complete = true
    expect(await migrate_content_storage({ apply: true })).toEqual([{ id: 11, status: 'migrated' }])
    expect(state.digest).toHaveBeenCalledOnce()
    expect(state.row.storage_bucket).toBe('private')
  })

  it.each(['corrupt', 'racing'])('does not publish on %s; retains checkpoints and the source', async (flag) => {
    state[flag as 'corrupt' | 'racing'] = true
    expect(await migrate_content_storage({ apply: true })).toMatchObject([{ status: 'failed' }])
    expect(state.row).toMatchObject({ storage_bucket: 'public', object_key: 'content/att/source' })
    expect(state.record!.state).not.toBe('adopted')
    expect(state.target).not.toBeNull()
    expect(state.events).toEqual([])
  })

  it('does not delete an adopted object when commit acknowledgement is lost', async () => {
    state.lost_commit = true
    expect(await migrate_content_storage({ apply: true })).toMatchObject([{ status: 'failed' }])
    expect(state.row.storage_bucket).toBe('private')
    expect(state.record!.state).toBe('adopted')
    state.lost_commit = false
    expect(await migrate_content_storage({ apply: true })).toEqual([])
    expect(state.upload).toHaveBeenCalledTimes(2)
  })

  it('verifies the original before conditional rollback, preserving both copies', async () => {
    await migrate_content_storage({ apply: true })
    expect(await migrate_content_storage({ apply: false, rollback: true })).toEqual([{ id: 11, status: 'candidate' }])
    expect(await migrate_content_storage({ apply: true, rollback: true })).toEqual([{ id: 11, status: 'rolled_back' }])
    expect(state.row).toMatchObject({ storage_bucket: 'public', object_key: 'content/att/source', version: 'source-version', is_private: 0 })
    expect(state.record!.state).toBe('rolled_back')
    expect(state.target).not.toBeNull()
  })

  it('refuses rollback after a subsequent modification', async () => {
    await migrate_content_storage({ apply: true })
    state.row.version = 'later-version'
    expect(await migrate_content_storage({ apply: true, rollback: true })).toMatchObject([{ status: 'failed' }])
    expect(state.row.storage_bucket).toBe('private')
    expect(state.record!.state).toBe('adopted')
  })

  it('requires explicit source retirement, verifies the target and ends automatic rollback', async () => {
    await migrate_content_storage({ apply: true })
    expect(state.source_retired).toBe(false)
    expect(await migrate_content_storage({ apply: false, retire_sources: true })).toEqual([{ id: 11, status: 'candidate' }])
    expect(state.source_retired).toBe(false)
    expect(await migrate_content_storage({ apply: true, retire_sources: true })).toEqual([{ id: 11, status: 'retired' }])
    expect(state.source_retired).toBe(true)
    expect(state.record!.state).toBe('retired')
    expect(await migrate_content_storage({ apply: true, rollback: true })).toEqual([])
    expect(state.row.storage_bucket).toBe('private')
  })

  it('keeps the public backup when target verification fails during retirement', async () => {
    await migrate_content_storage({ apply: true })
    state.corrupt = true
    expect(await migrate_content_storage({ apply: true, retire_sources: true })).toMatchObject([{ status: 'failed' }])
    expect(state.source_retired).toBe(false)
    expect(state.record!.state).toBe('adopted')
  })

  it('never retires a public source still required by another attachment or backup', async () => {
    await migrate_content_storage({ apply: true })
    state.shared_source = true
    expect(await migrate_content_storage({ apply: true, retire_sources: true })).toMatchObject([{ status: 'failed', reason: expect.stringContaining('共享引用') }])
    expect(state.source_retired).toBe(false)
    expect(state.record!.state).toBe('adopted')
  })

  it('fences an invalid executor before touching objects', async () => {
    state.owned = false
    expect(await migrate_content_storage({ apply: true })).toMatchObject([{ status: 'failed' }])
    expect(state.get).not.toHaveBeenCalled()
    expect(state.upload).not.toHaveBeenCalled()
    expect(state.writes).toEqual([])
    state.lock = false
    await expect(migrate_content_storage({ apply: true })).rejects.toMatchObject({ statusCode: 409 })
  })
})
