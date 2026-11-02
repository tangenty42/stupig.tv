import type { create_aliyun_oss } from './aliyun-oss'
import { ApiError } from '@server/errors/ApiError'

type Storage = Pick<ReturnType<typeof create_aliyun_oss>, 'head_object' | 'get_object_access'>
type Identity = Awaited<ReturnType<Storage['head_object']>>
export type PrivateOssObject = Identity & { version_id: string }

/** Metadata identity only: never downloads bytes or treats ETag as a digest. */
export async function verify_private_oss_object(storage: Storage, key: string, expected: Partial<Identity>, message: string): Promise<PrivateOssObject> {
  const [head, access] = await Promise.all([storage.head_object(key), storage.get_object_access(key)])
  if (! head.etag || ! head.version_id || ! Number.isSafeInteger(head.size) || head.size < 0 || access !== 'private'
    || (expected.size !== undefined && head.size !== expected.size)
    || (expected.etag !== undefined && head.etag !== expected.etag)
    || (expected.version_id !== undefined && head.version_id !== expected.version_id)) {
    throw new ApiError(409, message)
  }
  return { ... head, version_id: head.version_id }
}
