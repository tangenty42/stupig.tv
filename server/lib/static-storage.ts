import { ApiError } from '@server/errors/ApiError'
import { create_aliyun_oss } from '@server/lib/aliyun-oss'
import { log_error } from '@server/lib/log'

function avatar_key(key: string) {
  if (! /^avatar\/[^/\\?\0\r\n]+\.(?:jpg|png|webp)$/.test(key))
    throw new ApiError(400, '头像对象标识无效')
  return key
}

/** Public delivery goes through ESA; the origin object remains private. */
export async function put_avatar(key: string, bytes: Uint8Array, content_type: string | null) {
  const result = await create_aliyun_oss().put_object(avatar_key(key), bytes, content_type, 'private')
  return result.etag
}

export async function delete_avatar_best_effort(key: string) {
  avatar_key(key)
  try {
    await create_aliyun_oss().soft_delete_object(key)
  }
  catch {
    log_error('avatar-storage-delete-failed', { key })
  }
}
