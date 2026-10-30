import { createHash } from 'node:crypto'
import { encrypt_attachment } from '@server/lib/attachment-crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  row: {} as Record<string, unknown>, backups: [] as Record<string, unknown>[],
  objects: new Map<string, Uint8Array>(), corrupt: false, racing: false, namespace: 0,
  writes: [] as string[], events: [] as unknown[], get: vi.fn(), put: vi.fn(), delete: vi.fn(), commit: vi.fn(), rollback: vi.fn(),
}))
vi.mock('@server/lib/db', () => {
  const execute = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM content_story_drafts'))
      return [[]]
    if (sql.includes('UNION SELECT attachment_id'))
      return [[... [state.row], ... state.backups].some(row => row.object_key === params[0] || row.private_object_key === params[0] || row.old_object_key === params[0]) ? [{ id: 11 }] : []]
    if (sql.startsWith('SELECT') && sql.includes('content_attachment_encryption_backup'))
      return [structuredClone(state.backups.filter(backup => ! backup.rolled_back_at))]
    if (sql.includes('FROM content_stories'))
      return [[{ namespace_revision: state.namespace, markdown: '', cover: '', cover_version: null }]]
    if (sql.startsWith('SELECT') && sql.includes('FROM content_story_attachments')) {
      if (sql.includes('is_private = 0') && state.row.is_private)
        return [[]]
      return [[structuredClone(state.row)]]
    }
    state.writes.push(sql)
    if (sql.startsWith('INSERT INTO content_attachment_encryption_backup')) {
      state.backups.push({ attachment_id: params[0], story_id: params[1], old_object_key: params[2], encryption_key: params[3], old_version: params[4], old_file_size: params[5], plaintext_sha256: params[6], private_object_key: params[7], private_version: params[8], private_file_size: params[9], rolled_back_at: null })
    }
    if (sql.startsWith('UPDATE content_story_attachments')) {
      Object.assign(state.row, { object_key: params[0], version: params[1], file_size: params[2], storage_bucket: sql.includes('is_private = 1') ? 'private' : 'public', is_private: sql.includes('is_private = 1') ? 1 : 0, encryption_key: sql.includes('is_private = 1') ? null : params[3] })
    }
    if (sql.startsWith('UPDATE content_attachment_encryption_backup'))
      state.backups[0]!.rolled_back_at = '2026-10-14'
    if (sql.startsWith('UPDATE content_stories SET namespace_revision'))
      state.namespace ++
    return [{ affectedRows: 1 }]
  }
  return { db: { execute, getConnection: async () => ({ execute, beginTransaction: async () => {}, commit: state.commit, rollback: state.rollback, release: vi.fn() }) } }
})
vi.mock('@server/lib/storage', () => ({
  storage_bucket_name: (bucket: string) => `${bucket}-bucket`,
  get_object: state.get, put_object: state.put, delete_object_best_effort: state.delete,
  head_object: async (bucket: string, key: string) => ({ size: state.objects.get(`${bucket}:${key}`)!.length, etag: 'private-version' }),
}))
vi.mock('@server/lib/sync', () => ({ publish_refresh: (event: unknown) => state.events.push(event), sync_resource: (kind: string, id: unknown) => `${kind}:${id}` }))

const { migrate_private_attachments } = await import('./private-attachment-migration.service')
const plain = new Uint8Array([1, 2, 3, 4])

beforeEach(() => {
  vi.clearAllMocks()
  state.backups = []
  state.writes = []
  state.events = []
  state.objects.clear()
  state.corrupt = false
  state.racing = false
  state.namespace = 0
  const encrypted = encrypt_attachment(plain)
  state.objects.set('public:old-cipher', encrypted.data)
  state.row = { id: 11, story_id: 1, is_folder: 0, file_name: 'a.png.good', object_key: 'old-cipher', version: 'cipher-version', file_size: encrypted.data.length, encryption_key: encrypted.key, is_private: 0, storage_bucket: 'public', mime_type: 'image/png' }
  state.get.mockImplementation(async (bucket: string, key: string) => {
    if (bucket === 'private' && state.corrupt)
      return new Uint8Array([9, 9, 9, 9])
    return state.objects.get(`${bucket}:${key}`)!
  })
  state.put.mockImplementation(async (bucket: string, key: string, bytes: Uint8Array) => {
    state.objects.set(`${bucket}:${key}`, bytes)
    if (state.racing)
      state.row.version = 'concurrent-version'
    return 'private-version'
  })
})

describe('verified legacy ciphertext migration', () => {
  it('defaults to an inventory with no object IO, business writes or events', async () => {
    expect(await migrate_private_attachments({ apply: false })).toEqual([{ id: 11, status: 'candidate' }])
    expect(state.get).not.toHaveBeenCalled()
    expect(state.put).not.toHaveBeenCalled()
    expect(state.writes).toEqual([])
    expect(state.events).toEqual([])
  })

  it('verifies plaintext SHA-256, records rollback material, then adopts a private copy without deleting ciphertext', async () => {
    expect(await migrate_private_attachments({ apply: true })).toEqual([{ id: 11, status: 'migrated' }])
    expect(state.backups[0]).toMatchObject({ attachment_id: 11, old_object_key: 'old-cipher', old_version: 'cipher-version', plaintext_sha256: createHash('sha256').update(plain).digest('hex') })
    expect(state.row).toMatchObject({ file_name: 'a.png.good', is_private: 1, encryption_key: null, version: 'private-version', file_size: 4 })
    expect(state.namespace).toBe(1)
    expect(state.commit).toHaveBeenCalledOnce()
    expect(state.get.mock.calls.map(([bucket]) => bucket)).toEqual(['public', 'private'])
    expect(state.delete).not.toHaveBeenCalled()
    expect(await migrate_private_attachments({ apply: true })).toEqual([])
    expect(state.put).toHaveBeenCalledOnce()
  })

  it.each(['corrupt', 'racing'])('does not adopt or overwrite rollback material when %s verification fails', async (mode) => {
    state[mode as 'corrupt' | 'racing'] = true
    expect(await migrate_private_attachments({ apply: true })).toMatchObject([{ id: 11, status: 'failed' }])
    expect(state.row.object_key).toBe('old-cipher')
    expect(state.backups).toEqual([])
    expect(state.writes).toEqual([])
    expect(state.events).toEqual([])
    expect(state.delete).toHaveBeenCalledWith('private', expect.stringMatching(/^content\/att\//))
    expect(state.delete).not.toHaveBeenCalledWith('public', 'old-cipher')
  })

  it('restores old ciphertext and key only while the migrated object still matches, keeping both copies', async () => {
    const key = state.row.encryption_key
    await migrate_private_attachments({ apply: true })
    expect(await migrate_private_attachments({ apply: false, rollback: true })).toEqual([{ id: 11, status: 'candidate' }])
    expect(await migrate_private_attachments({ apply: true, rollback: true })).toEqual([{ id: 11, status: 'rolled_back' }])
    expect(state.row).toMatchObject({ object_key: 'old-cipher', version: 'cipher-version', is_private: 0, encryption_key: key })
    expect(state.backups[0]?.rolled_back_at).toBeTruthy()
    expect(state.delete).not.toHaveBeenCalled()
  })

  it('reports unusable legacy rows without exposing their keys or paths', async () => {
    state.row.encryption_key = null
    const result = await migrate_private_attachments({ apply: false })
    expect(result).toMatchObject([{ id: 11, status: 'skipped' }])
    expect(JSON.stringify(result)).not.toContain('old-cipher')
    expect(JSON.stringify(result)).not.toContain('a.png.good')
    expect(state.get).not.toHaveBeenCalled()
  })
})
