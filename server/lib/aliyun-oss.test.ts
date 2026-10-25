import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  clients: [] as Record<string, unknown>[],
  methods: {
    put: vi.fn(), getObjectMeta: vi.fn(), head: vi.fn(), copy: vi.fn(),
    initMultipartUpload: vi.fn(), uploadPart: vi.fn(), listParts: vi.fn(), completeMultipartUpload: vi.fn(),
    uploadPartCopy: vi.fn(), abortMultipartUpload: vi.fn(), listUploads: vi.fn(),
    putACL: vi.fn(), getACL: vi.fn(), signatureUrlV4: vi.fn(), getStream: vi.fn(),
    getBucketACL: vi.fn(), getBucketVersioning: vi.fn(), getBucketLifecycle: vi.fn(), delete: vi.fn(),
  },
}))
vi.mock('ali-oss', () => ({ default: class {
  constructor(config: Record<string, unknown>) {
    state.clients.push(config)
    Object.assign(this, state.methods)
  }
} }))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ aliyun: { oss: null } }) }))
const { create_aliyun_oss } = await import('./aliyun-oss')
const config = {
  region: 'oss-cn-hangzhou', endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', bucket: 'destination',
  publicBaseUrl: 'https://cdn.test', accessKeyId: 'oss-specific-id', accessKeySecret: 'oss-specific-secret',
  timeoutMs: 120_000, copyPartSizeMb: 64, uploadRoleArn: null,
}
const response = (values: Record<string, string> = {}) => ({ res: { headers: { 'etag': '"target"', 'x-oss-version-id': 'target-version', ... values } } })

beforeEach(() => {
  state.clients.length = 0
  for (const mock of Object.values(state.methods))
    mock.mockReset()
  state.methods.put.mockResolvedValue(response())
  state.methods.getObjectMeta.mockResolvedValue(response({ 'etag': '"source"', 'content-length': '12' }))
  state.methods.head.mockResolvedValue(response({ 'etag': '"source"', 'content-type': 'image/png' }))
  state.methods.copy.mockResolvedValue(response())
  state.methods.initMultipartUpload.mockResolvedValue({ uploadId: 'upload' })
  state.methods.uploadPart.mockResolvedValue({ etag: '"part"' })
  state.methods.completeMultipartUpload.mockResolvedValue(response())
  state.methods.uploadPartCopy.mockImplementation(async (_key, _id, number) => ({ etag: `"part-${number}"` }))
  state.methods.getBucketVersioning.mockResolvedValue({ versionStatus: 'Enabled' })
})
afterEach(() => vi.unstubAllEnvs())

it('discovers lost multipart initializations only for the exact owned key in one bounded page', async () => {
  const key = 'content/att/staging/session/attempt'
  state.methods.listUploads.mockResolvedValue({ uploads: [
    { name: key, uploadId: 'owned' }, { name: `${key}-other`, uploadId: 'other' },
  ] })
  const storage = create_aliyun_oss(config)
  expect(await storage.list_multipart_uploads(key)).toEqual(['owned'])
  expect(state.methods.listUploads).toHaveBeenCalledExactlyOnceWith({ 'prefix': key, 'max-uploads': 1000 })
  state.methods.listUploads.mockResolvedValue({ uploads: [{ name: key, uploadId: 'bad\nidentifier' }] })
  await expect(storage.list_multipart_uploads(key)).rejects.toMatchObject({ statusCode: 400 })
  expect(state.methods.abortMultipartUpload).not.toHaveBeenCalled()
})

it('rejects unsupported environment proxy activation before constructing the SDK', () => {
  vi.stubEnv('URLLIB_ENABLE_PROXY', '1')
  expect(() => create_aliyun_oss(config)).toThrow('不支持通过 urllib 环境变量启用代理')
  expect(state.clients).toHaveLength(0)
})

describe('aliyun destination storage boundary', () => {
  it('fails closed when unconfigured and uses independent credentials with V4 and HTTPS', () => {
    expect(() => create_aliyun_oss()).toThrow('尚未配置')
    expect(state.clients).toEqual([])
    create_aliyun_oss(config)
    expect(state.clients).toEqual([expect.objectContaining({
      accessKeyId: 'oss-specific-id', accessKeySecret: 'oss-specific-secret',
      authorizationV4: true, secure: true, timeout: 120_000, bucket: 'destination',
    })])
  })

  it('keeps private writes atomic and distinguishes explicit public assets from private bucket inheritance', async () => {
    const storage = create_aliyun_oss(config)
    expect(await storage.put_object('content/att/private', new Uint8Array([1]), 'image/png')).toEqual({ etag: 'target', version_id: 'target-version' })
    expect(state.methods.put).toHaveBeenCalledWith('content/att/private', Buffer.from([1]), expect.objectContaining({ headers: { 'x-oss-object-acl': 'private', 'Cache-Control': 'private, no-store' } }))
    await storage.put_object('logo', new Uint8Array([2]), 'image/png', 'public')
    expect(state.methods.put.mock.calls[1]![2].headers).toEqual({ 'x-oss-object-acl': 'public-read', 'Cache-Control': 'public, max-age=31536000, immutable' })
    await storage.put_object('inherited', new Uint8Array([3]), 'image/png', 'inherit')
    expect(state.methods.put.mock.calls[2]![2].headers).toEqual({ 'x-oss-object-acl': 'default', 'Cache-Control': 'private, no-store' })
    expect(state.methods.putACL).not.toHaveBeenCalled()
  })

  it.each(['/other-bucket', 'folder/../other', 'key?versionId=old', 'key\nheader'])('rejects an ambiguous object key before writing: %s', async (key) => {
    await expect(create_aliyun_oss(config).put_object(key, new Uint8Array([1]), null)).rejects.toMatchObject({ statusCode: 400 })
    expect(state.methods.put).not.toHaveBeenCalled()
  })

  it('refuses explicit public Content writes, copies, completion and ACL changes before SDK mutations', async () => {
    const storage = create_aliyun_oss(config)
    const key = 'content/att/must-stay-private'
    await expect(storage.put_object(key, new Uint8Array([1]), 'image/png', 'public')).rejects.toMatchObject({ statusCode: 400 })
    await expect(storage.copy_object('source', key, 'public')).rejects.toMatchObject({ statusCode: 400 })
    await expect(storage.complete_multipart_upload(key, 'upload', [{ part_number: 1, etag: 'part' }], 'public')).rejects.toMatchObject({ statusCode: 400 })
    await expect(storage.set_object_access(key, 'public')).rejects.toMatchObject({ statusCode: 400 })
    for (const name of ['put', 'copy', 'completeMultipartUpload', 'putACL'] as const)
      expect(state.methods[name]).not.toHaveBeenCalled()
  })

  it('passes private ACL on multipart completion and refuses duplicate parts', async () => {
    const storage = create_aliyun_oss(config)
    expect(await storage.create_multipart_upload('staging/key', 'image/png')).toBe('upload')
    expect(await storage.upload_part('staging/key', 'upload', 1, new Uint8Array([1, 2]))).toEqual({ part_number: 1, etag: 'part', size: 2 })
    const parts = [{ part_number: 1, etag: 'part' }]
    await storage.complete_multipart_upload('staging/key', 'upload', parts)
    expect(state.methods.completeMultipartUpload).toHaveBeenCalledWith('staging/key', 'upload', [{ number: 1, etag: 'part' }], { headers: { 'x-oss-object-acl': 'private', 'Cache-Control': 'private, no-store' } })
    state.methods.completeMultipartUpload.mockClear()
    await expect(storage.complete_multipart_upload('staging/key', 'upload', [... parts, ... parts])).rejects.toMatchObject({ statusCode: 400 })
    expect(state.methods.completeMultipartUpload).not.toHaveBeenCalled()
  })

  it('copies a fixed source with private ACL, cache metadata and original MIME type', async () => {
    // CopyObject's ETag is parsed from its XML body by the official SDK.
    state.methods.copy.mockResolvedValue({ data: { etag: '"copied"' }, res: { headers: { 'x-oss-version-id': 'copy-version' } } })
    expect(await create_aliyun_oss(config).copy_object('source', 'target')).toEqual({ etag: 'copied', version_id: 'copy-version' })
    expect(state.methods.copy).toHaveBeenCalledWith('target', 'source', { headers: expect.objectContaining({
      'x-oss-copy-source-if-match': '"source"', 'x-oss-object-acl': 'private',
      'Content-Type': 'image/png', 'Cache-Control': 'private, no-store',
    }) })
  })

  it('issues only a checksummed PUT for one upload ID, part number and length', async () => {
    state.methods.signatureUrlV4.mockResolvedValue('https://fixture.test/signed-part')
    const grant = await create_aliyun_oss(config).signed_part_upload('staging/key', 'upload-id', 3, 12, '1B2M2Y8AsgTpgAmY7PhCfg==', 900)
    expect(grant).toEqual({
      url: 'https://fixture.test/signed-part', method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-MD5': '1B2M2Y8AsgTpgAmY7PhCfg==', 'Content-Length': '12' },
    })
    expect(state.methods.signatureUrlV4).toHaveBeenCalledWith('PUT', 900, {
      headers: grant.headers, queries: { uploadId: 'upload-id', partNumber: '3' },
    }, 'staging/key', ['content-length'])
    expect(state.methods.put).not.toHaveBeenCalled()
    expect(state.methods.completeMultipartUpload).not.toHaveBeenCalled()
  })

  it.each([
    ['upload', 0, 12, '1B2M2Y8AsgTpgAmY7PhCfg==', 900],
    ['upload', 10001, 12, '1B2M2Y8AsgTpgAmY7PhCfg==', 900],
    ['upload', 1, 0, '1B2M2Y8AsgTpgAmY7PhCfg==', 900],
    ['upload', 1, 5 * 1024 ** 3 + 1, '1B2M2Y8AsgTpgAmY7PhCfg==', 900],
    ['', 1, 12, '1B2M2Y8AsgTpgAmY7PhCfg==', 900],
    ['upload\r\nheader', 1, 12, '1B2M2Y8AsgTpgAmY7PhCfg==', 900],
    ['upload', 1, 12, 'invalid', 900],
    ['upload', 1, 12, '1B2M2Y8AsgTpgAmY7PhCfg==', 604801],
    ['upload', 1, 12, '1B2M2Y8AsgTpgAmY7PhCfg==', 0],
  ] as const)('rejects invalid part grant arguments: %s %s %s %s %s', async (id, part, size, md5, ttl) => {
    await expect(create_aliyun_oss(config).signed_part_upload('staging/key', id, part, size, md5, ttl)).rejects.toMatchObject({ statusCode: 400 })
    expect(state.methods.signatureUrlV4).not.toHaveBeenCalled()
  })

  it('normalizes a one-part SDK XML result and preserves a progressing pagination cursor', async () => {
    const storage = create_aliyun_oss(config)
    state.methods.listParts.mockResolvedValue({
      parts: { PartNumber: '2', Size: '12', ETag: '"part-etag"' }, isTruncated: 'true', nextPartNumberMarker: '2',
    })
    expect(await storage.list_multipart_parts('staging/key', 'upload', 1)).toEqual({
      parts: [{ part_number: 2, size: 12, etag: 'part-etag' }], next_marker: 2,
    })
    expect(state.methods.listParts).toHaveBeenCalledWith('staging/key', 'upload', { 'max-parts': 1000, 'part-number-marker': 1, 'encoding-type': 'url' })
    state.methods.listParts.mockResolvedValue({ parts: [], isTruncated: 'false' })
    expect(await storage.list_multipart_parts('staging/key', 'upload')).toEqual({ parts: [], next_marker: null })
  })

  it.each([
    { parts: [{ PartNumber: '1', Size: '12', ETag: 'x' }], isTruncated: 'true', nextPartNumberMarker: '0' },
    { parts: [], isTruncated: 'true', nextPartNumberMarker: '1' },
    { parts: [{ PartNumber: '2', Size: '12', ETag: 'x' }, { PartNumber: '1', Size: '12', ETag: 'x' }], isTruncated: false },
    { parts: [{ PartNumber: '1', Size: '-1', ETag: 'x' }], isTruncated: false },
    { parts: [{ PartNumber: '1', Size: '12', ETag: '' }], isTruncated: false },
    { parts: [], isTruncated: 'unknown' },
  ])('refuses malformed part inventories instead of trusting a checkpoint: %j', async (inventory) => {
    state.methods.listParts.mockResolvedValue(inventory)
    await expect(create_aliyun_oss(config).list_multipart_parts('staging/key', 'upload')).rejects.toMatchObject({ statusCode: 502 })
  })

  it('uses bounded source ranges and private multipart completion for larger copies', async () => {
    const size = 130 * 1024 ** 2
    state.methods.getObjectMeta.mockResolvedValue(response({ 'etag': '"source"', 'content-length': String(size) }))
    await create_aliyun_oss(config).copy_object('source', 'target')
    expect(state.methods.copy).not.toHaveBeenCalled()
    expect(state.methods.uploadPartCopy.mock.calls.map(call => call[3])).toEqual(['0-67108863', '67108864-134217727', `134217728-${size - 1}`])
    expect(state.methods.uploadPartCopy.mock.calls.every(call => call[5].headers['x-oss-copy-source-if-match'] === '"source"')).toBe(true)
    expect(state.methods.initMultipartUpload.mock.calls[0]![1].mime).toBe('image/png')
    expect(state.methods.completeMultipartUpload.mock.calls[0]![3].headers['x-oss-object-acl']).toBe('private')
  })

  it('does not copy when source metadata changed and aborts a failed partial copy without deleting a target', async () => {
    const storage = create_aliyun_oss(config)
    state.methods.head.mockResolvedValueOnce(response({ etag: '"changed"' }))
    await expect(storage.copy_object('source', 'target')).rejects.toMatchObject({ statusCode: 409 })
    expect(state.methods.copy).not.toHaveBeenCalled()
    state.methods.getObjectMeta.mockResolvedValue(response({ 'etag': '"source"', 'content-length': String(65 * 1024 ** 2) }))
    const failure = new Error('part failed')
    state.methods.uploadPartCopy.mockRejectedValue(failure)
    await expect(storage.copy_object('source', 'target')).rejects.toBe(failure)
    expect(state.methods.abortMultipartUpload).toHaveBeenCalledWith('target', 'upload')
    expect(state.methods.delete).not.toHaveBeenCalled()
  })

  it('signs GET and HEAD separately, never binding issued URLs to historical OSS versions', async () => {
    const storage = create_aliyun_oss(config)
    await storage.signed_read_url('current', 3600)
    await storage.signed_read_url('current', 3600, 'HEAD')
    expect(state.methods.signatureUrlV4.mock.calls.map(call => call[0])).toEqual(['GET', 'HEAD'])
    for (const call of state.methods.signatureUrlV4.mock.calls) {
      expect(call[2]).toEqual({ queries: { 'response-cache-control': 'private, no-store' } })
      expect(call[3]).toBe('current')
    }
    await expect(storage.signed_read_url('current', 0)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('changes explicit object ACL and inheritance without copying or replacing the object', async () => {
    const storage = create_aliyun_oss(config)
    await storage.set_object_access('current', 'private')
    await storage.set_object_access('current', 'public')
    await storage.set_object_access('current', 'inherit')
    expect(state.methods.putACL.mock.calls).toEqual([['current', 'private'], ['current', 'public-read'], ['current', 'default']])
    expect(state.methods.copy).not.toHaveBeenCalled()
    expect(state.methods.delete).not.toHaveBeenCalled()
  })

  it('rejects recoverable deletion unless versioning is enabled', async () => {
    state.methods.getBucketVersioning.mockResolvedValue({ versionStatus: 'Suspended' })
    await expect(create_aliyun_oss(config).soft_delete_object('current')).rejects.toMatchObject({ statusCode: 409 })
    expect(state.methods.putACL).not.toHaveBeenCalled()
    expect(state.methods.delete).not.toHaveBeenCalled()
  })

  it('creates a delete marker without specifying versionId and verifies current reads are blocked', async () => {
    state.methods.delete.mockResolvedValue(response({ 'x-oss-delete-marker': 'true', 'x-oss-version-id': 'marker' }))
    state.methods.getObjectMeta.mockRejectedValue({ status: 404 })
    expect(await create_aliyun_oss(config).soft_delete_object('current')).toEqual({ delete_marker_version_id: 'marker' })
    expect(state.methods.putACL).toHaveBeenCalledWith('current', 'private')
    expect(state.methods.delete.mock.calls).toEqual([['current']])
  })

  it('does not report deletion success for a missing marker or a forbidden verification request', async () => {
    const storage = create_aliyun_oss(config)
    state.methods.delete.mockResolvedValueOnce(response())
    await expect(storage.soft_delete_object('current')).rejects.toMatchObject({ statusCode: 502 })
    state.methods.delete.mockResolvedValue(response({ 'x-oss-delete-marker': 'true' }))
    state.methods.getObjectMeta.mockRejectedValue({ status: 403 })
    await expect(storage.soft_delete_object('current')).rejects.toMatchObject({ status: 403 })
  })

  it('binds cancellation to a streamed body after headers arrive', async () => {
    const stream = new Readable({ read() {} })
    state.methods.getStream.mockResolvedValue({ stream, ... response({ 'content-length': '10' }) })
    const controller = new AbortController()
    const result = await create_aliyun_oss(config).get_object_stream('source', 'source', controller.signal)
    const failed = new Promise<Error>(resolve => stream.once('error', resolve))
    controller.abort()
    expect(await failed).toMatchObject({ name: 'AbortError' })
    expect(result.size).toBe(10)
    expect(stream.destroyed).toBe(true)
  })

  it('inspects bucket permissions, versioning and lifecycle without writes', async () => {
    state.methods.getBucketACL.mockResolvedValue({ acl: 'public-read' })
    state.methods.getBucketLifecycle.mockRejectedValue({ code: 'NoSuchLifecycle' })
    expect(await create_aliyun_oss(config).inspect_bucket()).toEqual({ acl: 'public-read', versioning: 'Enabled', lifecycle_rules: [] })
    expect(state.methods.put).not.toHaveBeenCalled()
    expect(state.methods.putACL).not.toHaveBeenCalled()
    expect(state.methods.delete).not.toHaveBeenCalled()
  })
})
