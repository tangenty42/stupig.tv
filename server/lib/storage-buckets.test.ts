import type { AbortMultipartUploadCommand, CopyObjectCommand } from '@aws-sdk/client-s3'
import { CompleteMultipartUploadCommand, CreateMultipartUploadCommand, HeadObjectCommand, PutObjectCommand, UploadPartCopyCommand } from '@aws-sdk/client-s3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  send: vi.fn(), sign: vi.fn(), clients: [] as Record<string, unknown>[],
  private_configured: true,
  public: { endpoint: 'https://public.test', region: 'public-region', bucket: 'public-bucket', accessKeyId: 'public-id', accessKeySecret: 'public-secret', forcePathStyle: true, copyPartSizeMb: 64 },
  private: { endpoint: 'https://private.test', region: 'private-region', bucket: 'private-bucket', accessKeyId: 'private-id', accessKeySecret: 'private-secret', forcePathStyle: true, copyPartSizeMb: 64 },
}))
vi.mock('@aws-sdk/client-s3', async original => ({
  ... await original<object>(),
  S3Client: class {
    constructor(config: Record<string, unknown>) {
      mocks.clients.push(config)
    }

    send(... args: unknown[]) {
      return mocks.send(... args)
    }
  },
}))
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: mocks.sign }))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ oss: { ... mocks.public, buckets: {
  public: mocks.public,
  get private() {
    return mocks.private_configured ? mocks.private : null
  },
} } }) }))
const { copy_between_buckets, put_object, storage_bucket_name } = await import('./storage')

beforeEach(() => {
  mocks.private_configured = true
  mocks.send.mockReset()
})

describe('explicit storage bucket selection', () => {
  it('uses each bucket credentials and sets private cache headers without falling back to public', async () => {
    mocks.send.mockResolvedValue({ ETag: '"etag"' })
    await put_object('public', 'public-key', new Uint8Array([1]), 'image/png')
    await put_object('private', 'private-key', new Uint8Array([2]), 'image/png')
    const commands = mocks.send.mock.calls.map(([command]) => (command as PutObjectCommand).input)
    expect(commands).toMatchObject([
      { Bucket: 'public-bucket', CacheControl: 'public, max-age=31536000, immutable' },
      { Bucket: 'private-bucket', CacheControl: 'private, no-store' },
    ])
    expect(mocks.clients).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpoint: 'https://public.test', credentials: { accessKeyId: 'public-id', secretAccessKey: 'public-secret' } }),
      expect.objectContaining({ endpoint: 'https://private.test', credentials: { accessKeyId: 'private-id', secretAccessKey: 'private-secret' } }),
    ]))
    mocks.private_configured = false
    await expect(put_object('private', 'cannot-leak', new Uint8Array([3]), null)).rejects.toMatchObject({ statusCode: 503 })
    expect(() => storage_bucket_name('private')).toThrow()
    expect(mocks.send).toHaveBeenCalledTimes(2)
  })

  it('copies to the selected target bucket, preserving type and replacing public cache metadata', async () => {
    mocks.send.mockImplementation(async command => command instanceof HeadObjectCommand ? { ContentLength: 123, ContentType: 'video/mp4', ETag: '"source"' } : { CopyObjectResult: { ETag: '"target"' } })
    expect(await copy_between_buckets('public', 'folder/a b.mp4', 'private', 'new-key')).toBe('target')
    expect((mocks.send.mock.calls[1]?.[0] as CopyObjectCommand).input).toMatchObject({
      Bucket: 'private-bucket', Key: 'new-key', CopySource: 'public-bucket/folder/a%20b.mp4', CopySourceIfMatch: '"source"',
      MetadataDirective: 'REPLACE', ContentType: 'video/mp4', CacheControl: 'private, no-store',
    })
  })

  it.each([
    { size: 65 * 1024 ** 2 + 1, part_size: 64 * 1024 ** 2, count: 2 },
    { size: 6 * 1024 ** 3 + 1, part_size: 64 * 1024 ** 2, count: 97 },
    { size: 1024 ** 4, part_size: 109_951_163, count: 10_000 },
  ])('copies $size bytes in bounded ranges within the 10000 part limit', async ({ size, part_size, count }) => {
    mocks.send.mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand)
        return { ContentLength: size, ContentType: 'video/mp4', ETag: '"source"' }
      if (command instanceof CreateMultipartUploadCommand)
        return { UploadId: 'copy-upload' }
      if (command instanceof UploadPartCopyCommand)
        return { CopyPartResult: { ETag: `"part-${command.input.PartNumber}"` } }
      return { ETag: '"final"' }
    })
    expect(await copy_between_buckets('private', 'source', 'public', 'target')).toBe('final')
    const parts = mocks.send.mock.calls.map(([command]) => command).filter(command => command instanceof UploadPartCopyCommand) as UploadPartCopyCommand[]
    expect(parts).toHaveLength(count)
    expect(parts[0]?.input).toMatchObject({ Bucket: 'public-bucket', CopySource: 'private-bucket/source', CopySourceRange: `bytes=0-${part_size - 1}` })
    for (const [index, part] of parts.entries())
      expect(part.input.CopySourceRange).toBe(`bytes=${index * part_size}-${Math.min(size, (index + 1) * part_size) - 1}`)
    const final_start = Math.floor((size - 1) / part_size) * part_size
    expect(parts.at(- 1)?.input.CopySourceRange).toBe(`bytes=${final_start}-${size - 1}`)
    const completed = mocks.send.mock.calls.find(([command]) => command instanceof CompleteMultipartUploadCommand)?.[0] as CompleteMultipartUploadCommand
    expect(completed.input.MultipartUpload?.Parts).toEqual(parts.map((_, index) => ({ PartNumber: index + 1, ETag: `"part-${index + 1}"` })))
    expect(mocks.send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false)
  })

  it('aborts a partial copy in the destination bucket and propagates the original failure', async () => {
    const failure = new Error('copy failed')
    mocks.send.mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand)
        return { ContentLength: 6 * 1024 ** 3 }
      if (command instanceof CreateMultipartUploadCommand)
        return { UploadId: 'copy-upload' }
      if (command instanceof UploadPartCopyCommand)
        throw failure
      return {}
    })
    await expect(copy_between_buckets('public', 'source', 'private', 'target')).rejects.toBe(failure)
    expect((mocks.send.mock.calls.at(- 1)?.[0] as AbortMultipartUploadCommand).input).toMatchObject({ Bucket: 'private-bucket', Key: 'target', UploadId: 'copy-upload' })
    expect(mocks.send.mock.calls.some(([command]) => command instanceof CompleteMultipartUploadCommand)).toBe(false)
  })
})
