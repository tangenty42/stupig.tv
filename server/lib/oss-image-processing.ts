import type { webp_processing_options_schema } from '@config/schema'
import type { z } from 'zod'
import type { create_aliyun_oss } from './aliyun-oss'
import type { PrivateOssObject } from './oss-object-identity'
import { addAbortSignal, Readable } from 'node:stream'
import { runtime_config } from '@config/loader'
import { ApiError } from '@server/errors/ApiError'
import { content_image_formats } from '@shared/content-image-format'
import { image_upload_error } from '@shared/content-image-upload'
import { settings } from '@shared/settings'
import OSS from 'ali-oss'
import sharp from 'sharp'
import { verify_private_oss_object } from './oss-object-identity'

type Storage = ReturnType<typeof create_aliyun_oss>
export type OssImageProcessingOptions = z.infer<typeof webp_processing_options_schema>
export type OssImageObject = PrivateOssObject & { key: string, sha256: string | null }
// SDK 6.23.0 implements this method; @types/ali-oss does not declare it.
type ImageClient = OSS & {
  processObjectSave: (source: string, target: string, process: string, bucket: string) => Promise<{ status: number }>
}

interface Request {
  storage: Storage
  input: OssImageObject
  profile: OssImageProcessingOptions
  prefix: string
  signal: AbortSignal
  checkpoint: () => Promise<void>
  require_png?: boolean
}

function client_for(config = runtime_config().aliyun.oss, timeout?: number) {
  if (! config)
    throw new ApiError(503, '云端图片处理尚未配置')
  if (process.env.URLLIB_ENABLE_PROXY || process.env.URLLIB_PROXY)
    throw new ApiError(503, '云端图片处理不支持 urllib 环境代理')
  const options: OSS.Options & { retryMax: number } = { ... config, secure: true, authorizationV4: true, retryMax: 0, timeout: Math.min(config.timeoutMs, timeout ?? config.timeoutMs) }
  return { client: new OSS(options) as ImageClient, bucket: config.bucket }
}
const conflict = (message = '云端图片产物或来源校验失败') => new ApiError(409, message)

function controlled(error: unknown, signal: AbortSignal) {
  if (error instanceof ApiError || signal.aborted)
    return error
  if ((error as { status?: number }).status === 403)
    return new ApiError(503, 'OSS 图片持久化权限尚未配置，请联系管理员')
  return new ApiError(502, '云端图片处理失败，请重试或联系管理员')
}

async function unchanged(storage: Storage, object: OssImageObject) {
  await verify_private_oss_object(storage, object.key, object, '云端图片产物或来源校验失败')
}
async function unused_target(storage: Storage, target: string) {
  try {
    await storage.head_object(target)
    throw conflict('图片处理目标已存在，请重新尝试')
  }
  catch (error) {
    if ((error as { status?: number }).status !== 404)
      throw error
  }
}

/** Only small info JSON and the existing 24px LQIP are read by this adapter. */
async function processed(client: ImageClient, source: OssImageObject, operation: string, limit: number, signal: AbortSignal) {
  signal.throwIfAborted()
  const response = await client.getStream(source.key, { process: operation, headers: { 'If-Match': `"${source.etag}"` } })
  const stream: unknown = response.stream
  if (! (stream instanceof Readable))
    throw conflict()
  if (response.res.status !== 200) {
    stream.destroy()
    throw new ApiError(502, '云端图片处理请求失败，请重试或联系管理员')
  }
  addAbortSignal(signal, stream)
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of stream) {
    length += chunk.length
    if (length > limit) {
      stream.destroy()
      throw conflict('云端图片信息或占位图超过大小上限')
    }
    chunks.push(Buffer.from(chunk))
  }
  signal.throwIfAborted()
  return Buffer.concat(chunks)
}

async function image_info(client: ImageClient, object: OssImageObject, signal: AbortSignal) {
  const body = await processed(client, object, 'image/info', 32 * 1024, signal)
  try {
    const value = JSON.parse(body.toString('utf8')) as Record<string, { value?: unknown } | undefined>
    const integer = (key: string) => {
      const raw = value[key]?.value
      if (typeof raw !== 'string' || ! /^\d+$/.test(raw) || ! Number.isSafeInteger(Number(raw)) || Number(raw) < 1)
        throw conflict('云端图片信息无效')
      return Number(raw)
    }
    const raw_format = value.Format?.value
    if (typeof raw_format !== 'string')
      throw conflict('云端图片信息无效')
    const format = raw_format.toLowerCase().replace(/^jpg$/, 'jpeg').replace(/^heic$/, 'heif')
    // Mobile JPEGs can use 0 for unspecified EXIF orientation. Preserve their
    // stored dimensions, as for absent EXIF; sizes and frame counts stay positive.
    const orientation = ! value.Orientation || value.Orientation.value === '0' ? 1 : integer('Orientation')
    if (orientation > 8 || integer('FileSize') !== object.size)
      throw conflict('云端图片信息与对象不一致')
    return { format, width: integer('ImageWidth'), height: integer('ImageHeight'), frames: integer('FrameCount'), orientation }
  }
  catch (error) {
    throw error instanceof ApiError ? error : conflict('云端图片信息无效')
  }
}

/** Server-only native processing. No full image GET or conversion URL reaches the app/browser. */
export function create_oss_image_processor(config = runtime_config().aliyun.oss) {
  return async ({ storage, input, profile, prefix, signal, checkpoint, require_png }: Request) => {
    const { client, bucket } = client_for(config, profile.timeoutSeconds * 1000)
    const bounded = () => AbortSignal.any([signal, AbortSignal.timeout(profile.timeoutSeconds * 1000)])
    const guard = async () => {
      signal.throwIfAborted()
      await checkpoint()
      signal.throwIfAborted()
    }
    try {
      if (! /^content\/att\/images\/[\da-f]{32}\/[\da-f]{32}$/.test(prefix)
        || ! /^content\/att\/(?:staging|images)\/[\w/.-]+$/.test(input.key) || input.key.includes('..')) {
        throw conflict()
      }
      const budget = image_upload_error(input.size)
      if (budget || input.size > profile.maxInputBytes)
        throw new ApiError(400, budget ?? '图片超过处理大小限制')
      if (profile.jpegBackground.toLowerCase() !== '#ffffff')
        throw new ApiError(400, '云端 JPEG 回退仅支持白色背景，请检查图片处理配置')
      await guard()
      await unchanged(storage, input)
      const source = await image_info(client, input, bounded())
      if (! ['png', 'jpeg', 'webp', 'heif', 'avif'].includes(source.format) || source.frames !== 1)
        throw new ApiError(400, '暂不支持该图片格式、动图或多页图片')
      if (require_png && source.format !== 'png')
        throw new ApiError(400, '图片编辑输出必须为无损 PNG')
      const size_error = image_upload_error(input.size, source)
      if (size_error || source.width * source.height > profile.maxPixels)
        throw new ApiError(400, size_error ?? '图片尺寸超过处理像素上限')
      const expected = source.orientation >= 5 ? { width: source.height, height: source.width } : { width: source.width, height: source.height }
      const private_bucket = async () => {
        if ((await client.getBucketACL(bucket)).acl !== 'private')
          throw new ApiError(503, 'OSS 图片持久化要求目标桶为私有，请联系管理员')
      }
      const persist = async (from: OssImageObject, target: string, operation: string, format: 'webp' | 'jpeg') => {
        await guard()
        await Promise.all([unchanged(storage, from), private_bucket(), unused_target(storage, target)])
        await guard()
        const response = await client.processObjectSave(from.key, target, operation, bucket)
        if (response.status === 403)
          throw new ApiError(503, 'OSS 图片持久化权限尚未配置，请联系管理员')
        if (response.status !== 200)
          throw new ApiError(502, '云端图片持久化请求失败，请重试或联系管理员')
        // saveas inherits bucket ACL. Pin private even if cancellation arrived during POST.
        await storage.set_object_access(target, 'private')
        await guard()
        const [head] = await Promise.all([verify_private_oss_object(storage, target, {}, '云端图片产物或来源校验失败'), unchanged(storage, from)])
        const limit = settings.app.content.image.uploadMaxBytes * (format === 'webp' ? 1 : 4)
        if (head.size <= 0 || head.size > limit)
          throw conflict()
        const object = { key: target, ... head, version_id: head.version_id, sha256: null }
        const info = await image_info(client, object, bounded())
        if (info.format !== format || info.frames !== 1 || info.width !== expected.width || info.height !== expected.height)
          throw conflict()
        await unchanged(storage, object)
        await guard()
        return object
      }
      const display = await persist(input, `${prefix}.${content_image_formats.display.extension}`, `image/auto-orient,1/format,webp/quality,Q_${profile.webpQuality}`, 'webp')
      const fallback = await persist(display, `${prefix}.${content_image_formats.fallback.extension}`, `image/format,jpg/quality,Q_${profile.jpegQuality}`, 'jpeg')
      await guard()
      const lqip = await processed(client, display, `image/resize,m_lfit,w_${profile.lqipMaxDimension},h_${profile.lqipMaxDimension},limit_1/format,jpg/quality,Q_${profile.lqipQuality}`, settings.app.content.image.lqipMaxBytes, bounded())
      const mini = await sharp(lqip, { limitInputPixels: profile.lqipMaxDimension ** 2, failOn: 'warning', animated: true }).metadata()
      if (mini.format !== 'jpeg' || ! mini.width || ! mini.height || mini.width > profile.lqipMaxDimension || mini.height > profile.lqipMaxDimension || (mini.pages ?? 1) !== 1)
        throw conflict()
      await Promise.all([input, display, fallback].map(object => unchanged(storage, object)))
      await guard()
      return { display, fallback, ... expected, lqip }
    }
    catch (error) { throw controlled(error, signal) }
  }
}

/** Trust OSS's conditional copy receipt, not an invented byte digest or ETag-as-SHA. */
export async function copy_oss_image_original(storage: Storage, source: OssImageObject, target: string, signal: AbortSignal, config = runtime_config().aliyun.oss) {
  const { client } = client_for(config)
  const values = (response: { res: { headers: object } }) => response.res.headers as Record<string, string | undefined>
  const etag = (value: string | undefined) => value?.replaceAll('"', '')
  try {
    if (! /^content\/att\/originals\/[\da-f]{32}\/[\da-f]{32}$/.test(target) || target === source.key
      || ! /^content\/att\/(?:staging|images)\/[\w/.-]+$/.test(source.key) || source.key.includes('..')) {
      throw conflict()
    }
    signal.throwIfAborted()
    await Promise.all([unchanged(storage, source), unused_target(storage, target)])
    const metadata = values(await client.head(source.key))
    if (etag(metadata.etag) !== source.etag || metadata['x-oss-version-id'] !== source.version_id || Number(metadata['content-length']) !== source.size)
      throw conflict('归档原图来源已变化')
    signal.throwIfAborted()
    const copied = await client.copy(target, source.key, { headers: {
      'x-oss-copy-source-if-match': `"${source.etag}"`, 'x-oss-object-acl': 'private', 'Cache-Control': 'private, no-store',
      'Content-Type': metadata['content-type'] ?? 'application/octet-stream', 'x-oss-metadata-directive': 'REPLACE',
    } })
    if (copied.res.status !== 200)
      throw new ApiError(502, '云端原图归档请求失败，请重试或联系管理员')
    const receipt = values(copied)
    if (receipt['x-oss-copy-source-version-id'] !== source.version_id || ! receipt['x-oss-version-id'] || ! etag(receipt.etag))
      throw conflict('原图归档复制回执无效')
    signal.throwIfAborted()
    const [head] = await Promise.all([verify_private_oss_object(storage, target, {
      etag: etag(receipt.etag), version_id: receipt['x-oss-version-id'], size: source.size,
    }, '原图归档大小、版本或访问权限校验失败'), unchanged(storage, source)])
    return { key: target, ... head, version_id: receipt['x-oss-version-id'], sha256: source.sha256 }
  }
  catch (error) { throw controlled(error, signal) }
}
