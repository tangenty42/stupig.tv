import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '@shared/env'

interface StoredObject {
  key: string
  size: number
  etag: string | null
  last_modified: Date | null
}

let client: S3Client | null = null

/** S3 wraps ETags in double quotes; strip them for use in URLs. */
function strip_etag(etag: string | undefined) {
  return etag ? etag.replaceAll('"', '') : null
}

function get_client() {
  client ??= new S3Client({
    endpoint: env.OSS_ENDPOINT,
    region: env.OSS_REGION,
    forcePathStyle: env.OSS_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.OSS_ACCESS_KEY_ID,
      secretAccessKey: env.OSS_ACCESS_KEY_SECRET,
    },
  })
  return client
}

export async function put_object(key: string, body: Uint8Array, content_type: string | null) {
  const result = await get_client().send(new PutObjectCommand({
    Bucket: env.OSS_BUCKET,
    Key: key,
    Body: body,
    ContentType: content_type || undefined,
    CacheControl: 'public, max-age=31536000, immutable',
  }))
  return strip_etag(result.ETag)
}

export async function signed_object_url(command: unknown, expires_in: number) {
  return getSignedUrl(get_client(), command as Parameters<typeof getSignedUrl>[1], { expiresIn: expires_in })
}

function copy_source(key: string) {
  return `${env.OSS_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`
}

export async function copy_object(source_key: string, target_key: string) {
  const result = await get_client().send(new CopyObjectCommand({
    Bucket: env.OSS_BUCKET,
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
    Bucket: env.OSS_BUCKET,
    Key: key,
  }))
}

export async function delete_prefix(prefix: string) {
  let continuation_token: string | undefined
  do {
    const page = await get_client().send(new ListObjectsV2Command({
      Bucket: env.OSS_BUCKET,
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
    Bucket: env.OSS_BUCKET,
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
      Bucket: env.OSS_BUCKET,
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
