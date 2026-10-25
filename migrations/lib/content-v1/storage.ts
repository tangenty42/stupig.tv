import type { MigrationContext } from '../../../scripts/migration/contract'
import type { Node } from './plan'
import { createDecipheriv } from 'node:crypto'
import { addAbortSignal, Readable } from 'node:stream'
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { load_migration_source_config } from '@config/loader'
import { canonical, digest } from './plan'

export interface SourceIdentity { key: string, size: number, etag: string, version_id: string | null, location: string }
export interface Source { head: () => Promise<SourceIdentity>, read: (identity: SourceIdentity) => Promise<Readable> }
export async function source_for(ctx: MigrationContext, row: Node, key = row.object_key): Promise<Source> {
  if (! key)
    throw new Error('source_key_missing')
  if (row.storage_provider === 'aliyun') {
    const target = await ctx.oss()
    return {
      head: async () => {
        const result = await target.head_object(key)
        if (key === row.object_key && (result.etag !== row.version || result.size !== Number(row.file_size) || (row.oss_version_id && result.version_id !== row.oss_version_id)))
          throw new Error('migration_source_row_identity_changed')
        return { ... result, key, location: 'aliyun' }
      },
      read: async identity => (await target.get_object_stream(key, identity.etag, ctx.signal)).stream,
    }
  }
  const config = load_migration_source_config(row.storage_bucket)
  const client = new S3Client({ region: config.region, endpoint: config.endpoint, forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.accessKeySecret },
    requestHandler: { connectionTimeout: config.connectionTimeoutMs, requestTimeout: config.requestTimeoutMs, socketTimeout: config.requestTimeoutMs, throwOnRequestTimeout: true } })
  const location = digest(JSON.stringify([config.endpoint, config.bucket, config.region]))
  return {
    async head() {
      await ctx.assert_active()
      const result = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal: ctx.signal })
      const etag = result.ETag?.replaceAll('"', '')
      const size = Number(result.ContentLength)
      if (! etag || ! Number.isSafeInteger(size) || size < 0)
        throw new Error('source_identity_invalid')
      return { key, size, etag, version_id: result.VersionId ?? null, location }
    },
    async read(identity) {
      await ctx.assert_active()
      const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key, IfMatch: `"${identity.etag}"`, VersionId: identity.version_id ?? undefined }), { abortSignal: ctx.signal })
      if (! (result.Body instanceof Readable) || Number(result.ContentLength) !== identity.size)
        throw new Error('source_stream_invalid')
      addAbortSignal(ctx.signal, result.Body)
      return result.Body
    },
  }
}

/** Authenticate the entire AES-GCM stream before the caller can Complete its upload. */
export async function* plaintext(source: Source, identity: SourceIdentity, encryption_key: string | null, signal: AbortSignal) {
  const stream = await source.read(identity)
  let seen = 0
  let pending = Buffer.alloc(0)
  let decipher: ReturnType<typeof createDecipheriv> | null = null
  try {
    for await (const value of stream) {
      signal.throwIfAborted()
      const bytes = Buffer.from(value)
      seen += bytes.length
      if (! encryption_key) {
        yield bytes
        continue
      }
      pending = Buffer.concat([pending, bytes])
      if (! decipher && pending.length >= 12) {
        const key = Buffer.from(encryption_key, 'base64')
        if (key.length !== 32 || key.toString('base64') !== encryption_key)
          throw new Error('invalid_encryption_key')
        decipher = createDecipheriv('aes-256-gcm', key, pending.subarray(0, 12))
        pending = pending.subarray(12)
      }
      if (decipher && pending.length > 16) {
        const end = pending.length - 16
        yield decipher.update(pending.subarray(0, end))
        pending = Buffer.from(pending.subarray(end))
      }
    }
    if (seen !== identity.size)
      throw new Error('source_truncated')
    if (encryption_key) {
      if (! decipher || pending.length !== 16) {
        throw new Error('invalid_ciphertext')
      }
      const authenticated = decipher as ReturnType<typeof createDecipheriv> & { setAuthTag: (bytes: Uint8Array) => void }
      authenticated.setAuthTag(pending)
      yield decipher.final()
    }
    if (canonical(await source.head()) !== canonical(identity))
      throw new Error('source_changed')
  }
  finally { stream.destroy() }
}

export async function* chunked(stream: AsyncIterable<Uint8Array>, size: number) {
  if (! Number.isSafeInteger(size) || size <= 0)
    throw new Error('invalid_chunk_size')
  let buffer = Buffer.alloc(size)
  let used = 0
  for await (const input of stream) {
    let offset = 0
    while (offset < input.length) {
      const count = Math.min(size - used, input.length - offset)
      buffer.set(input.subarray(offset, offset + count), used)
      offset += count
      used += count
      if (used === size) {
        yield buffer
        buffer = Buffer.alloc(size)
        used = 0
      }
    }
  }
  if (used)
    yield buffer.subarray(0, used)
}
