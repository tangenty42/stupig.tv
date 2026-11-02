import type { aliyun_oss_config_schema } from '@config/schema'
import type { z } from 'zod'
import OSS from 'ali-oss'

export interface Version { key: string, version_id: string, latest: boolean, deleted: boolean, modified_at: string, size: number, etag: string | null, storage_class: string }
export interface Upload { key: string, upload_id: string, initiated_at: string }
export interface Cursor { key: string, id: string }
export interface Page<T> { items: T[], next: Cursor | null }
export interface Parts { count: number, bytes: number, next: number | null }
export interface Reader {
  configuration: (kind: 'versioning' | 'lifecycle') => Promise<unknown>
  versions: (cursor: Cursor | null, limit: number, prefix: string) => Promise<Page<Version>>
  uploads: (cursor: Cursor | null, limit: number, prefix: string) => Promise<Page<Upload>>
  parts: (upload: Upload, after: number, limit: number) => Promise<Parts>
}
interface Parameters { method: 'GET', bucket: string, object?: string, subres: Record<string, string>, query?: Record<string, string | number>, xmlResponse: true, successStatuses: number[], timeout: number }
type Request = (parameters: Parameters) => Promise<{ data: unknown }>
const invalid = () => new Error('invalid_oss_inventory_response')
function object(value: unknown): Record<string, unknown> {
  if (! value || typeof value !== 'object' || Array.isArray(value))
    throw invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, max = 2048) {
  if (typeof value !== 'string' || ! value || Buffer.byteLength(value) > max)
    throw invalid()
  return value
}
function number(value: unknown) {
  if (typeof value !== 'number' && (typeof value !== 'string' || ! /^\d+$/.test(value)))
    throw invalid()
  const result = Number(value)
  if (! Number.isSafeInteger(result) || result < 0)
    throw invalid()
  return result
}
function boolean(value: unknown) {
  if (value !== 'true' && value !== 'false' && value !== true && value !== false)
    throw invalid()
  return value === true || value === 'true'
}
function date(value: unknown) {
  const result = new Date(text(value))
  if (! Number.isFinite(result.getTime()))
    throw invalid()
  return result.toISOString()
}
function array(value: unknown) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

/** GET-only adapter. Raw XML fields retain delete-marker IsLatest, which SDK 6.23's convenience method drops. */
export function create_inventory_reader(config: z.infer<typeof aliyun_oss_config_schema>, request?: Request): Reader {
  if (process.env.URLLIB_ENABLE_PROXY || process.env.URLLIB_PROXY)
    throw new Error('oss_proxy_not_supported')
  const client = request
    ? null
    : new OSS({ region: config.region, endpoint: config.endpoint, bucket: config.bucket,
        accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret, secure: true, authorizationV4: true, timeout: Math.min(config.timeoutMs, 30000) })
  // Same signed request contract used by the installed SDK's GET implementations.
  const send = request ?? (client as unknown as { request: Request }).request.bind(client)
  async function get(subres: Record<string, string>, query?: Parameters['query'], key?: string) {
    return object((await send({ method: 'GET', bucket: config.bucket, ... (key === undefined ? {} : { object: key }),
      subres, ... (query ? { query } : {}), xmlResponse: true, successStatuses: [200], timeout: Math.min(config.timeoutMs, 30000) })).data)
  }
  async function list(kind: 'versions' | 'uploads', cursor: Cursor | null, limit: number, prefix: string) {
    const value = await get({ [kind]: '' }, { [kind === 'versions' ? 'max-keys' : 'max-uploads']: limit,
      'encoding-type': 'url', ... (prefix ? { prefix } : {}), ... (cursor ? { 'key-marker': cursor.key, [kind === 'versions' ? 'version-id-marker' : 'upload-id-marker']: cursor.id } : {}) }, '')
    const key = (raw: unknown) => {
      const name = text(raw, 4096)
      const decoded = value.EncodingType === 'url' ? decodeURIComponent(name) : name
      return text(decoded, 1024)
    }
    const next = boolean(value.IsTruncated) ? { key: key(value.NextKeyMarker), id: text(value[kind === 'versions' ? 'NextVersionIdMarker' : 'NextUploadIdMarker']) } : null
    if (next && next.key === cursor?.key && next.id === cursor.id)
      throw invalid()
    return { value, key, next }
  }
  return {
    async configuration(kind) {
      try {
        return await get({ [kind]: '' })
      }
      catch (error) {
        if (kind === 'lifecycle' && (error as { code?: string }).code === 'NoSuchLifecycle')
          return { Rule: [] }
        throw error
      }
    },
    async versions(cursor, limit, prefix) {
      const { value, key, next } = await list('versions', cursor, limit, prefix)
      const entries = [... array(value.Version).map(value => ({ value, deleted: false })), ... array(value.DeleteMarker).map(value => ({ value, deleted: true }))]
      if (entries.length > limit || (next && ! entries.length))
        throw invalid()
      const items = entries.map(({ value, deleted }) => {
        const row = object(value)
        return { key: key(row.Key), version_id: text(row.VersionId), latest: boolean(row.IsLatest), deleted,
          modified_at: date(row.LastModified), size: deleted ? 0 : number(row.Size), etag: deleted ? null : text(row.ETag), storage_class: deleted ? 'delete_marker' : text(row.StorageClass) }
      })
      if (new Set(items.map(item => JSON.stringify([item.key, item.version_id]))).size !== items.length)
        throw invalid()
      return { items, next }
    },
    async uploads(cursor, limit, prefix) {
      const { value, key, next } = await list('uploads', cursor, limit, prefix)
      const items = array(value.Upload).map((value) => {
        const row = object(value)
        return { key: key(row.Key), upload_id: text(row.UploadId), initiated_at: date(row.Initiated) }
      })
      if (items.length > limit || (next && ! items.length) || new Set(items.map(item => JSON.stringify([item.key, item.upload_id]))).size !== items.length)
        throw invalid()
      return { items, next }
    },
    async parts(upload, after, limit) {
      const value = await get({ uploadId: upload.upload_id }, { 'part-number-marker': after, 'max-parts': limit }, upload.key)
      if (text(value.UploadId) !== upload.upload_id)
        throw invalid()
      const rows = array(value.Part)
      let previous = after
      let bytes = 0
      for (const value of rows) {
        const row = object(value)
        const part = number(row.PartNumber)
        if (part <= previous || part > 10000)
          throw invalid()
        previous = part
        bytes += number(row.Size)
      }
      const next = boolean(value.IsTruncated) ? number(value.NextPartNumberMarker) : null
      if (rows.length > limit || ! Number.isSafeInteger(bytes) || (next !== null && (next <= after || next !== previous)))
        throw invalid()
      return { count: rows.length, bytes, next }
    },
  }
}
