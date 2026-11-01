import type { create_aliyun_oss } from './aliyun-oss'
import type { ImageProcessingOptions } from './webp-image-processing'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { beforeEach, expect, it, vi } from 'vitest'
import { create_oss_image_processor } from './oss-image-processing'

const cloud = vi.hoisted(() => ({ getStream: vi.fn(), processObjectSave: vi.fn(), getBucketACL: vi.fn(), clients: [] as Record<string, unknown>[] }))
vi.mock('ali-oss', () => ({ default: class {
  getStream = cloud.getStream
  processObjectSave = cloud.processObjectSave
  getBucketACL = cloud.getBucketACL
  constructor(config: Record<string, unknown>) { cloud.clients.push(config) }
} }))
const config = { bucket: 'private-test', region: 'oss-cn-shenzhen', endpoint: 'https://oss-cn-shenzhen.aliyuncs.com', publicBaseUrl: 'https://edge.test', accessKeyId: 'test', accessKeySecret: 'test', timeoutMs: 20000, copyPartSizeMb: 64, uploadRoleArn: null }
const profile: ImageProcessingOptions = { maxInputBytes: 20971520, maxPixels: 9437184, webpQuality: 100, webpEffort: 4, jpegQuality: 85, jpegBackground: '#ffffff', lqipMaxDimension: 24, lqipQuality: 40, timeoutSeconds: 60 }
beforeEach(() => {
  vi.resetAllMocks()
  cloud.clients.length = 0
  cloud.getBucketACL.mockResolvedValue({ acl: 'private' })
})

async function fixture() {
  const bytes = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#339977' } }).png().toBuffer()
  const input = { key: 'content/att/staging/a/b', etag: 'source', version_id: 'v1', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const objects = new Map<string, { bytes: Buffer, etag: string, version_id: string }>([[input.key, { bytes, etag: input.etag, version_id: input.version_id }]])
  const prefix = `content/att/images/${'a'.repeat(32)}/${'b'.repeat(32)}`
  const storage = {
    head_object: vi.fn(async (key: string) => {
      const value = objects.get(key)
      if (! value)
        throw Object.assign(new Error('absent'), { status: 404 })
      return { etag: value.etag, version_id: value.version_id, size: value.bytes.length }
    }),
    get_object_access: vi.fn().mockResolvedValue('private'),
    set_object_access: vi.fn().mockResolvedValue(undefined),
    put_object: vi.fn(async (key: string, body: Buffer) => {
      const object = { bytes: body, etag: createHash('md5').update(body).digest('hex'), version_id: key }
      objects.set(key, object)
      return { etag: object.etag, version_id: key }
    }),
    get_object_stream: vi.fn(async (key: string) => ({ stream: Readable.from([objects.get(key)!.bytes]), size: objects.get(key)!.bytes.length })),
  }
  const transform = async (source: string, operation: string) => {
    const image = sharp(objects.get(source)!.bytes)
    return operation.includes('format,webp') ? image.webp({ quality: 100, effort: 0 }).toBuffer() : operation.includes('resize') ? image.resize({ width: 24, height: 24, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 40 }).toBuffer() : image.jpeg({ quality: 85 }).toBuffer()
  }
  cloud.getStream.mockImplementation(async (source: string, { process: operation }: { process: string }) => ({ res: { status: 200 }, stream: Readable.from([await transform(source, operation)]) }))
  cloud.processObjectSave.mockImplementation(async (source: string, target: string, operation: string) => {
    const body = await transform(source, operation)
    objects.set(target, { bytes: body, etag: createHash('md5').update(body).digest('hex'), version_id: target })
    return { status: 200 }
  })
  const controller = new AbortController()
  const request = { storage: storage as unknown as ReturnType<typeof create_aliyun_oss>, input, bytes, profile, prefix, signal: controller.signal, checkpoint: vi.fn().mockResolvedValue(undefined) }
  const run = () => create_oss_image_processor(config)(request)
  return { run, request, storage, objects, controller }
}

it('persists both roles inside OSS, verifies stored bytes once and only downloads transformed LQIP', async () => {
  const f = await fixture()
  const result = await f.run()
  expect(result).toMatchObject({ width: 32, height: 16, display: { key: `${f.request.prefix}.webp`, sha256: expect.stringMatching(/^[a-f\d]{64}$/) }, fallback: { key: `${f.request.prefix}.jpg` } })
  expect(cloud.processObjectSave.mock.calls).toEqual([
    [f.request.input.key, result.display.key, 'image/auto-orient,1/format,webp/quality,Q_100', config.bucket],
    [result.display.key, result.fallback.key, 'image/format,jpg/quality,Q_85', config.bucket],
  ])
  expect(cloud.getStream.mock.calls).toEqual([[result.display.key, { process: 'image/resize,m_lfit,w_24,h_24,limit_1/format,jpg/quality,Q_40', headers: { 'If-Match': `"${result.display.etag}"` } }]])
  expect(f.storage.put_object).not.toHaveBeenCalled()
  expect(f.storage.get_object_stream.mock.calls.map(call => call[0])).toEqual([result.display.key, result.fallback.key])
  for (const object of [result.display, result.fallback]) {
    expect(f.storage.set_object_access).toHaveBeenCalledWith(object.key, 'private')
    expect(object.sha256).toBe(createHash('sha256').update(f.objects.get(object.key)!.bytes).digest('hex'))
  }
  expect(cloud.clients[0]).toMatchObject({ secure: true, authorizationV4: true, retryMax: 0, timeout: 20000 })
  expect(await sharp(result.lqip).metadata()).toMatchObject({ format: 'jpeg', width: 24, height: 12 })
})

it('rejects public output ACLs before dependent conversion or publication', async () => {
  const f = await fixture()
  f.storage.get_object_access.mockImplementation(async (key?: string) => key?.endsWith('.webp') ? 'public-read' : 'private')
  await expect(f.run()).rejects.toThrow('来源校验失败')
  expect(cloud.processObjectSave).toHaveBeenCalledOnce()
})

it('rejects resolved HTTP errors and never proceeds to a dependent output', async () => {
  const f = await fixture()
  cloud.processObjectSave.mockResolvedValue({ status: 500 })
  await expect(f.run()).rejects.toThrow('持久化请求失败')
  expect(cloud.processObjectSave).toHaveBeenCalledOnce()
  expect(cloud.getStream).not.toHaveBeenCalled()
  expect(f.storage.put_object).not.toHaveBeenCalled()
})

it('stops after a sent write if cancellation arrives and leaves its owned target for ledger cleanup', async () => {
  const f = await fixture()
  const write = cloud.processObjectSave.getMockImplementation()!
  cloud.processObjectSave.mockImplementationOnce(async (... args) => {
    const value = await write(... args)
    f.controller.abort()
    return value
  })
  await expect(f.run()).rejects.toThrow()
  expect(cloud.processObjectSave).toHaveBeenCalledOnce()
  expect(f.storage.set_object_access).toHaveBeenCalledWith(`${f.request.prefix}.webp`, 'private')
  expect(f.storage.put_object).not.toHaveBeenCalled()
  expect(f.objects.has(`${f.request.prefix}.webp`)).toBe(true)
})

it('rejects a changed input identity before submitting processing', async () => {
  const f = await fixture()
  f.objects.get(f.request.input.key)!.version_id = 'replacement'
  await expect(f.run()).rejects.toThrow('来源校验失败')
  expect(cloud.processObjectSave).not.toHaveBeenCalled()
})

it('does not expose SDK errors containing request credentials', async () => {
  const f = await fixture()
  cloud.processObjectSave.mockRejectedValue(new Error('sensitive signed-url credential'))
  await expect(f.run()).rejects.toThrow('云端图片处理失败，请重试或联系管理员')
})

it('rejects oversized real headers before any cloud side effect', async () => {
  const f = await fixture()
  const bytes = await sharp({ create: { width: 4097, height: 1, channels: 3, background: '#fff' } }).png().toBuffer()
  f.request.bytes = bytes
  Object.assign(f.request.input, { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  await expect(f.run()).rejects.toThrow('4096px')
  expect(cloud.processObjectSave).not.toHaveBeenCalled()
})

it('bounds the LQIP response before buffering an excessive result', async () => {
  const f = await fixture()
  const get = cloud.getStream.getMockImplementation()!
  cloud.getStream.mockImplementation(async (key: string, options: { process: string }) => options.process.includes('resize')
    ? { res: { status: 200 }, stream: Readable.from([Buffer.alloc(8193)]) }
    : get(key, options))
  await expect(f.run()).rejects.toThrow('超过处理大小上限')
  expect(cloud.processObjectSave).toHaveBeenCalledTimes(2)
  expect(f.storage.put_object).not.toHaveBeenCalled()
})

it('rejects a source replaced during native conversion and leaves its owned result private', async () => {
  const f = await fixture()
  const get = cloud.processObjectSave.getMockImplementation()!
  cloud.processObjectSave.mockImplementationOnce(async (... args) => {
    const response = await get(... args)
    f.objects.get(f.request.input.key)!.version_id = 'replaced-during-get'
    return response
  })
  await expect(f.run()).rejects.toThrow('来源校验失败')
  expect(cloud.processObjectSave).toHaveBeenCalledOnce()
  expect(f.storage.set_object_access).toHaveBeenCalledWith(`${f.request.prefix}.webp`, 'private')
  expect(f.storage.put_object).not.toHaveBeenCalled()
})

it('rejects public buckets before creating any result', async () => {
  const f = await fixture()
  cloud.getBucketACL.mockResolvedValue({ acl: 'public-read' })
  await expect(f.run()).rejects.toThrow('目标桶为私有')
  expect(cloud.processObjectSave).not.toHaveBeenCalled()
})

it('rechecks private bucket ACL before the dependent JPEG save', async () => {
  const f = await fixture()
  cloud.getBucketACL.mockResolvedValueOnce({ acl: 'private' }).mockResolvedValueOnce({ acl: 'public-read' })
  await expect(f.run()).rejects.toThrow('目标桶为私有')
  expect(cloud.processObjectSave).toHaveBeenCalledOnce()
})

it('refuses to overwrite an existing attempt target', async () => {
  const f = await fixture()
  f.objects.set(`${f.request.prefix}.webp`, f.objects.get(f.request.input.key)!)
  await expect(f.run()).rejects.toThrow('目标已存在')
  expect(cloud.processObjectSave).not.toHaveBeenCalled()
})

it('does not repeat a POST whose acknowledgement was lost', async () => {
  const f = await fixture()
  const write = cloud.processObjectSave.getMockImplementation()!
  cloud.processObjectSave.mockImplementationOnce(async (... args) => {
    await write(... args)
    throw new Error('unknown result')
  })
  await expect(f.run()).rejects.toThrow('云端图片处理失败')
  expect(cloud.processObjectSave).toHaveBeenCalledOnce()
  expect(f.objects.has(`${f.request.prefix}.webp`)).toBe(true)
  expect(f.storage.put_object).not.toHaveBeenCalled()
})

it('rejects target replacement during stored-byte verification', async () => {
  const f = await fixture()
  f.storage.get_object_stream.mockImplementationOnce(async (key: string) => ({ size: f.objects.get(key)!.bytes.length, stream: Readable.from((async function* () {
    yield f.objects.get(key)!.bytes
    f.objects.get(key)!.version_id = 'replaced'
  })()) }))
  await expect(f.run()).rejects.toThrow('来源校验失败')
  expect(cloud.processObjectSave).toHaveBeenCalledOnce()
})

it.each(['format', 'dimensions', 'version'])('rejects invalid persisted %s', async (kind) => {
  const f = await fixture()
  const write = cloud.processObjectSave.getMockImplementation()!
  cloud.processObjectSave.mockImplementationOnce(async (... args) => {
    const response = await write(... args)
    const object = f.objects.get(`${f.request.prefix}.webp`)!
    if (kind === 'format')
      object.bytes = f.request.bytes
    if (kind === 'dimensions')
      object.bytes = await sharp(f.request.bytes).resize(1, 1).webp().toBuffer()
    if (kind === 'version')
      Object.assign(object, { version_id: null })
    return response
  })
  await expect(f.run()).rejects.toThrow('来源校验失败')
  expect(cloud.processObjectSave).toHaveBeenCalledOnce()
})

it('bounds persisted output before downloading it', async () => {
  const f = await fixture()
  const head = f.storage.head_object.getMockImplementation()!
  f.storage.head_object.mockImplementation(async (key: string) => {
    const value = await head(key)
    return key.endsWith('.webp') ? { ... value, size: profile.maxInputBytes + 1 } : value
  })
  await expect(f.run()).rejects.toThrow('来源校验失败')
  expect(f.storage.get_object_stream).not.toHaveBeenCalled()
})

it('rejects truncated persisted reads', async () => {
  const f = await fixture()
  f.storage.get_object_stream.mockImplementationOnce(async (key: string) => ({ size: f.objects.get(key)!.bytes.length, stream: Readable.from([Buffer.from('short')]) }))
  await expect(f.run()).rejects.toThrow('来源校验失败')
  expect(cloud.processObjectSave).toHaveBeenCalledOnce()
})

it('reports missing persistence permissions without exposing SDK credentials', async () => {
  const f = await fixture()
  cloud.getBucketACL.mockRejectedValue(Object.assign(new Error('sensitive credential'), { status: 403 }))
  await expect(f.run()).rejects.toThrow('持久化权限尚未配置')
  expect(cloud.processObjectSave).not.toHaveBeenCalled()
})

it('reports a resolved native 403 as a configuration error without retrying', async () => {
  const f = await fixture()
  cloud.processObjectSave.mockResolvedValue({ status: 403 })
  await expect(f.run()).rejects.toMatchObject({ statusCode: 503, message: 'OSS 图片持久化权限尚未配置，请联系管理员' })
  expect(cloud.processObjectSave).toHaveBeenCalledOnce()
  expect(f.storage.get_object_stream).not.toHaveBeenCalled()
  expect(f.storage.put_object).not.toHaveBeenCalled()
})
