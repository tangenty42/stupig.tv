import { ApiError } from '@server/errors/ApiError'

/** Provider identity is independent of confidentiality and legacy bucket flags. */
export function storage_location_of(row: { storage_provider?: string, storage_bucket: string }) {
  if (row.storage_provider === 'aliyun')
    return 'aliyun' as const
  if (row.storage_provider !== undefined && row.storage_provider !== 'legacy')
    throw new ApiError(503, '未知的存储提供方')
  if (row.storage_bucket === 'public')
    return 'legacy_public' as const
  if (row.storage_bucket === 'private')
    return 'legacy_private' as const
  throw new ApiError(503, '未知的原存储桶位置')
}
