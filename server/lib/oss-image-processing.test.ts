import type { create_aliyun_oss } from './aliyun-oss'
import type { ImageProcessingOptions } from './image-processing'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { beforeEach, expect, it, vi } from 'vitest'
import { create_oss_image_processor } from './oss-image-processing'

const cloud = vi.hoisted(() => ({ getStream: vi.fn(), clients: [] as Record<string, unknown>[] }))
vi.mock('ali-oss', () => ({ default: class {
  getStream = cloud.getStream
  constructor(config: Record<string, unknown>) { cloud.clients.push(config) }
} }))
const config = { bucket: 'private-test', region: 'oss-cn-shenzhen', endpoint: 'https://oss-cn-shenzhen.aliyuncs.com', publicBaseUrl: 'https://edge.test', accessKeyId: 'test', accessKeySecret: 'test', timeoutMs: 20000, copyPartSizeMb: 64, uploadRoleArn: null }
const profile: ImageProcessingOptions = { maxInputBytes: 20971520, maxPixels: 9437184, avifQuality: 100, avifEffort: 4, jpegQuality: 85, jpegBackground: '#ffffff', lqipMaxDimension: 24, lqipQuality: 40, timeoutSeconds: 60 }
beforeEach(() => {
  vi.resetAllMocks()
  cloud.clients.length = 0
})

async function fixture() {
  const bytes = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#339977' } }).png().toBuffer()
  const input = { key: 'content/att/staging/a/b', etag: 'source', version_id: 'v1', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const objects = new Map<string, { bytes: Buffer, etag: string, version_id: string }>([[input.key, { bytes, etag: input.etag, version_id: input.version_id }]])
  const prefix = `content/att/images/${'a'.repeat(32)}/${'b'.repeat(32)}`
  const storage = {
    head_object: vi.fn(async (key: string) => {
      const value = objects.get(key)!
      return { etag: value.etag, version_id: value.version_id, size: value.bytes.length }
    }),
    get_object_access: vi.fn().mockResolvedValue('private'),
    put_object: vi.fn(async (key: string, body: Buffer) => {
      const object = { bytes: body, etag: createHash('md5').update(body).digest('hex'), version_id: key }
      objects.set(key, object)
      return { etag: object.etag, version_id: key }
    }),
    get_object_stream: vi.fn(async (key: string) => ({ stream: Readable.from([objects.get(key)!.bytes]), size: objects.get(key)!.bytes.length })),
  }
  cloud.getStream.mockImplementation(async (source: string, { process: operation }: { process: string }) => {
    const image = sharp(objects.get(source)!.bytes)
    const bytes = operation.includes('format,avif') ? await image.avif({ effort: 0 }).toBuffer() : operation.includes('resize') ? await image.resize({ width: 24, height: 24, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 40 }).toBuffer() : await image.jpeg().toBuffer()
    return { res: { status: 200 }, stream: Readable.from([bytes]) }
  })
  const controller = new AbortController()
  const request = { storage: storage as unknown as ReturnType<typeof create_aliyun_oss>, input, bytes, profile, prefix, signal: controller.signal, checkpoint: vi.fn().mockResolvedValue(undefined) }
  const run = () => create_oss_image_processor(config)(request)
  return { run, request, storage, objects, controller }
}

it('persists both roles and derives JPEG/LQIP from the verified final AVIF using server credentials', async () => {
  const f = await fixture()
  const result = await f.run()
  expect(result).toMatchObject({ width: 32, height: 16, avif: { key: `${f.request.prefix}.avif`, sha256: expect.stringMatching(/^[a-f\d]{64}$/) }, jpeg: { key: `${f.request.prefix}.jpg` } })
  expect(cloud.getStream.mock.calls).toEqual([
    [f.request.input.key, { process: 'image/auto-orient,1/format,avif/quality,Q_100', headers: { 'If-Match': '"source"' } }],
    [result.avif.key, { process: 'image/format,jpg/quality,Q_85', headers: { 'If-Match': `"${result.avif.etag}"` } }],
    [result.avif.key, { process: 'image/resize,m_lfit,w_24,h_24,limit_1/format,jpg/quality,Q_40', headers: { 'If-Match': `"${result.avif.etag}"` } }],
  ])
  expect(f.storage.put_object.mock.calls.map(call => call[0])).toEqual([result.avif.key, result.jpeg.key])
  expect(f.storage.put_object).toHaveBeenCalledWith(result.avif.key, expect.any(Buffer), 'image/avif', 'private')
  expect(cloud.clients[0]).toMatchObject({ secure: true, authorizationV4: true, timeout: 20000 })
  expect(await sharp(result.lqip).metadata()).toMatchObject({ format: 'jpeg', width: 24, height: 12 })
})

it('rejects public output ACLs before dependent conversion or publication', async () => {
  const f = await fixture()
  f.storage.get_object_access.mockImplementation(async (key?: string) => key?.endsWith('.avif') ? 'public-read' : 'private')
  await expect(f.run()).rejects.toThrow('来源校验失败')
  expect(cloud.getStream).toHaveBeenCalledOnce()
})

it('rejects resolved HTTP errors and never proceeds to a dependent output', async () => {
  const f = await fixture()
  cloud.getStream.mockResolvedValue({ res: { status: 403 }, stream: Readable.from(['denied']) })
  await expect(f.run()).rejects.toThrow('处理请求失败')
  expect(cloud.getStream).toHaveBeenCalledOnce()
  expect(f.storage.put_object).not.toHaveBeenCalled()
})

it('stops after a sent write if cancellation arrives and leaves its owned target for ledger cleanup', async () => {
  const f = await fixture()
  const write = f.storage.put_object.getMockImplementation()!
  f.storage.put_object.mockImplementationOnce(async (... args) => {
    const value = await write(... args)
    f.controller.abort()
    return value
  })
  await expect(f.run()).rejects.toThrow()
  expect(cloud.getStream).toHaveBeenCalledOnce()
  expect(f.storage.put_object).toHaveBeenCalledOnce()
  expect(f.objects.has(`${f.request.prefix}.avif`)).toBe(true)
})

it('rejects a changed input identity before submitting processing', async () => {
  const f = await fixture()
  f.objects.get(f.request.input.key)!.version_id = 'replacement'
  await expect(f.run()).rejects.toThrow('来源校验失败')
  expect(cloud.getStream).not.toHaveBeenCalled()
})

it('does not expose SDK errors containing request credentials', async () => {
  const f = await fixture()
  cloud.getStream.mockRejectedValue(new Error('sensitive signed-url credential'))
  await expect(f.run()).rejects.toThrow('云端图片处理失败，请重试或联系管理员')
})

it('rejects oversized real headers before any cloud side effect', async () => {
  const f = await fixture()
  const bytes = await sharp({ create: { width: 4097, height: 1, channels: 3, background: '#fff' } }).png().toBuffer()
  f.request.bytes = bytes
  Object.assign(f.request.input, { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  await expect(f.run()).rejects.toThrow('4096px')
  expect(cloud.getStream).not.toHaveBeenCalled()
})

it('bounds the LQIP response before buffering an excessive result', async () => {
  const f = await fixture()
  const get = cloud.getStream.getMockImplementation()!
  cloud.getStream.mockImplementation(async (key: string, options: { process: string }) => options.process.includes('resize')
    ? { res: { status: 200 }, stream: Readable.from([Buffer.alloc(8193)]) }
    : get(key, options))
  await expect(f.run()).rejects.toThrow('超过处理大小上限')
  expect(f.storage.put_object).toHaveBeenCalledTimes(2)
})

it('rejects a source replaced during conversion before persisting its result', async () => {
  const f = await fixture()
  const get = cloud.getStream.getMockImplementation()!
  cloud.getStream.mockImplementationOnce(async (... args) => {
    const response = await get(... args)
    f.objects.get(f.request.input.key)!.version_id = 'replaced-during-get'
    return response
  })
  await expect(f.run()).rejects.toThrow('来源校验失败')
  expect(f.storage.put_object).not.toHaveBeenCalled()
})
