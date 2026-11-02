import type { create_aliyun_oss } from './aliyun-oss'
import type { OssImageProcessingOptions } from './oss-image-processing'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { beforeEach, expect, it, vi } from 'vitest'
import { copy_oss_image_original, create_oss_image_processor } from './oss-image-processing'

const cloud = vi.hoisted(() => ({ getStream: vi.fn(), processObjectSave: vi.fn(), getBucketACL: vi.fn(), head: vi.fn(), copy: vi.fn(), clients: [] as Record<string, unknown>[] }))
vi.mock('ali-oss', () => ({ default: class {
  getStream = cloud.getStream
  processObjectSave = cloud.processObjectSave
  getBucketACL = cloud.getBucketACL
  head = cloud.head
  copy = cloud.copy
  constructor(config: Record<string, unknown>) { cloud.clients.push(config) }
} }))
const config = { bucket: 'private-test', region: 'oss-cn-shenzhen', endpoint: 'https://oss-cn-shenzhen.aliyuncs.com', publicBaseUrl: 'https://edge.test', accessKeyId: 'test', accessKeySecret: 'test', timeoutMs: 20000, copyPartSizeMb: 64, uploadRoleArn: null }
const profile: OssImageProcessingOptions = { maxInputBytes: 20971520, maxPixels: 9437184, webpQuality: 100, webpEffort: 4, jpegQuality: 85, jpegBackground: '#ffffff', lqipMaxDimension: 24, lqipQuality: 40, timeoutSeconds: 60 }
beforeEach(() => {
  vi.resetAllMocks()
  cloud.clients.length = 0
  cloud.getBucketACL.mockResolvedValue({ acl: 'private' })
})

async function fixture() {
  const bytes = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#339977' } }).png().toBuffer()
  const input = { key: 'content/att/staging/a/b', etag: 'source', version_id: 'v1', size: bytes.length, sha256: null }
  const objects = new Map<string, { bytes: Buffer, etag: string, version_id: string }>([[input.key, { bytes, etag: input.etag, version_id: input.version_id }]])
  const overrides = new Map<string, Record<string, string>>()
  const prefix = `content/att/images/${'a'.repeat(32)}/${'b'.repeat(32)}`
  const original = `content/att/originals/${'a'.repeat(32)}/${'b'.repeat(32)}`
  const storage = {
    head_object: vi.fn(async (key: string) => {
      const value = objects.get(key)
      if (! value)
        throw Object.assign(new Error('absent'), { status: 404 })
      return { etag: value.etag, version_id: value.version_id, size: value.bytes.length }
    }),
    get_object_access: vi.fn().mockResolvedValue('private'),
    set_object_access: vi.fn().mockResolvedValue(undefined),
    put_object: vi.fn(async () => { throw new Error('Unexpected application upload') }),
    get_object_stream: vi.fn(async () => { throw new Error('Unexpected full image read') }),
  }
  const transform = async (source: string, operation: string) => {
    const image = sharp(objects.get(source)!.bytes).rotate()
    return operation.includes('format,webp')
      ? image.webp({ quality: 100, effort: 0 }).toBuffer()
      : operation.includes('resize')
        ? image.resize({ width: 24, height: 24, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#fff' }).jpeg({ quality: 40 }).toBuffer()
        : image.flatten({ background: '#fff' }).jpeg({ quality: 85 }).toBuffer()
  }
  cloud.getStream.mockImplementation(async (source: string, { process: operation }: { process: string }) => {
    let body: Buffer
    if (operation === 'image/info') {
      const value = objects.get(source)!
      const meta = await sharp(value.bytes).metadata()
      const info = { FileSize: String(value.bytes.length), Format: meta.format === 'jpeg' ? 'jpg' : meta.format!, FrameCount: String(meta.pages ?? 1), ImageWidth: String(meta.width), ImageHeight: String(meta.height), ... (meta.orientation ? { Orientation: String(meta.orientation) } : {}), ... overrides.get(source) }
      body = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(info).map(([key, value]) => [key, { value }]))))
    }
    else {
      body = await transform(source, operation)
    }
    return { res: { status: 200 }, stream: Readable.from([body]) }
  })
  cloud.processObjectSave.mockImplementation(async (source: string, target: string, operation: string) => {
    const body = await transform(source, operation)
    objects.set(target, { bytes: body, etag: createHash('md5').update(body).digest('hex'), version_id: target })
    return { status: 200 }
  })
  cloud.head.mockImplementation(async (key: string) => {
    const value = objects.get(key)!
    return { res: { headers: { 'etag': `"${value.etag}"`, 'x-oss-version-id': value.version_id, 'content-length': String(value.bytes.length), 'content-type': 'image/png' } } }
  })
  cloud.copy.mockImplementation(async (target: string, source: string) => {
    const value = objects.get(source)!
    objects.set(target, { ... value, bytes: Buffer.from(value.bytes), version_id: target })
    return { res: { status: 200, headers: { 'etag': `"${value.etag}"`, 'x-oss-copy-source-version-id': value.version_id, 'x-oss-version-id': target } } }
  })
  const controller = new AbortController()
  const request = { storage: storage as unknown as ReturnType<typeof create_aliyun_oss>, input, profile, prefix, signal: controller.signal, checkpoint: vi.fn().mockResolvedValue(undefined), require_png: false }
  return { run: () => create_oss_image_processor(config)(request), archive: () => copy_oss_image_original(request.storage, input, original, controller.signal, config), request, storage, objects, overrides, controller, original }
}

it('persists WebP/JPEG in OSS and only reads bounded info JSON plus the small LQIP', async () => {
  const f = await fixture()
  const result = await f.run()
  expect(result).toMatchObject({ width: 32, height: 16, display: { key: `${f.request.prefix}.webp`, sha256: null }, fallback: { key: `${f.request.prefix}.jpg`, sha256: null } })
  expect(cloud.processObjectSave.mock.calls).toEqual([
    [f.request.input.key, result.display.key, 'image/auto-orient,1/format,webp/quality,Q_100', config.bucket],
    [result.display.key, result.fallback.key, 'image/format,jpg/quality,Q_85', config.bucket],
  ])
  expect(cloud.getStream.mock.calls.map(call => [call[0], call[1].process])).toEqual([
    [f.request.input.key, 'image/info'], [result.display.key, 'image/info'], [result.fallback.key, 'image/info'],
    [result.display.key, 'image/resize,m_lfit,w_24,h_24,limit_1/format,jpg/quality,Q_40'],
  ])
  expect(f.storage.put_object).not.toHaveBeenCalled()
  expect(f.storage.get_object_stream).not.toHaveBeenCalled()
  for (const object of [result.display, result.fallback])
    expect(f.storage.set_object_access).toHaveBeenCalledWith(object.key, 'private')
  expect(cloud.clients[0]).toMatchObject({ secure: true, authorizationV4: true, retryMax: 0, timeout: 20000 })
  expect(await sharp(result.lqip).metadata()).toMatchObject({ format: 'jpeg', width: 24, height: 12 })
})

it('bounds OSS round trips for conversion plus archive while retaining both write preflights and the final checks', async () => {
  const f = await fixture()
  await Promise.all([f.run(), f.archive()])
  const count = [f.storage.head_object, f.storage.get_object_access, f.storage.set_object_access,
    cloud.getStream, cloud.getBucketACL, cloud.processObjectSave, cloud.head, cloud.copy]
    .reduce((total, request) => total + request.mock.calls.length, 0)
  expect(count).toBeLessThanOrEqual(36)
  expect(cloud.getBucketACL).toHaveBeenCalledTimes(2)
  expect(cloud.processObjectSave).toHaveBeenCalledTimes(2)
  expect(cloud.copy).toHaveBeenCalledOnce()
})

it.each(['public-input', 'public-output', 'replaced-input'])('rejects unsafe %s before publication', async (fault) => {
  const f = await fixture()
  if (fault === 'replaced-input')
    f.objects.get(f.request.input.key)!.version_id = 'replacement'
  else
    f.storage.get_object_access.mockImplementation(async (key?: string) => (fault === 'public-input' ? key === f.request.input.key : key?.endsWith('.webp')) ? 'public-read' : 'private')
  await expect(f.run()).rejects.toThrow('来源校验失败')
  expect(cloud.processObjectSave.mock.calls.length).toBe(fault === 'public-output' ? 1 : 0)
})

it.each(['Format', 'FrameCount', 'ImageWidth', 'FileSize'])('rejects unsafe source %s metadata before conversion', async (field) => {
  const f = await fixture()
  f.overrides.set(f.request.input.key, { [field]: ({ Format: 'svg', FrameCount: '2', ImageWidth: '4097', FileSize: '1' })[field]! })
  await expect(f.run()).rejects.toThrow()
  expect(cloud.processObjectSave).not.toHaveBeenCalled()
  expect(f.storage.get_object_stream).not.toHaveBeenCalled()
})

it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])('accepts JPEG EXIF orientation %s with the expected display dimensions', async (orientation) => {
  const f = await fixture()
  const source = f.objects.get(f.request.input.key)!
  source.bytes = await sharp(source.bytes).withMetadata({ orientation: orientation || 1 }).jpeg().toBuffer()
  f.request.input.size = source.bytes.length
  f.overrides.set(f.request.input.key, { Orientation: String(orientation) })
  const result = await f.run()
  expect(result).toMatchObject(orientation >= 5 ? { width: 16, height: 32 } : { width: 32, height: 16 })
  expect(cloud.processObjectSave).toHaveBeenCalledTimes(2)
  expect(f.storage.get_object_stream).not.toHaveBeenCalled()
})

it.each(['-1', '9', '1.5', '', 'unknown'])('rejects malformed orientation %j before conversion', async (orientation) => {
  const f = await fixture()
  f.overrides.set(f.request.input.key, { Orientation: orientation })
  await expect(f.run()).rejects.toMatchObject({ statusCode: 409 })
  expect(cloud.processObjectSave).not.toHaveBeenCalled()
})

it.each(['FileSize', 'FrameCount', 'ImageWidth', 'ImageHeight'])('still rejects zero %s metadata before conversion', async (field) => {
  const f = await fixture()
  f.overrides.set(f.request.input.key, { [field]: '0' })
  await expect(f.run()).rejects.toMatchObject({ statusCode: 409 })
  expect(cloud.processObjectSave).not.toHaveBeenCalled()
})

it('checks edited input is actually PNG using OSS information', async () => {
  const f = await fixture()
  f.request.require_png = true
  f.overrides.set(f.request.input.key, { Format: 'jpg' })
  await expect(f.run()).rejects.toThrow('图片编辑输出必须为无损 PNG')
  expect(cloud.processObjectSave).not.toHaveBeenCalled()
})

it.each(['info', 'lqip'])('bounds the %s response before excessive buffering', async (kind) => {
  const f = await fixture()
  const get = cloud.getStream.getMockImplementation()!
  cloud.getStream.mockImplementation(async (key: string, options: { process: string }) => (kind === 'info' ? options.process === 'image/info' : options.process.includes('resize'))
    ? { res: { status: 200 }, stream: Readable.from([Buffer.alloc(kind === 'info' ? 32769 : 8193)]) }
    : get(key, options))
  await expect(f.run()).rejects.toThrow('超过大小上限')
  expect(f.storage.get_object_stream).not.toHaveBeenCalled()
})

it('rejects malformed info without exposing its raw contents', async () => {
  const f = await fixture()
  cloud.getStream.mockResolvedValueOnce({ res: { status: 200 }, stream: Readable.from([Buffer.from('sensitive raw response')]) })
  await expect(f.run()).rejects.toThrow('云端图片信息无效')
})

it.each(['format', 'dimensions', 'version'])('rejects invalid persisted %s without downloading the image', async (kind) => {
  const f = await fixture()
  const write = cloud.processObjectSave.getMockImplementation()!
  cloud.processObjectSave.mockImplementationOnce(async (... args) => {
    const response = await write(... args)
    if (kind === 'version')
      f.objects.get(`${f.request.prefix}.webp`)!.version_id = ''
    else
      f.overrides.set(`${f.request.prefix}.webp`, kind === 'format' ? { Format: 'png' } : { ImageWidth: '1' })
    return response
  })
  await expect(f.run()).rejects.toThrow('来源校验失败')
  expect(cloud.processObjectSave).toHaveBeenCalledOnce()
  expect(f.storage.get_object_stream).not.toHaveBeenCalled()
})

it('rejects target replacement during information lookup', async () => {
  const f = await fixture()
  const get = cloud.getStream.getMockImplementation()!
  cloud.getStream.mockImplementation(async (key: string, options: { process: string }) => {
    const result = await get(key, options)
    if (key.endsWith('.webp') && options.process === 'image/info')
      f.objects.get(key)!.version_id = 'replacement'
    return result
  })
  await expect(f.run()).rejects.toThrow('来源校验失败')
  expect(cloud.processObjectSave).toHaveBeenCalledOnce()
})

it.each(['input', 'display', 'fallback'].flatMap(role => ['version', 'acl', 'size'].map(fault => ({ role, fault }))))('rejects late $role $fault changes at the final boundary', async ({ role, fault }) => {
  const f = await fixture()
  const key = role === 'input' ? f.request.input.key : `${f.request.prefix}.${role === 'display' ? 'webp' : 'jpg'}`
  const get = cloud.getStream.getMockImplementation()!
  cloud.getStream.mockImplementation(async (source: string, options: { process: string }) => {
    const response = await get(source, options)
    if (options.process.includes('resize')) {
      if (fault === 'version')
        f.objects.get(key)!.version_id = 'late-replacement'
      else if (fault === 'size')
        f.objects.get(key)!.bytes = Buffer.concat([f.objects.get(key)!.bytes, Buffer.from([0])])
      else
        f.storage.get_object_access.mockImplementation(async (source?: string) => source === key ? 'public-read' : 'private')
    }
    return response
  })
  await expect(f.run()).rejects.toMatchObject({ statusCode: 409 })
  expect(f.storage.get_object_stream).not.toHaveBeenCalled()
})

it('rejects a source changed during native processing even when the persisted roles are otherwise valid', async () => {
  const f = await fixture()
  const write = cloud.processObjectSave.getMockImplementation()!
  cloud.processObjectSave.mockImplementationOnce(async (... args) => {
    const result = await write(... args)
    f.objects.get(f.request.input.key)!.version_id = 'changed-during-save'
    return result
  })
  await expect(f.run()).rejects.toMatchObject({ statusCode: 409 })
})

it('rejects an expired lease at the final boundary despite reusable intermediate identities', async () => {
  const f = await fixture()
  const get = cloud.getStream.getMockImplementation()!
  cloud.getStream.mockImplementation(async (source: string, options: { process: string }) => {
    const response = await get(source, options)
    if (options.process.includes('resize'))
      f.request.checkpoint.mockRejectedValue(new Error('lease expired'))
    return response
  })
  await expect(f.run()).rejects.toThrow('云端图片处理失败')
})

it('does not start a native save after the lease expires during its preflight', async () => {
  const f = await fixture()
  f.request.checkpoint.mockImplementation(async () => {
    if (cloud.getBucketACL.mock.calls.length)
      throw new Error('lease expired')
  })
  await expect(f.run()).rejects.toThrow('云端图片处理失败')
  expect(cloud.processObjectSave).not.toHaveBeenCalled()
})

it('pins a completed native write private before honoring cancellation', async () => {
  const f = await fixture()
  const write = cloud.processObjectSave.getMockImplementation()!
  cloud.processObjectSave.mockImplementationOnce(async (... args) => {
    const result = await write(... args)
    f.controller.abort()
    return result
  })
  await expect(f.run()).rejects.toThrow()
  expect(f.storage.set_object_access).toHaveBeenCalledWith(`${f.request.prefix}.webp`, 'private')
  expect(cloud.processObjectSave).toHaveBeenCalledOnce()
})

it('does not repeat a POST whose acknowledgement was lost', async () => {
  const f = await fixture()
  const write = cloud.processObjectSave.getMockImplementation()!
  cloud.processObjectSave.mockImplementationOnce(async (... args) => {
    await write(... args)
    throw new Error('sensitive signed request')
  })
  await expect(f.run()).rejects.toThrow('云端图片处理失败，请重试或联系管理员')
  expect(cloud.processObjectSave).toHaveBeenCalledOnce()
  expect(f.objects.has(`${f.request.prefix}.webp`)).toBe(true)
})

it('requires a private bucket before each native save and refuses an existing target', async () => {
  const f = await fixture()
  cloud.getBucketACL.mockResolvedValueOnce({ acl: 'private' }).mockResolvedValueOnce({ acl: 'public-read' })
  await expect(f.run()).rejects.toThrow('目标桶为私有')
  expect(cloud.processObjectSave).toHaveBeenCalledOnce()
  const another = await fixture()
  another.objects.set(`${another.request.prefix}.webp`, another.objects.get(another.request.input.key)!)
  await expect(another.run()).rejects.toThrow('目标已存在')
})

it.each(['thrown', 'resolved'])('controls %s persistence permission errors', async (kind) => {
  const f = await fixture()
  if (kind === 'thrown')
    cloud.getBucketACL.mockRejectedValue(Object.assign(new Error('sensitive credential'), { status: 403 }))
  else
    cloud.processObjectSave.mockResolvedValue({ status: 403 })
  await expect(f.run()).rejects.toMatchObject({ statusCode: 503, message: 'OSS 图片持久化权限尚未配置，请联系管理员' })
})

it('archives by a conditional private native copy without application image reads', async () => {
  const f = await fixture()
  const result = await f.archive()
  expect(result).toMatchObject({ key: f.original, size: f.request.input.size, version_id: f.original, sha256: null })
  expect(cloud.copy).toHaveBeenCalledWith(f.original, f.request.input.key, { headers: expect.objectContaining({ 'x-oss-copy-source-if-match': '"source"', 'x-oss-object-acl': 'private', 'Cache-Control': 'private, no-store' }) })
  expect(f.storage.get_object_stream).not.toHaveBeenCalled()
  expect(cloud.getStream).not.toHaveBeenCalled()
})

it.each(['version', 'size', 'etag', 'acl'])('refuses an invalid archive source %s before sending the copy', async (kind) => {
  const f = await fixture()
  const head = cloud.head.getMockImplementation()!
  cloud.head.mockImplementationOnce(async (key: string) => {
    const result = await head(key)
    if (kind === 'version')
      result.res.headers['x-oss-version-id'] = ''
    if (kind === 'etag')
      result.res.headers.etag = '"changed"'
    if (kind === 'size')
      result.res.headers['content-length'] = 'NaN'
    return result
  })
  if (kind === 'acl')
    f.storage.get_object_access.mockResolvedValue('public-read')
  await expect(f.archive()).rejects.toMatchObject({ statusCode: 409 })
  expect(cloud.copy).not.toHaveBeenCalled()
})

it.each(['source-receipt', 'target-receipt', 'source-replaced', 'public-target', 'http-error'])('rejects an unsafe copy %s', async (kind) => {
  const f = await fixture()
  const copy = cloud.copy.getMockImplementation()!
  cloud.copy.mockImplementationOnce(async (... args) => {
    const result = await copy(... args)
    if (kind === 'source-receipt')
      result.res.headers['x-oss-copy-source-version-id'] = 'other'
    if (kind === 'target-receipt')
      result.res.headers['x-oss-version-id'] = 'other'
    if (kind === 'source-replaced')
      f.objects.get(f.request.input.key)!.version_id = 'other'
    if (kind === 'http-error')
      result.res.status = 500
    return result
  })
  if (kind === 'public-target')
    f.storage.get_object_access.mockImplementation(async (key?: string) => key === f.original ? 'public-read' : 'private')
  await expect(f.archive()).rejects.toThrow()
  expect(f.storage.get_object_stream).not.toHaveBeenCalled()
})

it('retains ownership of a copy with a lost acknowledgement without retrying it', async () => {
  const f = await fixture()
  const copy = cloud.copy.getMockImplementation()!
  cloud.copy.mockImplementationOnce(async (... args) => {
    await copy(... args)
    throw new Error('sensitive request')
  })
  await expect(f.archive()).rejects.toThrow('云端图片处理失败')
  expect(cloud.copy).toHaveBeenCalledOnce()
  expect(f.objects.has(f.original)).toBe(true)
})
