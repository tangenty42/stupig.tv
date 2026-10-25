import type { GetObjectCommand } from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { CompleteMultipartUploadCommand, CreateMultipartUploadCommand, HeadObjectCommand, UploadPartCopyCommand } from '@aws-sdk/client-s3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('@aws-sdk/client-s3', async original => ({
  ... await original<object>(),
  S3Client: class { send(... args: unknown[]) { return state.send(... args) } },
}))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ oss: { endpoint: 'https://public.test', bucket: 'public', accessKeyId: 'id', accessKeySecret: 'secret', region: 'test', copyPartSizeMb: 64, buckets: { private: { endpoint: 'https://private.test', bucket: 'private', accessKeyId: 'private-id', accessKeySecret: 'private-secret', region: 'test', copyPartSizeMb: 64 } } } }) }))
const { copy_object, get_object_range, object_sha256, put_object } = await import('./storage')

beforeEach(() => state.send.mockReset())

describe('bounded storage migration IO', () => {
  it('pins an exact range to its source ETag', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    state.send.mockResolvedValue({ $metadata: { httpStatusCode: 206 }, ContentLength: 3, ContentRange: 'bytes 5-7/100', Body: { transformToByteArray: async () => bytes } })
    expect(await get_object_range('public', 'source', 5, 7, 'original')).toEqual(bytes)
    expect((state.send.mock.calls[0]![0] as GetObjectCommand).input).toMatchObject({ Bucket: 'public', Range: 'bytes=5-7', IfMatch: '"original"' })
  })

  it.each([{ status: 200, length: 100, range: undefined }, { status: 206, length: 3, range: 'bytes 6-8/100' }])('rejects an ignored or wrong range before allocating its body: %j', async ({ status, length, range }) => {
    const read = vi.fn()
    state.send.mockResolvedValue({ $metadata: { httpStatusCode: status }, ContentLength: length, ContentRange: range, Body: { transformToByteArray: read } })
    await expect(get_object_range('public', 'source', 5, 7, 'original')).rejects.toThrow('bounded range')
    expect(read).not.toHaveBeenCalled()
  })

  it('hashes the stream and refuses truncated content', async () => {
    const data = Buffer.from('complete content')
    state.send.mockResolvedValueOnce({ Body: Readable.from([data.subarray(0, 4), data.subarray(4)]), ContentLength: data.length })
    expect(await object_sha256('private', 'target', 'version')).toEqual({ sha256: createHash('sha256').update(data).digest('hex'), size: data.length })
    expect((state.send.mock.calls[0]![0] as GetObjectCommand).input).toMatchObject({ Bucket: 'private', IfMatch: '"version"' })
    state.send.mockResolvedValueOnce({ Body: Readable.from([data]), ContentLength: data.length + 1 })
    await expect(object_sha256('private', 'target', 'version')).rejects.toThrow('truncated')
  })

  it('cancels a stalled body after response headers have already arrived', async () => {
    const body = new Readable({ read() {} })
    state.send.mockResolvedValue({ Body: body, ContentLength: 10 })
    const controller = new AbortController()
    const hashing = object_sha256('private', 'target', 'etag', controller.signal)
    const rejection = expect(hashing).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    controller.abort()
    await rejection
    expect(body.destroyed).toBe(true)
  })

  it('routes large same-bucket staging copies through multipart with the same cancellation signal throughout', async () => {
    const signal = new AbortController().signal
    state.send.mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand)
        return { ContentLength: 6 * 1024 ** 3, ETag: '"source"' }
      if (command instanceof CreateMultipartUploadCommand)
        return { UploadId: 'upload' }
      if (command instanceof UploadPartCopyCommand)
        return { CopyPartResult: { ETag: '"part"' } }
      return { ETag: '"complete"' }
    })
    expect(await copy_object('private', 'staging', 'target')).toBe('complete')
    const commands = state.send.mock.calls.map(call => call[0])
    expect(commands.filter(command => command instanceof UploadPartCopyCommand)).toHaveLength(96)
    expect(commands.some(command => command instanceof CompleteMultipartUploadCommand)).toBe(true)
    // The public copy helper also accepts a task signal; head/create/complete
    // must be cancellable, not only UploadPartCopy.
    const { copy_between_buckets } = await import('./storage')
    state.send.mockClear()
    await copy_between_buckets('private', 'staging', 'private', 'target', signal)
    expect(state.send.mock.calls.every(call => call[1]?.abortSignal === signal)).toBe(true)
  })

  it('rejects an unknown location instead of choosing another bucket', async () => {
    await expect(put_object('invalid' as 'private', 'key', new Uint8Array(), null)).rejects.toMatchObject({ statusCode: 503 })
    expect(state.send).not.toHaveBeenCalled()
  })
})
