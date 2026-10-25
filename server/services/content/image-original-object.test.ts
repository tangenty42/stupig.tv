import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { copy_image_original, image_original_key, verify_image_original } from './image-original-object'

function fixture() {
  const bytes = Buffer.from('original image bytes')
  const source = { key: 'content/att/staging/a/b', etag: 'source-etag', version_id: 'source-version', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const target = image_original_key('a'.repeat(32), 'b'.repeat(32))
  const storage = {
    head_object: vi.fn(async (key: string) => key === source.key ? { ... source } : { etag: 'target-etag', version_id: 'target-version', size: bytes.length }),
    get_object_access: vi.fn().mockResolvedValue('private'),
    get_object_stream: vi.fn().mockImplementation(async () => ({ stream: Readable.from([bytes]), size: bytes.length })),
    copy_object: vi.fn(),
  }
  return { bytes, source, target, storage }
}

it('copies the exact source privately and reads back its full digest with its new identity', async () => {
  const { source, target, storage } = fixture()
  expect(await copy_image_original(storage, source, target)).toEqual({ ... source, key: target, etag: 'target-etag', version_id: 'target-version' })
  expect(storage.copy_object).toHaveBeenCalledExactlyOnceWith(source.key, target, 'private')
  expect(storage.get_object_stream).toHaveBeenCalledWith(target, 'target-etag', undefined)
})

it.each(['etag', 'version_id', 'size', 'access'])('does not copy a source with a changed %s', async (field) => {
  const { source, target, storage } = fixture()
  if (field === 'access')
    storage.get_object_access.mockResolvedValue('public-read')
  else
    storage.head_object.mockResolvedValueOnce({ ... source, [field]: field === 'size' ? 1 : 'changed' })
  await expect(copy_image_original(storage, source, target)).rejects.toMatchObject({ statusCode: 409 })
  expect(storage.copy_object).not.toHaveBeenCalled()
})

it.each(['digest', 'size', 'access', 'version'])('rejects a copied target with invalid %s', async (field) => {
  const { source, target, storage, bytes } = fixture()
  if (field === 'digest')
    storage.get_object_stream.mockResolvedValue({ stream: Readable.from([Buffer.alloc(bytes.length)]), size: bytes.length })
  if (field === 'size')
    storage.get_object_stream.mockResolvedValue({ stream: Readable.from([bytes.subarray(1)]), size: bytes.length })
  if (field === 'access')
    storage.get_object_access.mockResolvedValue('default')
  if (field === 'version')
    storage.head_object.mockResolvedValueOnce({ etag: 'target-etag', version_id: 'old-target-version', size: bytes.length })
  await expect(verify_image_original(storage, target, source)).rejects.toMatchObject({ statusCode: 409 })
})

it('rejects escaped ownership keys and aborts before an external copy starts', async () => {
  expect(() => image_original_key('../elsewhere', 'b'.repeat(32))).toThrow()
  const { storage, source, target } = fixture()
  await expect(copy_image_original(storage, source, target, AbortSignal.abort(new Error('stopped')))).rejects.toThrow('stopped')
  expect(storage.copy_object).not.toHaveBeenCalled()
})
