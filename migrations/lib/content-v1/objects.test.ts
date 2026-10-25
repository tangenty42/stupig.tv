import type { MigrationContext } from '../../../scripts/migration/contract'
import type { Source } from './storage'
import { createCipheriv, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { copy_object } from './objects'
import { digest } from './plan'

function fixture(bytes = Buffer.from('original payload')) {
  let row: Record<string, any> | null = null
  const objects = new Map<string, Buffer>()
  const parts = new Map<number, Buffer>()
  const fault = { part: false, complete: false, public: false }
  const identity = { key: 'source', size: bytes.length, etag: 'source-etag', version_id: null, location: 'qa' }
  const source: Source = { head: async () => ({ ... identity }), read: async () => Readable.from([bytes]) }
  const query = async () => [[row].filter(Boolean)]
  const execute = async (sql: string, args: any[]) => {
    if (sql.startsWith('INSERT'))
      row = { id: args[0], source_identity: JSON.parse(args[6]), target_key: args[7], upload_id: null, part_size: args[8], parts: [], state: 'copying' }
    else if (sql.includes('SET upload_id'))
      row!.upload_id = args[0]
    else if (sql.includes('SET parts'))
      row!.parts = JSON.parse(args[0])
    else if (sql.includes('SET expected_sha256'))
      Object.assign(row!, { expected_sha256: args[0], expected_size: sql.includes('expected_size=0') ? 0 : args[1] })
    else if (sql.includes('SET result'))
      Object.assign(row!, { result: JSON.parse(args[0]), state: 'verified' })
    else throw new Error(sql)
    return [{ affectedRows: 1 }]
  }
  const storage = {
    head_object: vi.fn(async (key: string) => {
      const value = objects.get(key)
      if (! value)
        throw Object.assign(new Error('absent'), { status: 404 })
      return { etag: digest(value), size: value.length, version_id: 'v1' }
    }),
    get_object_access: vi.fn(async () => fault.public ? 'public-read' : 'private'),
    get_object_stream: vi.fn(async (key: string) => ({ stream: Readable.from([objects.get(key)!]), size: objects.get(key)!.length })),
    list_multipart_uploads: vi.fn(async () => []),
    create_multipart_upload: vi.fn(async () => 'upload-one'),
    list_multipart_parts: vi.fn(async () => ({ parts: [... parts].map(([number, value]) => ({ part_number: number, size: value.length, etag: digest(value) })), next_marker: null })),
    upload_part: vi.fn(async (_key: string, _id: string, number: number, value: Buffer) => {
      parts.set(number, Buffer.from(value))
      if (fault.part) {
        fault.part = false
        throw new Error('part_ack_lost')
      }
      return { part_number: number, size: value.length, etag: digest(value) }
    }),
    complete_multipart_upload: vi.fn(async (key: string) => {
      objects.set(key, Buffer.concat([... parts].sort(([a], [b]) => a - b).map(([, value]) => value)))
      if (fault.complete) {
        fault.complete = false
        throw new Error('complete_ack_lost')
      }
      return { etag: digest(objects.get(key)!), version_id: 'v1' }
    }),
    put_object: vi.fn(async (key: string, value: Buffer) => {
      objects.set(key, value)
      return { etag: digest(value), version_id: 'v1' }
    }),
  }
  const ctx = { filename: 'qa.ts', db: { query, execute }, signal: new AbortController().signal, oss: async () => storage } as unknown as MigrationContext
  const input = { scope: 1, attachment: 2, role: 'original', provider: 'legacy' as const, source_key: 'source', source, encryption_key: null as string | null, mime: 'application/octet-stream', part_size: 5 }
  return { copy: () => copy_object(ctx, input), storage, objects, fault, identity, input, row: () => row! }
}
it('resumes a lost part acknowledgement with identical bytes and no duplicate target', async () => {
  const f = fixture()
  f.fault.part = true
  await expect(f.copy()).rejects.toThrow('part_ack_lost')
  const key = f.row().target_key
  const result = await f.copy()
  expect(result.key).toBe(key)
  expect(f.objects.get(key)).toEqual(Buffer.from('original payload'))
  expect(f.storage.create_multipart_upload).toHaveBeenCalledOnce()
  expect(f.row().state).toBe('verified')
})
it('reconciles a lost Complete receipt by full digest without a second Complete', async () => {
  const f = fixture()
  f.fault.complete = true
  await expect(f.copy()).rejects.toThrow('complete_ack_lost')
  const result = await f.copy()
  expect(result.sha256).toBe(digest(Buffer.from('original payload')))
  expect(f.storage.complete_multipart_upload).toHaveBeenCalledOnce()
})
it('never completes a tampered AES file and refuses a changed source on retry', async () => {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const bytes = Buffer.concat([iv, cipher.update('secret payload'), cipher.final(), cipher.getAuthTag()])
  bytes[12]! ^= 1
  const f = fixture(bytes)
  f.input.encryption_key = key.toString('base64')
  await expect(f.copy()).rejects.toThrow()
  expect(f.storage.complete_multipart_upload).not.toHaveBeenCalled()
  expect(f.objects.size).toBe(0)
  f.identity.etag = 'new-source'
  await expect(f.copy()).rejects.toThrow('migration_source_or_profile_changed')
})
it('requires private ACL and rechecks already-verified targets for corruption', async () => {
  const f = fixture()
  f.fault.public = true
  await expect(f.copy()).rejects.toThrow('target_size_or_access')
  expect(f.row().state).toBe('copying')
  f.fault.public = false
  const result = await f.copy()
  f.objects.set(result.key, Buffer.alloc(result.size))
  await expect(f.copy()).rejects.toThrow('target_digest_or_version')
})
it('handles empty objects and rejects multipart overflow before starting a transfer', async () => {
  const empty = fixture(Buffer.alloc(0))
  expect((await empty.copy()).size).toBe(0)
  expect(empty.storage.create_multipart_upload).not.toHaveBeenCalled()
  const huge = fixture()
  huge.identity.size = 50001
  await expect(huge.copy()).rejects.toThrow('migration_object_size')
  expect(huge.storage.create_multipart_upload).not.toHaveBeenCalled()
})
