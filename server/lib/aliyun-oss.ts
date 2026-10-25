import type { aliyun_oss_config_schema } from '@config/schema'
import type { z } from 'zod'
import { addAbortSignal, Readable } from 'node:stream'
import { runtime_config } from '@config/loader'
import { ApiError } from '@server/errors/ApiError'
import { content_disposition } from '@server/lib/content-disposition'
import OSS from 'ali-oss'

type Destination = z.infer<typeof aliyun_oss_config_schema>
type Access = 'private' | 'public' | 'inherit'

// @types/ali-oss omits these real SDK methods. Their response contracts follow
// lib/common/{bucket/getBucketVersioning,object/getObjectMeta}.js in SDK 6.23.0.
type Client = OSS & {
  getBucketVersioning: (bucket: string) => Promise<{ versionStatus?: string }>
  getObjectMeta: (key: string) => Promise<{ res: { headers: object } }>
}

function object_key(key: string) {
  if (! key || key.startsWith('/') || /[\\?\0\r\n]/.test(key) || key.split('/').some(part => part === '.' || part === '..'))
    throw new ApiError(400, '对象标识无效')
  return key
}

function creation_headers(access: Access, key: string) {
  if (access !== 'private' && access !== 'public' && access !== 'inherit')
    throw new ApiError(400, '对象访问级别无效')
  if (access === 'public' && key.startsWith('content/att/'))
    throw new ApiError(400, 'Content 附件不能设为公有读')
  return {
    'x-oss-object-acl': access === 'inherit' ? 'default' : access === 'public' ? 'public-read' : 'private',
    'Cache-Control': access === 'public' ? 'public, max-age=31536000, immutable' : 'private, no-store',
  }
}

function headers(response: { res: { headers: object } }) {
  return response.res.headers as Record<string, string | undefined>
}

function identity(response: { res: { headers: object } }, body_etag?: string) {
  const values = headers(response)
  const etag = (body_etag ?? values.etag)?.replaceAll('"', '')
  if (! etag)
    throw new ApiError(502, 'OSS 未返回有效的对象版本')
  return { etag, version_id: values['x-oss-version-id'] ?? null }
}

function not_found(error: unknown) {
  return (error as { status?: number }).status === 404
}

function multipart_id(upload_id: string) {
  if (typeof upload_id !== 'string' || ! /^[\w+/=-]{1,256}$/.test(upload_id))
    throw new ApiError(400, '分片上传标识无效')
}

/** Independent destination adapter. No legacy bucket selection or fallback. */
export function create_aliyun_oss(config: Destination | null = runtime_config().aliyun.oss) {
  if (! config)
    throw new ApiError(503, '阿里云 OSS 目标尚未配置')
  // urllib's optional proxy-agent v5 pulls an unpatched SSRF dependency.
  // This adapter uses direct HTTPS; maintenance bundles omit that optional peer.
  if (process.env.URLLIB_ENABLE_PROXY || process.env.URLLIB_PROXY)
    throw new ApiError(503, '阿里云 OSS 不支持通过 urllib 环境变量启用代理')
  const client = new OSS({
    region: config.region, endpoint: config.endpoint, bucket: config.bucket,
    accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret,
    secure: true, authorizationV4: true, timeout: config.timeoutMs,
  }) as Client
  const bucket = config.bucket
  const preferred_copy_size = config.copyPartSizeMb * 1024 ** 2

  async function head_object(key: string) {
    // getObjectMeta avoids automatic gzip decompression changing HEAD length.
    const response = await client.getObjectMeta(object_key(key))
    const values = headers(response)
    const size = Number(values['content-length'])
    if (values['content-length'] === undefined || ! Number.isSafeInteger(size) || size < 0)
      throw new ApiError(502, 'OSS 对象大小无效')
    return { ... identity(response), size }
  }

  async function put_object(key: string, body: Uint8Array, content_type: string | null, access: Access = 'private') {
    const response = await client.put(object_key(key), Buffer.from(body), {
      mime: content_type ?? 'application/octet-stream', headers: creation_headers(access, key),
    })
    return identity(response)
  }

  async function create_multipart_upload(key: string, content_type: string | null) {
    const result = await client.initMultipartUpload(object_key(key), {
      mime: content_type ?? 'application/octet-stream', headers: { 'Cache-Control': 'private, no-store' },
    })
    if (! result.uploadId)
      throw new ApiError(502, 'OSS 未返回分片上传标识')
    return result.uploadId
  }

  async function upload_part(key: string, upload_id: string, number: number, body: Uint8Array) {
    if (! upload_id || ! Number.isInteger(number) || number < 1 || number > 10_000 || body.length === 0)
      throw new ApiError(400, '分片参数无效')
    const response = await client.uploadPart(object_key(key), upload_id, number, Buffer.from(body), 0, body.byteLength)
    const etag = response.etag?.replaceAll('"', '')
    if (! etag)
      throw new ApiError(502, 'OSS 未确认上传分片')
    return { part_number: number, etag, size: body.byteLength }
  }

  /**
   * Server callers must authorize the persisted key/upload ID before signing.
   * A client gets no signing secret and cannot initiate or complete an object.
   */
  async function signed_part_upload(key: string, upload_id: string, number: number, size: number, content_md5: string, expires_in: number) {
    object_key(key)
    multipart_id(upload_id)
    if (! Number.isInteger(number) || number < 1 || number > 10_000
      || ! Number.isSafeInteger(size) || size < 1 || size > 5 * 1024 ** 3
      || ! /^[\w+/]{22}==$/.test(content_md5) || Buffer.from(content_md5, 'base64').toString('base64') !== content_md5
      || ! Number.isSafeInteger(expires_in) || expires_in < 1 || expires_in > 604_800) {
      throw new ApiError(400, '分片签名参数无效')
    }
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-MD5': content_md5, 'Content-Length': String(size) }
    const url = await client.signatureUrlV4('PUT', expires_in, {
      headers, queries: { uploadId: upload_id, partNumber: String(number) },
    }, key, ['content-length'])
    return { url, method: 'PUT' as const, headers }
  }

  /** One bounded page. Never trust the SDK's TS array shape for a single XML Part. */
  async function list_multipart_parts(key: string, upload_id: string, marker = 0) {
    object_key(key)
    multipart_id(upload_id)
    if (! Number.isInteger(marker) || marker < 0 || marker > 10_000)
      throw new ApiError(400, '分片分页标识无效')
    const response = await client.listParts(key, upload_id, { 'max-parts': 1000, 'part-number-marker': marker, 'encoding-type': 'url' })
    const raw = response.parts as unknown as { PartNumber: string, Size: string, ETag: string }[] | { PartNumber: string, Size: string, ETag: string }
    const values = Array.isArray(raw) ? raw : [raw]
    const parts = values.map(part => ({ part_number: Number(part?.PartNumber), size: Number(part?.Size), etag: typeof part?.ETag === 'string' ? part.ETag.replaceAll('"', '') : '' }))
    const truncated: unknown = response.isTruncated
    if (values.length > 1000 || ! [true, false, 'true', 'false'].includes(truncated as boolean | string)
      || parts.some((part, index) => ! Number.isInteger(part.part_number) || part.part_number <= (parts[index - 1]?.part_number ?? marker) || part.part_number > 10_000
        || ! Number.isSafeInteger(part.size) || part.size < 1 || part.size > 5 * 1024 ** 3 || ! part.etag || /[\r\n]/.test(part.etag))) {
      throw new ApiError(502, 'OSS 分片清单无效')
    }
    const next_marker = truncated === true || truncated === 'true' ? Number(response.nextPartNumberMarker) : null
    if (next_marker !== null && (! Number.isInteger(next_marker) || next_marker <= marker || next_marker !== parts.at(- 1)?.part_number))
      throw new ApiError(502, 'OSS 分片分页未前进')
    return { parts, next_marker }
  }

  async function complete_multipart_upload(key: string, upload_id: string, parts: { part_number: number, etag: string }[], access: Access = 'private') {
    if (! upload_id || ! parts.length || parts.length > 10_000 || new Set(parts.map(part => part.part_number)).size !== parts.length || parts.some(part => ! Number.isInteger(part.part_number) || part.part_number < 1 || part.part_number > 10_000 || ! part.etag))
      throw new ApiError(400, '分片完成清单无效')
    // ACL belongs on Complete, not only Initiate. Otherwise a public bucket
    // would expose the newly assembled private object before any later fix.
    const response = await client.completeMultipartUpload(object_key(key), upload_id, parts.map(part => ({ number: part.part_number, etag: part.etag })), {
      headers: creation_headers(access, key),
    })
    return identity(response)
  }

  async function abort_multipart_upload(key: string, upload_id: string) {
    if (! upload_id)
      throw new ApiError(400, '分片上传标识无效')
    await client.abortMultipartUpload(object_key(key), upload_id)
  }

  /**
   * One bounded page for an already-owned attempt, including lost init replies.
   * Aborting this page removes its entries; a subsequent pass drains the rest.
   */
  async function list_multipart_uploads(key: string) {
    object_key(key)
    const response = await client.listUploads({ 'prefix': key, 'max-uploads': 1000 })
    if (! Array.isArray(response.uploads) || response.uploads.length > 1000)
      throw new ApiError(502, 'OSS 上传清单无效')
    return response.uploads.filter(upload => upload.name === key).map((upload) => {
      multipart_id(upload.uploadId)
      return upload.uploadId
    })
  }

  async function copy_object(source_key: string, target_key: string, access: Access = 'private') {
    object_key(source_key)
    object_key(target_key)
    if (source_key === target_key)
      throw new ApiError(400, '复制目标必须使用新的对象标识')
    const target_headers = creation_headers(access, target_key)
    const source = await head_object(source_key)
    const metadata = await client.head(source_key)
    if (identity(metadata).etag !== source.etag)
      throw new ApiError(409, '复制源已变化')
    const content_type = headers(metadata)['content-type'] ?? 'application/octet-stream'
    const copy_headers = { 'x-oss-copy-source-if-match': `"${source.etag}"` }
    const preferred = preferred_copy_size
    if (source.size <= Math.min(preferred, 1024 ** 3)) {
      const response = await client.copy(target_key, source_key, { headers: { ... copy_headers, ... target_headers, 'Content-Type': content_type, 'x-oss-metadata-directive': 'REPLACE' } })
      return identity(response, response.data?.etag)
    }
    const upload_id = await create_multipart_upload(target_key, content_type)
    try {
      const parts: { part_number: number, etag: string }[] = []
      const part_size = Math.max(preferred, Math.ceil(source.size / 10_000))
      for (let start = 0; start < source.size; start += part_size) {
        const end = Math.min(source.size, start + part_size) - 1
        const number = parts.length + 1
        const response = await client.uploadPartCopy(target_key, upload_id, number, `${start}-${end}`, { sourceKey: source_key, sourceBucketName: bucket }, { headers: copy_headers })
        if (! response.etag)
          throw new ApiError(502, 'OSS 未确认复制分片')
        parts.push({ part_number: number, etag: response.etag })
      }
      return await complete_multipart_upload(target_key, upload_id, parts, access)
    }
    catch (error) {
      // Abort never deletes a possibly completed target. A lost Complete
      // acknowledgement still needs the future session's durable reconciliation.
      await abort_multipart_upload(target_key, upload_id).catch(() => {})
      throw error
    }
  }

  async function set_object_access(key: string, access: Access) {
    const acl = creation_headers(access, key)['x-oss-object-acl']
    // The SDK supports default ACL; @types/ali-oss omits that enum value.
    await client.putACL(object_key(key), acl as OSS.ACLType)
  }

  async function get_object_access(key: string) {
    const response = await client.getACL(object_key(key))
    return response.acl as OSS.ACLType | 'default'
  }

  async function signed_read_url(key: string, expires_in: number, method: 'GET' | 'HEAD' = 'GET', download_name?: string, disposition: 'attachment' | 'inline' = 'attachment') {
    object_key(key)
    if (! Number.isSafeInteger(expires_in) || expires_in < 1 || expires_in > 604_800 || (method !== 'GET' && method !== 'HEAD'))
      throw new ApiError(400, '读取签名参数无效')
    const queries: Record<string, string> = { 'response-cache-control': 'private, no-store' }
    if (download_name)
      queries['response-content-disposition'] = content_disposition(download_name, disposition)
    // Only current-version reads: never add OSS versionId to issued URLs.
    // HEAD is supported by V4 signing but omitted from the published TS enum.
    return client.signatureUrlV4(method as OSS.HTTPMethods, expires_in, { queries }, key)
  }

  async function get_object_stream(key: string, etag: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const response = await client.getStream(object_key(key), { headers: { 'If-Match': `"${etag.replaceAll('"', '')}"` } })
    const stream: unknown = response.stream
    if (! (stream instanceof Readable))
      throw new ApiError(502, 'OSS 未返回对象数据流')
    const size_header = headers(response)['content-length']
    const size = Number(size_header)
    if (size_header === undefined || ! Number.isSafeInteger(size) || size < 0) {
      stream.destroy()
      throw new ApiError(502, 'OSS 对象大小无效')
    }
    if (signal)
      addAbortSignal(signal, stream)
    return { stream, size }
  }

  async function soft_delete_object(key: string) {
    object_key(key)
    const versioning = await client.getBucketVersioning(bucket)
    if (versioning.versionStatus !== 'Enabled')
      throw new ApiError(409, '目标桶未启用版本控制，拒绝执行可恢复删除')
    await set_object_access(key, 'private')
    // Do not accept options/versionId. A version-specific delete is permanent.
    const response = await client.delete(key)
    const values = headers(response)
    if (values['x-oss-delete-marker'] !== 'true' || ! values['x-oss-version-id'])
      throw new ApiError(502, 'OSS 删除标记未确认，请查询删除回执后重试')
    try {
      await head_object(key)
      throw new ApiError(409, '对象仍可读取，删除尚未确认')
    }
    catch (error) {
      if (! not_found(error))
        throw error
    }
    return { delete_marker_version_id: values['x-oss-version-id'] }
  }

  async function inspect_bucket() {
    const [acl, versioning, lifecycle] = await Promise.all([
      client.getBucketACL(bucket), client.getBucketVersioning(bucket),
      client.getBucketLifecycle(bucket).catch((error: unknown) => {
        if ((error as { code?: string }).code === 'NoSuchLifecycle')
          return { rules: [] }
        throw error
      }),
    ])
    return { acl: acl.acl, versioning: versioning.versionStatus ?? 'Unversioned', lifecycle_rules: lifecycle.rules ?? [] }
  }

  return { head_object, put_object, create_multipart_upload, upload_part, signed_part_upload, list_multipart_parts, list_multipart_uploads, complete_multipart_upload, abort_multipart_upload, copy_object, set_object_access, get_object_access, signed_read_url, get_object_stream, soft_delete_object, inspect_bucket }
}
