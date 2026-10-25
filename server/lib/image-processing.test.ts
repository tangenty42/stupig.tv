import type { ImageProcessingOptions } from './image-processing'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { process_image_variants } from './image-processing'

const options: ImageProcessingOptions = {
  maxInputBytes: 1024 * 1024,
  maxPixels: 10000,
  avifQuality: 65,
  avifEffort: 0,
  jpegQuality: 85,
  jpegBackground: '#ffffff',
  lqipMaxDimension: 4,
  lqipQuality: 30,
  timeoutSeconds: 10,
}

describe('real sharp image variants', () => {
  it('keeps source bytes, strips metadata and derives JPEG/LQIP from the final AVIF', async () => {
    const input = await sharp({ create: { width: 12, height: 8, channels: 4, background: '#ff000080' } }).png().withExif({ IFD0: { Artist: 'private-source' } }).toBuffer()
    const original = Buffer.from(input)
    const result = await process_image_variants(input, options)
    expect(input).toEqual(original)
    expect(result).toMatchObject({ width: 12, height: 8 })
    expect((await sharp(result.avif).metadata()).format).toBe('heif')
    const jpeg_meta = await sharp(result.jpeg).metadata()
    expect(jpeg_meta).toMatchObject({ format: 'jpeg', width: 12, height: 8, hasAlpha: false })
    expect(jpeg_meta.exif).toBeUndefined()
    expect((await sharp(result.avif).metadata()).exif).toBeUndefined()
    const expected_jpeg = await sharp(result.avif).flatten({ background: options.jpegBackground }).jpeg({ quality: options.jpegQuality }).toBuffer()
    expect(result.jpeg).toEqual(expected_jpeg)
    expect((await sharp(result.lqip).metadata()).width).toBe(4)
  })

  it('normalizes EXIF orientation before stripping it', async () => {
    const input = await sharp({ create: { width: 12, height: 8, channels: 3, background: 'red' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    expect(await process_image_variants(input, options)).toMatchObject({ width: 8, height: 12 })
  })

  it('bounds both LQIP dimensions for tall images', async () => {
    const input = await sharp({ create: { width: 2, height: 100, channels: 3, background: 'red' } }).png().toBuffer()
    const result = await process_image_variants(input, options)
    const metadata = await sharp(result.lqip).metadata()
    expect(metadata.width).toBeLessThanOrEqual(options.lqipMaxDimension)
    expect(metadata.height).toBeLessThanOrEqual(options.lqipMaxDimension)
  })

  it('rejects invalid input and budgets without a partial result', async () => {
    await expect(process_image_variants(Buffer.alloc(0), options)).rejects.toThrow('图片文件为空')
    await expect(process_image_variants(Buffer.from('broken'), options)).rejects.toThrow('图片无法处理')
    const input = await sharp({ create: { width: 12, height: 8, channels: 3, background: 'red' } }).png().toBuffer()
    await expect(process_image_variants(input, { ... options, maxPixels: 10 })).rejects.toThrow('图片总像素超过 10 上限')
    await expect(process_image_variants(input, { ... options, maxInputBytes: 1 })).rejects.toThrow('处理大小限制')
    await expect(process_image_variants(input, { ... options, avifQuality: 0 })).rejects.toThrow('图片处理参数无效')
    await expect(process_image_variants(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'), options)).rejects.toThrow('暂不支持')
  })

  it('does not silently flatten an animation into its first frame', async () => {
    const animation = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAAKAAAALAAAAAABAAEAAAICRAEAIfkEAAoAAAAsAAAAAAEAAQAAAgJEAQA7', 'base64')
    await expect(process_image_variants(animation, options)).rejects.toThrow('暂不支持')
  })

  it('accepts the pixel boundary and rejects an image one pixel above it', async () => {
    const input = await sharp({ create: { width: 12, height: 8, channels: 3, background: 'red' } }).jpeg().toBuffer()
    expect(await process_image_variants(input, { ... options, maxPixels: 96 })).toMatchObject({ width: 12, height: 8 })
    await expect(process_image_variants(input, { ... options, maxPixels: 95 })).rejects.toThrow('图片总像素超过 95 上限')
  })
})
