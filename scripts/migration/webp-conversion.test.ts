import { expect, it } from 'vitest'
import { webp_name } from '../../migrations/lib/webp-v1/convert'

it('preserves the private marker and avoids an occupied WebP logical name', () => {
  expect(webp_name('photo.png.good', new Set(['photo.webp.good']))).toBe('photo_2.webp.good')
})

it('fits a Unicode leaf into the remaining full-path byte budget', () => {
  const name = webp_name('很长的图片名字.png.good', new Set(), 17)
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(17)
  expect(name).toMatch(/\.webp\.good$/)
  expect(webp_name('photo.png', new Set(), 5)).toBe('.webp')
  expect(() => webp_name('photo.png.good', new Set(), 9)).toThrow('webp_path_too_long')
})
