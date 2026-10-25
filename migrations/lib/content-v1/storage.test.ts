import type { MigrationContext } from '../../../scripts/migration/contract'
import type { Node } from './plan'
import type { Source, SourceIdentity } from './storage'
import { createCipheriv, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { chunked, plaintext, source_for } from './storage'

const sdk = vi.hoisted(() => ({ send: vi.fn(), config: vi.fn() }))
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    constructor(config: unknown) { sdk.config(config) }
    send = sdk.send
  },
  HeadObjectCommand: class { constructor(public input: unknown) {} },
  GetObjectCommand: class { constructor(public input: unknown) {} },
}))
vi.mock('@config/loader', () => ({ load_migration_source_config: () => ({ endpoint: 'https://source.test', region: 'qa', bucket: 'qa-dev', accessKeyId: 'id', accessKeySecret: 'secret', forcePathStyle: true, connectionTimeoutMs: 1000, requestTimeoutMs: 2000 }) }))

const signal = new AbortController().signal
async function collect(stream: AsyncIterable<Uint8Array>) {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
function source(bytes: Buffer, size = bytes.length): { source: Source, identity: SourceIdentity } {
  const identity = { key: 'source', size, etag: 'one', version_id: 'v1', location: 'qa' }
  return { identity, source: { head: async () => ({ ... identity }), read: async () => Readable.from(Array.from(bytes, value => Buffer.from([value]))) } }
}
function encrypt(bytes: Buffer) {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  return { bytes: Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]), key: key.toString('base64') }
}
it('decrypts byte-sized AES-GCM chunks including an empty encrypted file', async () => {
  for (const bytes of [Buffer.from('真实原图'), Buffer.alloc(0)]) {
    const encrypted = encrypt(bytes)
    const f = source(encrypted.bytes)
    expect(await collect(plaintext(f.source, f.identity, encrypted.key, signal))).toEqual(bytes)
  }
})
it('rejects ciphertext tampering, wrong key, truncation, and source replacement', async () => {
  const encrypted = encrypt(Buffer.from('payload'))
  encrypted.bytes[13]! ^= 1
  let f = source(encrypted.bytes)
  await expect(collect(plaintext(f.source, f.identity, encrypted.key, signal))).rejects.toThrow()
  f = source(encrypt(Buffer.from('payload')).bytes)
  await expect(collect(plaintext(f.source, f.identity, encrypted.key, signal))).rejects.toThrow()
  f = source(Buffer.from('short'), 6)
  await expect(collect(plaintext(f.source, f.identity, null, signal))).rejects.toThrow('source_truncated')
  f = source(Buffer.from('old'))
  f.source.head = async () => ({ ... f.identity, etag: 'changed' })
  await expect(collect(plaintext(f.source, f.identity, null, signal))).rejects.toThrow('source_changed')
})
it('honors cancellation and divides arbitrary chunks without duplicating bytes', async () => {
  const abort = new AbortController()
  abort.abort()
  const f = source(Buffer.from('abcd'))
  await expect(collect(plaintext(f.source, f.identity, null, abort.signal))).rejects.toThrow()
  const parts = []
  for await (const part of chunked(Readable.from([Buffer.from('ab'), Buffer.from('cdefgh')]), 3)) parts.push(Buffer.from(part).toString())
  expect(parts).toEqual(['abc', 'def', 'gh'])
  await expect(collect(chunked(Readable.from([]), 0))).rejects.toThrow('invalid_chunk_size')
})

it('reads the legacy bucket through conditional versioned GET and validates the returned stream length', async () => {
  const ctx = { signal, assert_active: vi.fn() } as unknown as MigrationContext
  const row = { object_key: 'old/file', storage_provider: 'legacy', storage_bucket: 'private' } as Node
  const source = await source_for(ctx, row)
  sdk.send.mockResolvedValueOnce({ ETag: '"etag"', ContentLength: 3, VersionId: 'v1' })
  const identity = await source.head()
  expect(identity).toMatchObject({ size: 3, etag: 'etag', version_id: 'v1' })
  sdk.send.mockResolvedValueOnce({ Body: Readable.from([Buffer.from('abc')]), ContentLength: 3 })
  expect(await collect(await source.read(identity))).toEqual(Buffer.from('abc'))
  expect(sdk.send.mock.calls[1]![0].input).toMatchObject({ Bucket: 'qa-dev', Key: 'old/file', IfMatch: '"etag"', VersionId: 'v1' })
  sdk.send.mockResolvedValueOnce({ Body: Readable.from([]), ContentLength: 4 })
  await expect(source.read(identity)).rejects.toThrow('source_stream_invalid')
})
