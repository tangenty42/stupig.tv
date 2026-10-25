import { createHash } from 'node:crypto'
import { addAbortSignal, Readable } from 'node:stream'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { runtime_config } from '@config/loader'
import { ApiError } from '@server/errors/ApiError'
import { error_fields, log_error } from '@server/lib/log'

const config = runtime_config()

interface StoredObject {
  key: string
  size: number
  etag: string | null
  last_modified: Date | null
}

export interface MultipartUpload {
  key: string
  upload_id: string
  initiated: Date | null
}

export type StorageBucket = 'public' | 'private'
const clients = new Map<StorageBucket, S3Client>()

function bucket_config(bucket: StorageBucket) {
  if (bucket !== 'public' && bucket !== 'private')
    throw new ApiError(503, '附件物理存储位置无效，请核对迁移状态')
  const value = bucket === 'public' ? config.oss : config.oss.buckets.private
  if (! value)
    throw new ApiError(503, '私有附件存储尚未配置')
  return value
}

export function storage_bucket_name(bucket: StorageBucket) {
  return bucket_config(bucket).bucket
}

function cache_control(bucket: StorageBucket) {
  return bucket === 'private' ? 'private, no-store' : 'public, max-age=31536000, immutable'
}

/** S3 wraps ETags in double quotes; strip them for use in URLs. */
function strip_etag(etag: string | undefined) {
  return etag ? etag.replaceAll('"', '') : null
}

function get_client(bucket: StorageBucket) {
  const existing = clients.get(bucket)
  if (existing)
    return existing
  const selected = bucket_config(bucket)
  const client = new S3Client({
    endpoint: selected.endpoint, region: selected.region, forcePathStyle: selected.forcePathStyle,
    credentials: { accessKeyId: selected.accessKeyId, secretAccessKey: selected.accessKeySecret },
    requestHandler: { connectionTimeout: selected.connectionTimeoutMs, requestTimeout: selected.requestTimeoutMs, socketTimeout: selected.requestTimeoutMs, throwOnRequestTimeout: true },
  })
  clients.set(bucket, client)
  return client
}

export async function put_object(bucket: StorageBucket, key: string, body: Uint8Array, content_type: string | null, signal?: AbortSignal) {
  const result = await get_client(bucket).send(new PutObjectCommand({
    Bucket: storage_bucket_name(bucket),
    Key: key,
    Body: body,
    ContentType: content_type || undefined,
    CacheControl: cache_control(bucket),
  }), { abortSignal: signal })
  return strip_etag(result.ETag)
}

/** Downloads an object's bytes (server-side transforms like attachment encryption). */
export async function get_object(bucket: StorageBucket, key: string) {
  const result = await get_client(bucket).send(new GetObjectCommand({
    Bucket: storage_bucket_name(bucket),
    Key: key,
  }))
  return new Uint8Array(await result.Body!.transformToByteArray())
}

export async function signed_object_url(bucket: StorageBucket, command: unknown, expires_in: number) {
  return getSignedUrl(get_client(bucket), command as Parameters<typeof getSignedUrl>[1], { expiresIn: expires_in })
}

function copy_source(bucket: StorageBucket, key: string) {
  return `${storage_bucket_name(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
}

export async function copy_object(bucket: StorageBucket, source_key: string, target_key: string) {
  return copy_between_buckets(bucket, source_key, bucket, target_key)
}

/** Copy bytes in storage; larger objects use ranged UploadPartCopy, never app buffers. */
export async function copy_between_buckets(source_bucket: StorageBucket, source_key: string, target_bucket: StorageBucket, target_key: string, signal?: AbortSignal) {
  const source = await head_object(source_bucket, source_key, signal)
  const selected = get_client(target_bucket)
  const target = { Bucket: storage_bucket_name(target_bucket), Key: target_key }
  const copy = { CopySource: copy_source(source_bucket, source_key), CopySourceIfMatch: source.etag ? `"${source.etag}"` : undefined }
  const preferred_part_size = bucket_config(target_bucket).copyPartSizeMb * 1024 ** 2
  const part_size = Math.max(preferred_part_size, Math.ceil(source.size / 10_000))
  if (source.size <= Math.min(preferred_part_size, 5 * 1024 ** 3)) {
    const result = await selected.send(new CopyObjectCommand({
      ... target, ... copy, MetadataDirective: 'REPLACE',
      ContentType: source.content_type ?? undefined, CacheControl: cache_control(target_bucket),
    }), { abortSignal: signal })
    if (! result.CopyObjectResult?.ETag)
      throw new Error('Cross-bucket copy returned no ETag')
    return strip_etag(result.CopyObjectResult.ETag)!
  }
  const upload_id = await create_multipart_upload(target_bucket, target_key, source.content_type, signal)
  try {
    const parts: UploadedPart[] = []
    for (let offset = 0; offset < source.size; offset += part_size) {
      const size = Math.min(part_size, source.size - offset)
      const part_number = parts.length + 1
      const result = await selected.send(new UploadPartCopyCommand({
        ... target, ... copy, UploadId: upload_id, PartNumber: part_number,
        CopySourceRange: `bytes=${offset}-${offset + size - 1}`,
      }), { abortSignal: signal })
      if (! result.CopyPartResult?.ETag)
        throw new Error('Multipart copy returned no ETag')
      parts.push({ part_number, size, etag: result.CopyPartResult.ETag })
    }
    const version = await complete_multipart_upload(target_bucket, target_key, upload_id, parts, signal)
    if (! version)
      throw new Error('Multipart copy completion returned no ETag')
    return version
  }
  catch (error) {
    await abort_multipart_upload(target_bucket, target_key, upload_id).catch((cleanup_error) => {
      log_error('storage-copy-abort-failed', { bucket: target_bucket, key: target_key, ... error_fields(cleanup_error) })
    })
    throw error
  }
}

// Aliyun OSS rejects the S3 batch delete (DeleteObjects) with MissingContentMD5,
// so deletes go through single-object requests.
export async function delete_object(bucket: StorageBucket, key: string, signal?: AbortSignal) {
  await get_client(bucket).send(new DeleteObjectCommand({
    Bucket: storage_bucket_name(bucket),
    Key: key,
  }), { abortSignal: signal })
}

// Business operations must not be blocked by a storage outage, so callers drop
// the error — but a failed delete leaves an orphan object, so it is always
// logged for the reconciliation job to find.
export async function delete_object_best_effort(bucket: StorageBucket, key: string) {
  try {
    await delete_object(bucket, key)
  }
  catch (error) {
    log_error('storage-delete-failed', { bucket, key, ... error_fields(error) })
  }
}

export async function delete_prefix(bucket: StorageBucket, prefix: string) {
  let continuation_token: string | undefined
  do {
    const page = await get_client(bucket).send(new ListObjectsV2Command({
      Bucket: storage_bucket_name(bucket),
      Prefix: prefix,
      ContinuationToken: continuation_token,
    }))
    const keys = (page.Contents ?? []).flatMap(object => object.Key ? [object.Key] : [])
    await Promise.all(keys.map(key => delete_object(bucket, key)))
    continuation_token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuation_token)
}

export async function head_object(bucket: StorageBucket, key: string, signal?: AbortSignal) {
  const result = await get_client(bucket).send(new HeadObjectCommand({
    Bucket: storage_bucket_name(bucket),
    Key: key,
  }), { abortSignal: signal })
  return {
    size: Number(result.ContentLength ?? 0),
    content_type: result.ContentType ?? null,
    etag: strip_etag(result.ETag),
  }
}

export async function list_objects(bucket: StorageBucket, prefix = '') {
  const objects: StoredObject[] = []
  let continuation_token: string | undefined
  do {
    const page = await get_client(bucket).send(new ListObjectsV2Command({
      Bucket: storage_bucket_name(bucket),
      Prefix: prefix,
      ContinuationToken: continuation_token,
    }))
    for (const object of page.Contents ?? []) {
      if (object.Key) {
        objects.push({
          key: object.Key,
          size: Number(object.Size ?? 0),
          etag: strip_etag(object.ETag),
          last_modified: object.LastModified ?? null,
        })
      }
    }
    continuation_token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuation_token)
  return objects
}

export async function list_multipart_uploads(bucket: StorageBucket, prefix = '') {
  const uploads: MultipartUpload[] = []
  let key_marker: string | undefined
  let upload_id_marker: string | undefined

  do {
    const page = await get_client(bucket).send(new ListMultipartUploadsCommand({
      Bucket: storage_bucket_name(bucket),
      Prefix: prefix,
      KeyMarker: key_marker,
      UploadIdMarker: upload_id_marker,
    }))

    for (const upload of page.Uploads ?? []) {
      if (upload.Key && upload.UploadId) {
        uploads.push({
          key: upload.Key,
          upload_id: upload.UploadId,
          initiated: upload.Initiated ?? null,
        })
      }
    }

    key_marker = page.IsTruncated ? page.NextKeyMarker : undefined
    upload_id_marker = page.IsTruncated ? page.NextUploadIdMarker : undefined
  } while (key_marker || upload_id_marker)

  return uploads
}

export async function abort_multipart_upload(bucket: StorageBucket, key: string, upload_id: string) {
  await get_client(bucket).send(new AbortMultipartUploadCommand({
    Bucket: storage_bucket_name(bucket),
    Key: key,
    UploadId: upload_id,
  }))
}

export async function create_multipart_upload(bucket: StorageBucket, key: string, content_type: string | null, signal?: AbortSignal) {
  const result = await get_client(bucket).send(new CreateMultipartUploadCommand({
    Bucket: storage_bucket_name(bucket),
    Key: key,
    ContentType: content_type || undefined,
    CacheControl: cache_control(bucket),
  }), { abortSignal: signal })
  if (! result.UploadId)
    throw new Error(`multipart upload for ${key} returned no UploadId`)
  return result.UploadId
}

/** One uploaded part as listed from the service, for resume. */
export interface UploadedPart {
  part_number: number
  etag: string
  size: number
}

export async function list_parts(bucket: StorageBucket, key: string, upload_id: string, signal?: AbortSignal) {
  const parts: UploadedPart[] = []
  let marker: string | undefined
  do {
    const page = await get_client(bucket).send(new ListPartsCommand({
      Bucket: storage_bucket_name(bucket),
      Key: key,
      UploadId: upload_id,
      PartNumberMarker: marker,
    }), { abortSignal: signal })
    for (const part of page.Parts ?? []) {
      if (part.PartNumber === undefined || ! part.ETag)
        continue
      parts.push({
        part_number: part.PartNumber,
        etag: strip_etag(part.ETag) ?? part.ETag,
        size: Number(part.Size ?? 0),
      })
    }
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined
  } while (marker)
  return parts
}

export async function complete_multipart_upload(bucket: StorageBucket, key: string, upload_id: string, parts: UploadedPart[], signal?: AbortSignal) {
  const result = await get_client(bucket).send(new CompleteMultipartUploadCommand({
    Bucket: storage_bucket_name(bucket),
    Key: key,
    UploadId: upload_id,
    MultipartUpload: {
      Parts: [... parts]
        .sort((left, right) => left.part_number - right.part_number)
        .map(part => ({ PartNumber: part.part_number, ETag: part.etag })),
    },
  }), { abortSignal: signal })
  return strip_etag(result.ETag)
}

/** Bounded migration reads: reject ignored Range before buffering any bytes. */
export async function get_object_range(bucket: StorageBucket, key: string, start: number, end: number, etag: string, signal?: AbortSignal) {
  const result = await get_client(bucket).send(new GetObjectCommand({
    Bucket: storage_bucket_name(bucket), Key: key, Range: `bytes=${start}-${end}`, IfMatch: `"${etag}"`,
  }), { abortSignal: signal })
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(result.ContentRange ?? '')
  if (result.$metadata.httpStatusCode !== 206 || Number(result.ContentLength) !== end - start + 1 || ! range || Number(range[1]) !== start || Number(range[2]) !== end || Number(range[3]) <= end) {
    if (result.Body instanceof Readable)
      result.Body.destroy()
    throw new Error('Migration source did not honor the bounded range')
  }
  if (signal && result.Body instanceof Readable)
    addAbortSignal(signal, result.Body)
  const bytes = await result.Body!.transformToByteArray()
  if (bytes.length !== end - start + 1)
    throw new Error('Migration source returned a truncated range')
  return bytes
}

export async function upload_part(bucket: StorageBucket, key: string, upload_id: string, part_number: number, body: Uint8Array, signal?: AbortSignal) {
  const result = await get_client(bucket).send(new UploadPartCommand({
    Bucket: storage_bucket_name(bucket), Key: key, UploadId: upload_id, PartNumber: part_number, Body: body,
  }), { abortSignal: signal })
  const etag = strip_etag(result.ETag)
  if (! etag)
    throw new Error('Migration part returned no ETag')
  return { part_number, etag, size: body.length }
}

/** Hash a full object without materializing it in memory, pinned to its ETag. */
export async function object_sha256(bucket: StorageBucket, key: string, etag: string, signal?: AbortSignal) {
  const result = await get_client(bucket).send(new GetObjectCommand({
    Bucket: storage_bucket_name(bucket), Key: key, IfMatch: `"${etag}"`,
  }), { abortSignal: signal })
  if (! (result.Body instanceof Readable))
    throw new Error('Storage returned no readable object stream')
  if (signal)
    addAbortSignal(signal, result.Body)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of result.Body) {
    hash.update(chunk)
    size += chunk.length
  }
  if (size !== Number(result.ContentLength))
    throw new Error('Storage returned a truncated object stream')
  return { sha256: hash.digest('hex'), size }
}

/** Signs a single part's PUT (the client uploads bytes straight to the object store). */
export async function signed_part_upload_url(bucket: StorageBucket, key: string, upload_id: string, part_number: number, expires_in: number) {
  return await signed_object_url(bucket, new UploadPartCommand({
    Bucket: storage_bucket_name(bucket),
    Key: key,
    UploadId: upload_id,
    PartNumber: part_number,
  }), expires_in)
}

/** Signs a whole-object PUT, for files small enough to skip multipart. */
export async function signed_put_url(bucket: StorageBucket, key: string, content_type: string | null, expires_in: number) {
  return await signed_object_url(bucket, new PutObjectCommand({
    Bucket: storage_bucket_name(bucket),
    Key: key,
    ContentType: content_type || undefined,
    CacheControl: cache_control(bucket),
  }), expires_in)
}
