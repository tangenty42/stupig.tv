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
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { error_fields, log_error } from '@server/lib/log'
import { runtime_config } from '@shared/config'

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

let client: S3Client | null = null

/** S3 wraps ETags in double quotes; strip them for use in URLs. */
function strip_etag(etag: string | undefined) {
  return etag ? etag.replaceAll('"', '') : null
}

function get_client() {
  client ??= new S3Client({
    endpoint: config.oss.endpoint,
    region: config.oss.region,
    forcePathStyle: config.oss.forcePathStyle,
    credentials: {
      accessKeyId: config.oss.accessKeyId,
      secretAccessKey: config.oss.accessKeySecret,
    },
  })
  return client
}

export async function put_object(key: string, body: Uint8Array, content_type: string | null) {
  const result = await get_client().send(new PutObjectCommand({
    Bucket: config.oss.bucket,
    Key: key,
    Body: body,
    ContentType: content_type || undefined,
    CacheControl: 'public, max-age=31536000, immutable',
  }))
  return strip_etag(result.ETag)
}

/** Downloads an object's bytes (server-side transforms like attachment encryption). */
export async function get_object(key: string) {
  const result = await get_client().send(new GetObjectCommand({
    Bucket: config.oss.bucket,
    Key: key,
  }))
  return new Uint8Array(await result.Body!.transformToByteArray())
}

export async function signed_object_url(command: unknown, expires_in: number) {
  return getSignedUrl(get_client(), command as Parameters<typeof getSignedUrl>[1], { expiresIn: expires_in })
}

function copy_source(key: string) {
  return `${config.oss.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`
}

export async function copy_object(source_key: string, target_key: string) {
  const result = await get_client().send(new CopyObjectCommand({
    Bucket: config.oss.bucket,
    Key: target_key,
    CopySource: copy_source(source_key),
    MetadataDirective: 'COPY',
  }))
  return strip_etag(result.CopyObjectResult?.ETag)
}

// Aliyun OSS rejects the S3 batch delete (DeleteObjects) with MissingContentMD5,
// so deletes go through single-object requests.
export async function delete_object(key: string) {
  await get_client().send(new DeleteObjectCommand({
    Bucket: config.oss.bucket,
    Key: key,
  }))
}

// Business operations must not be blocked by a storage outage, so callers drop
// the error — but a failed delete leaves an orphan object, so it is always
// logged for the reconciliation job to find.
export async function delete_object_best_effort(key: string) {
  try {
    await delete_object(key)
  }
  catch (error) {
    log_error('storage-delete-failed', { key, ... error_fields(error) })
  }
}

export async function delete_prefix(prefix: string) {
  let continuation_token: string | undefined
  do {
    const page = await get_client().send(new ListObjectsV2Command({
      Bucket: config.oss.bucket,
      Prefix: prefix,
      ContinuationToken: continuation_token,
    }))
    const keys = (page.Contents ?? []).flatMap(object => object.Key ? [object.Key] : [])
    await Promise.all(keys.map(key => delete_object(key)))
    continuation_token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuation_token)
}

export async function head_object(key: string) {
  const result = await get_client().send(new HeadObjectCommand({
    Bucket: config.oss.bucket,
    Key: key,
  }))
  return {
    size: Number(result.ContentLength ?? 0),
    content_type: result.ContentType ?? null,
    etag: strip_etag(result.ETag),
  }
}

export async function list_objects(prefix = '') {
  const objects: StoredObject[] = []
  let continuation_token: string | undefined
  do {
    const page = await get_client().send(new ListObjectsV2Command({
      Bucket: config.oss.bucket,
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

export async function list_multipart_uploads(prefix = '') {
  const uploads: MultipartUpload[] = []
  let key_marker: string | undefined
  let upload_id_marker: string | undefined

  do {
    const page = await get_client().send(new ListMultipartUploadsCommand({
      Bucket: config.oss.bucket,
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

export async function abort_multipart_upload(key: string, upload_id: string) {
  await get_client().send(new AbortMultipartUploadCommand({
    Bucket: config.oss.bucket,
    Key: key,
    UploadId: upload_id,
  }))
}

export async function create_multipart_upload(key: string, content_type: string | null) {
  const result = await get_client().send(new CreateMultipartUploadCommand({
    Bucket: config.oss.bucket,
    Key: key,
    ContentType: content_type || undefined,
    CacheControl: 'public, max-age=31536000, immutable',
  }))
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

export async function list_parts(key: string, upload_id: string) {
  const parts: UploadedPart[] = []
  let marker: string | undefined
  do {
    const page = await get_client().send(new ListPartsCommand({
      Bucket: config.oss.bucket,
      Key: key,
      UploadId: upload_id,
      PartNumberMarker: marker,
    }))
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

export async function complete_multipart_upload(key: string, upload_id: string, parts: UploadedPart[]) {
  const result = await get_client().send(new CompleteMultipartUploadCommand({
    Bucket: config.oss.bucket,
    Key: key,
    UploadId: upload_id,
    MultipartUpload: {
      Parts: [... parts]
        .sort((left, right) => left.part_number - right.part_number)
        .map(part => ({ PartNumber: part.part_number, ETag: part.etag })),
    },
  }))
  return strip_etag(result.ETag)
}

/** Signs a single part's PUT (the client uploads bytes straight to the object store). */
export async function signed_part_upload_url(key: string, upload_id: string, part_number: number, expires_in: number) {
  return await signed_object_url(new UploadPartCommand({
    Bucket: config.oss.bucket,
    Key: key,
    UploadId: upload_id,
    PartNumber: part_number,
  }), expires_in)
}

/** Signs a whole-object PUT, for files small enough to skip multipart. */
export async function signed_put_url(key: string, content_type: string | null, expires_in: number) {
  return await signed_object_url(new PutObjectCommand({
    Bucket: config.oss.bucket,
    Key: key,
    ContentType: content_type || undefined,
    CacheControl: 'public, max-age=31536000, immutable',
  }), expires_in)
}
