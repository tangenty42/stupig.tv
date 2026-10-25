import type { create_aliyun_oss } from '@server/lib/aliyun-oss'
import { createHash } from 'node:crypto'
import { ApiError } from '@server/errors/ApiError'
import { z } from 'zod'

export const image_object_identity = z.strictObject({
  key: z.string().regex(/^content\/att\/[\w/.-]+$/).max(512),
  etag: z.string().min(1).max(255), version_id: z.string().min(1).max(255),
  size: z.number().int().positive(), sha256: z.string().regex(/^[\da-f]{64}$/),
})
export type ImageObjectIdentity = z.infer<typeof image_object_identity>
type Storage = Pick<ReturnType<typeof create_aliyun_oss>, 'head_object' | 'get_object_access' | 'get_object_stream' | 'copy_object'>

export function image_original_key(group: string, attempt: string) {
  if (! /^[\da-f]{32}$/.test(group) || ! /^[\da-f]{32}$/.test(attempt))
    throw new ApiError(400, '原图归档标识无效')
  return `content/att/originals/${group}/${attempt}`
}

/** Read back the exact private object; ETags alone are not content digests. */
export async function verify_image_original(storage: Storage, key: string, expected: Pick<ImageObjectIdentity, 'size' | 'sha256'>, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const head = await storage.head_object(key)
  if (! head.version_id || head.size !== expected.size || await storage.get_object_access(key) !== 'private')
    throw new ApiError(409, '原图归档大小、版本或访问权限校验失败')
  const { stream, size } = await storage.get_object_stream(key, head.etag, signal)
  if (size !== expected.size) {
    stream.destroy()
    throw new ApiError(409, '原图归档读取大小不一致')
  }
  const digest = createHash('sha256')
  let length = 0
  for await (const chunk of stream) {
    length += chunk.length
    if (length > expected.size) {
      stream.destroy()
      throw new ApiError(409, '原图归档超过预期大小')
    }
    digest.update(chunk)
  }
  const after = await storage.head_object(key)
  if (length !== expected.size || digest.digest('hex') !== expected.sha256 || after.etag !== head.etag || after.version_id !== head.version_id)
    throw new ApiError(409, '原图归档内容或版本校验失败')
  return { key, etag: head.etag, version_id: head.version_id, size: expected.size, sha256: expected.sha256 }
}

/** The caller must persist target ownership (job/attempt IDs) before this write. */
export async function copy_image_original(storage: Storage, source: ImageObjectIdentity, target: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const head = await storage.head_object(source.key)
  if (head.etag !== source.etag || head.version_id !== source.version_id || head.size !== source.size || await storage.get_object_access(source.key) !== 'private')
    throw new ApiError(409, '归档原图来源已变化')
  await storage.copy_object(source.key, target, 'private')
  return verify_image_original(storage, target, source, signal)
}
