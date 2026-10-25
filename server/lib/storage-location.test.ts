import { expect, it } from 'vitest'
import { storage_location_of } from './storage-location'

it('preserves old physical bucket identity and separates the Aliyun provider', () => {
  expect(storage_location_of({ storage_bucket: 'public' })).toBe('legacy_public')
  expect(storage_location_of({ storage_provider: 'legacy', storage_bucket: 'private' })).toBe('legacy_private')
  for (const storage_bucket of ['public', 'private'])
    expect(storage_location_of({ storage_provider: 'aliyun', storage_bucket })).toBe('aliyun')
})

it('does not silently route unknown providers or legacy bucket flags', () => {
  expect(() => storage_location_of({ storage_provider: 'unknown', storage_bucket: 'public' })).toThrow('未知的存储提供方')
  expect(() => storage_location_of({ storage_provider: 'legacy', storage_bucket: 'unknown' })).toThrow('未知的原存储桶位置')
})
