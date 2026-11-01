import type { create_aliyun_oss } from './aliyun-oss'
import type { ImageProcessingOptions } from './webp-image-processing'
import { createHash } from 'node:crypto'
import { addAbortSignal, Readable } from 'node:stream'
import { runtime_config } from '@config/loader'
import { ApiError } from '@server/errors/ApiError'
import { content_image_formats } from '@shared/content-image-format'
import { image_upload_error } from '@shared/content-image-upload'
import { settings } from '@shared/settings'
import OSS from 'ali-oss'
import sharp from 'sharp'

type Storage = ReturnType<typeof create_aliyun_oss>
type ImageObjectIdentity = Awaited<ReturnType<Storage['head_object']>> & { key: string, sha256: string, version_id: string }
// SDK 6.23.0 implements this method; @types/ali-oss does not declare it.
type ImageClient = OSS & {
  processObjectSave: (source: string, target: string, process: string, bucket: string) => Promise<{ status: number }>
}

interface Request {
  storage: Storage
  input: ImageObjectIdentity
  bytes: Buffer
  profile: ImageProcessingOptions
  prefix: string
  signal: AbortSignal
  checkpoint: () => Promise<void>
}

/** Server-only adapter. No URL, credential or caller-supplied processing expression leaves it. */
export function create_oss_image_processor(config = runtime_config().aliyun.oss) {
  if (! config)
    throw new ApiError(503, '云端图片处理尚未配置')
  if (process.env.URLLIB_ENABLE_PROXY || process.env.URLLIB_PROXY)
    throw new ApiError(503, '云端图片处理不支持 urllib 环境代理')
  return async ({ storage, input, bytes, profile, prefix, signal, checkpoint }: Request) => {
    const fail = (message = '云端图片产物或来源校验失败') => new ApiError(409, message)
    const guard = async () => {
      signal.throwIfAborted()
      await checkpoint()
      signal.throwIfAborted()
    }
    if (! /^content\/att\/images\/[\da-f]{32}\/[\da-f]{32}$/.test(prefix)
      || ! /^content\/att\/(?:staging|images)\/[\w/.-]+$/.test(input.key) || input.key.includes('..')
      || input.size !== bytes.length || input.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
      throw fail()
    }
    const message = image_upload_error(bytes.length)
    if (message)
      throw new ApiError(400, message)
    if (profile.jpegBackground.toLowerCase() !== '#ffffff')
      throw new ApiError(400, '云端 JPEG 回退仅支持白色背景，请检查图片处理配置')
    const open = (value: Buffer) => sharp(value, { limitInputPixels: Math.min(profile.maxPixels, settings.app.content.image.uploadMaxPixels), failOn: 'warning', animated: true }).timeout({ seconds: profile.timeoutSeconds })
    const metadata = await open(bytes).metadata().catch(() => {
      throw new ApiError(400, '图片损坏、尺寸超限或格式不支持，请重新导出后重试')
    })
    if (! ['png', 'jpeg', 'webp', 'heif'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1)
      throw new ApiError(400, '暂不支持该图片格式、动图或多页图片')
    const raw_size = { width: metadata.width ?? 0, height: metadata.height ?? 0 }
    const size_error = image_upload_error(bytes.length, raw_size)
    if (size_error)
      throw new ApiError(400, size_error)
    const rotated = (metadata.orientation ?? 1) >= 5
    const expected = rotated ? { width: raw_size.height, height: raw_size.width } : raw_size
    const options: OSS.Options & { retryMax: number } = { ... config, secure: true, authorizationV4: true, retryMax: 0, timeout: Math.min(config.timeoutMs, profile.timeoutSeconds * 1000) }
    const client = new OSS(options) as ImageClient
    const unchanged = async (object: ImageObjectIdentity) => {
      const head = await storage.head_object(object.key)
      if (head.etag !== object.etag || head.version_id !== object.version_id || head.size !== object.size || await storage.get_object_access(object.key) !== 'private')
        throw fail()
    }
    const processed = async (source: ImageObjectIdentity, operation: string, limit: number) => {
      await guard()
      await unchanged(source)
      const response = await client.getStream(source.key, { process: operation, headers: { 'If-Match': `"${source.etag}"` } })
      const stream: unknown = response.stream
      if (! (stream instanceof Readable))
        throw fail()
      if (response.res.status !== 200) {
        stream.destroy()
        throw new ApiError(502, '云端图片处理请求失败，请重试或联系管理员')
      }
      addAbortSignal(AbortSignal.any([signal, AbortSignal.timeout(profile.timeoutSeconds * 1000)]), stream)
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of stream) {
        length += chunk.length
        if (length > limit) {
          stream.destroy()
          throw fail('云端图片产物超过处理大小上限')
        }
        chunks.push(Buffer.from(chunk))
      }
      await unchanged(source)
      await guard()
      return Buffer.concat(chunks)
    }
    const persist = async (source: ImageObjectIdentity, target: string, operation: string, format: 'webp' | 'jpeg') => {
      await guard()
      await unchanged(source)
      // saveas cannot set an object ACL: it inherits the bucket at creation.
      // Never create even a temporary public representation of private pixels.
      if ((await client.getBucketACL(config.bucket)).acl !== 'private')
        throw new ApiError(503, 'OSS 图片持久化要求目标桶为私有，请联系管理员')
      try {
        await storage.head_object(target)
        throw fail('图片处理目标已存在，请重新尝试')
      }
      catch (error) {
        if ((error as { status?: number }).status !== 404)
          throw error
      }
      await guard()
      const response = await client.processObjectSave(source.key, target, operation, config.bucket)
      if (response.status === 403)
        throw new ApiError(503, 'OSS 图片持久化权限尚未配置，请联系管理员')
      if (response.status !== 200)
        throw new ApiError(502, '云端图片持久化请求失败，请重试或联系管理员')
      // Pin explicit privacy even if cancellation arrived while the POST ran.
      // The attempt already owns this exact key, including unknown/late writes.
      await storage.set_object_access(target, 'private')
      // saveas omits Cache-Control. Browser delivery still forces private/no-store
      // through signed_read_url or ESA's outgoing response rule; no self-copy is needed.
      await guard()
      await unchanged(source)
      const head = await storage.head_object(target)
      const limit = settings.app.content.image.uploadMaxBytes * (format === 'webp' ? 1 : 4)
      if (! head.version_id || head.size <= 0 || head.size > limit || await storage.get_object_access(target) !== 'private')
        throw fail()
      // Verify the persisted object once; no transformed bytes are uploaded by us.
      const { stream, size } = await storage.get_object_stream(target, head.etag, AbortSignal.any([signal, AbortSignal.timeout(profile.timeoutSeconds * 1000)]))
      if (size !== head.size) {
        stream.destroy()
        throw fail()
      }
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of stream) {
        length += chunk.length
        if (length > head.size) {
          stream.destroy()
          throw fail('云端图片产物超过处理大小上限')
        }
        chunks.push(Buffer.from(chunk))
      }
      if (length !== head.size)
        throw fail()
      const body = Buffer.concat(chunks)
      const info = await open(body).metadata()
      if (info.format !== format || (info.pages ?? 1) !== 1 || info.width !== expected.width || info.height !== expected.height)
        throw fail()
      await guard()
      const object = { key: target, ... head, version_id: head.version_id, sha256: createHash('sha256').update(body).digest('hex') }
      await unchanged(object)
      await guard()
      return object
    }
    try {
      const display = await persist(input, `${prefix}.${content_image_formats.display.extension}`, `image/auto-orient,1/format,webp/quality,Q_${profile.webpQuality}`, 'webp')
      const fallback = await persist(display, `${prefix}.${content_image_formats.fallback.extension}`, `image/format,jpg/quality,Q_${profile.jpegQuality}`, 'jpeg')
      await guard()
      const lqip = await processed(display, `image/resize,m_lfit,w_${profile.lqipMaxDimension},h_${profile.lqipMaxDimension},limit_1/format,jpg/quality,Q_${profile.lqipQuality}`, settings.app.content.image.lqipMaxBytes)
      const mini = await open(lqip).metadata()
      if (mini.format !== 'jpeg' || ! mini.width || ! mini.height || mini.width > profile.lqipMaxDimension || mini.height > profile.lqipMaxDimension)
        throw fail()
      await unchanged(input)
      // Later stages must not have replaced the adopted final WebP or JPEG.
      for (const object of [display, fallback])
        await unchanged(object)
      await guard()
      return { display, fallback, ... expected, lqip }
    }
    catch (error) {
      if (error instanceof ApiError || signal.aborted)
        throw error
      if ((error as { status?: number }).status === 403)
        throw new ApiError(503, 'OSS 图片持久化权限尚未配置，请联系管理员')
      // SDK errors can contain signed requests; only a controlled message reaches the job/UI.
      throw new ApiError(502, '云端图片处理失败，请重试或联系管理员')
    }
  }
}
