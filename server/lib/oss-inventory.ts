import type { aliyun_oss_config_schema } from '@config/schema'
import type { z } from 'zod'
import { ApiError } from '@server/errors/ApiError'
import OSS from 'ali-oss'

export interface InventoryObject { key: string, size: number, modified_at: Date }

/** Only current-object metadata. No object bodies, mutation or version deletion. */
export function create_oss_inventory(config: z.infer<typeof aliyun_oss_config_schema>) {
  const client = new OSS({ ... config, secure: true, authorizationV4: true, timeout: config.timeoutMs })
  async function list(after: string, limit: number, prefix?: string) {
    if (! Number.isSafeInteger(limit) || limit < 1 || limit > 100 || Buffer.byteLength(after) > 1024)
      throw new ApiError(400, 'OSS 盘点游标或批量无效')
    // Omit unused fields: V4 signing and urllib disagree on undefined queries.
    const result = await client.listV2({ ... (after ? { 'start-after': after } : {}), 'max-keys': limit, ... (prefix === undefined ? {} : { prefix }) }, {})
    const objects = result.objects ?? []
    if (! Array.isArray(objects) || typeof result.isTruncated !== 'boolean' || objects.length > limit || (result.isTruncated && ! objects.length))
      throw new ApiError(502, 'OSS 盘点分页无效')
    let previous = after
    const page = objects.map((object) => {
      const key = object.name
      const modified_at = new Date(object.lastModified)
      if (! key || Buffer.byteLength(key) > 1024 || ! Number.isSafeInteger(object.size) || object.size < 0
        || ! Number.isFinite(modified_at.getTime()) || (previous && Buffer.compare(Buffer.from(key), Buffer.from(previous)) <= 0)) {
        throw new ApiError(502, 'OSS 盘点对象或排序无效')
      }
      previous = key
      return { key, size: object.size, modified_at }
    })
    return { objects: page, truncated: result.isTruncated }
  }
  return {
    list_page: (after: string, limit: number) => list(after, limit),
    async find_object(key: string) {
      return (await list('', 1, key)).objects.find(object => object.key === key) ?? null
    },
  }
}
