import { expect, it } from 'vitest'
import { image_upload_error } from './content-image-upload'
import { settings } from './settings'

it('allows the exact inclusive byte, side and pixel boundaries', () => {
  const limits = settings.app.content.image
  expect(image_upload_error(limits.uploadMaxBytes, { width: 4096, height: 2304 })).toBeNull()
  expect(image_upload_error(limits.uploadMaxBytes + 1)).toContain('20 MiB')
  expect(image_upload_error(1, { width: 4097, height: 1 })).toContain('4096px')
  expect(image_upload_error(1, { width: 1, height: 4097 })).toContain('4096px')
  expect(image_upload_error(1, { width: 4096, height: 2305 })).toContain('9,437,184')
  expect(image_upload_error(1, { width: Number.NaN, height: 1 })).toContain('有效')
})
