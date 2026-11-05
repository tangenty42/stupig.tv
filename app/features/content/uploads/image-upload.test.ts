import sharp from 'sharp'
import { expect, it, vi } from 'vitest'
import { image_upload_size } from './image-upload'

it.each(['png', 'jpeg', 'webp', 'avif'] as const)('reads real %s headers without decoding or reading the whole file', async (format) => {
  const bytes = await sharp({ create: { width: 37, height: 21, channels: 3, background: '#aabbcc' } }).toFormat(format).toBuffer()
  const file = new File([new Uint8Array(bytes)], `image.${format}`)
  const full = vi.spyOn(file, 'arrayBuffer')
  const slices = vi.spyOn(file, 'slice')
  expect(await image_upload_size(file)).toEqual({ width: 37, height: 21 })
  expect(full).not.toHaveBeenCalled()
  expect(slices.mock.calls.every(([, end], i) => Number(end) - Number(slices.mock.calls[i]![0] ?? 0) <= 32)).toBe(true)
})

it('skips large JPEG metadata rather than reading or hashing it', async () => {
  const jpeg = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#123456' } }).jpeg().toBuffer()
  const app = Buffer.alloc(65535)
  app.writeUInt16BE(0xFFE1, 0)
  app.writeUInt16BE(65533, 2)
  const file = new File([jpeg.subarray(0, 2), app, jpeg.subarray(2)], 'metadata.jpg')
  expect(await image_upload_size(file)).toEqual({ width: 3, height: 2 })
})

it('fails closed on truncated or invalid boxes and unsupported images', async () => {
  for (const data of [Buffer.from('not an image'), Buffer.from([0xFF, 0xD8]), Buffer.from('0000ftyp00000000')])
    await expect(image_upload_size(new Blob([data]))).rejects.toThrow()
})
