import { expect, it, vi } from 'vitest'
import { create_inventory_reader } from './oss-inventory'

const config = { region: 'oss-cn-guangzhou', endpoint: 'https://oss-cn-guangzhou.aliyuncs.com', bucket: 'test-bucket',
  accessKeyId: 'fixture', accessKeySecret: 'fixture', publicBaseUrl: 'https://static.test', timeoutMs: 10000, copyPartSizeMb: 8, uploadRoleArn: null }
const version = { Key: 'a%20b', VersionId: 'opaque/Z', IsLatest: 'false', LastModified: '2026-01-01T00:00:00Z', Size: '42', ETag: 'etag', StorageClass: 'Standard' }

it('preserves delete-marker latest flags and opaque paired cursors using GET requests only', async () => {
  const request = vi.fn().mockResolvedValue({ data: { EncodingType: 'url', IsTruncated: 'true', NextKeyMarker: 'a%20b', NextVersionIdMarker: 'opaque/A',
    Version: version, DeleteMarker: { Key: 'a%20b', VersionId: 'opaque/new', IsLatest: 'true', LastModified: '2026-01-02T00:00:00Z' } } })
  const reader = create_inventory_reader(config, request)
  const page = await reader.versions({ key: 'a b', id: 'opaque/Z' }, 25, '')
  expect(page.next).toEqual({ key: 'a b', id: 'opaque/A' })
  expect(page.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: 'a b', version_id: 'opaque/Z', latest: false, size: 42 }),
    expect.objectContaining({ key: 'a b', version_id: 'opaque/new', latest: true, deleted: true, size: 0 }),
  ]))
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', object: '', subres: { versions: '' },
    query: { 'max-keys': 25, 'encoding-type': 'url', 'key-marker': 'a b', 'version-id-marker': 'opaque/Z' } }))
})

it('normalizes singleton XML parts and false strings instead of treating false as truncated', async () => {
  const request = vi.fn().mockResolvedValue({ data: { UploadId: 'upload', IsTruncated: 'false', Part: { PartNumber: '1', Size: '123' } } })
  const result = await create_inventory_reader(config, request).parts({ key: 'file', upload_id: 'upload', initiated_at: '2026-01-01T00:00:00Z' }, 0, 25)
  expect(result).toEqual({ count: 1, bytes: 123, next: null })
  expect(request.mock.calls[0]![0]).toMatchObject({ method: 'GET', object: 'file', subres: { uploadId: 'upload' } })
})

it('does not turn denied reads into empty inventory and rejects malformed/repeated pages', async () => {
  const denied = Object.assign(new Error('secret URL'), { status: 403 })
  const request = vi.fn().mockRejectedValueOnce(denied)
    .mockResolvedValueOnce({ data: { IsTruncated: 'true', NextKeyMarker: 'a', NextVersionIdMarker: 'id', Version: { ... version, Key: 'a' } } })
    .mockResolvedValueOnce({ data: { IsTruncated: 'false', Version: { ... version, Size: '-1' } } })
  const reader = create_inventory_reader(config, request)
  await expect(reader.versions(null, 25, '')).rejects.toBe(denied)
  await expect(reader.versions({ key: 'a', id: 'id' }, 25, '')).rejects.toThrow('invalid_oss_inventory_response')
  await expect(reader.versions(null, 25, '')).rejects.toThrow('invalid_oss_inventory_response')
})

it('treats only an explicit absent lifecycle policy as no rules', async () => {
  const request = vi.fn().mockRejectedValueOnce(Object.assign(new Error('no rules'), { status: 404, code: 'NoSuchLifecycle' }))
    .mockRejectedValueOnce(Object.assign(new Error('denied'), { status: 403 }))
  const reader = create_inventory_reader(config, request)
  await expect(reader.configuration('lifecycle')).resolves.toEqual({ Rule: [] })
  await expect(reader.configuration('lifecycle')).rejects.toMatchObject({ status: 403 })
})
