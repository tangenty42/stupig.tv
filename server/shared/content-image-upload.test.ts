import { expect, it } from 'vitest'
import { image_upload_error } from './content-image-upload'
import { settings } from './settings'

it('allows the exact inclusive byte, side and pixel boundaries', () => {
  const limits = settings.app.content.image
  expect(image_upload_error(limits.uploadMaxBytes, { width: 6000, height: 4000 })).toBeNull()
  expect(image_upload_error(1, { width: 4000, height: 6000 })).toBeNull()
  expect(image_upload_error(1, { width: 4096, height: 3072 })).toBeNull()
  expect(image_upload_error(1, { width: 3072, height: 4096 })).toBeNull()
  expect(image_upload_error(1, { width: 8192, height: 2048 })).toBeNull()
  expect(image_upload_error(1, { width: 2048, height: 8192 })).toBeNull()
  expect(image_upload_error(limits.uploadMaxBytes + 1)).toContain('20 MiB')
  expect(image_upload_error(1, { width: 8193, height: 1 })).toContain('8192px')
  expect(image_upload_error(1, { width: 1, height: 8193 })).toContain('8192px')
  expect(image_upload_error(1, { width: 8192, height: 2049 })).toBeNull()
  expect(image_upload_error(1, { width: 6000, height: 4001 })).toContain('24,000,000')
  expect(image_upload_error(1, { width: Number.NaN, height: 1 })).toContain('有效')
})
