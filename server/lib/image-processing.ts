import type { z } from 'zod'
import { image_processing_options_schema } from '@config/schema'
import { ApiError } from '@server/errors/ApiError'
import sharp from 'sharp'

/** The caller owns deployment budgets and the versioned encoding profile. */
export { image_processing_options_schema }
export type ImageProcessingOptions = z.infer<typeof image_processing_options_schema>

function check_options(options: ImageProcessingOptions) {
  if (! image_processing_options_schema.safeParse(options).success) {
    throw new ApiError(400, '图片处理参数无效')
  }
}

/** No storage/DB side effects: the service publishes only after every output succeeds. */
export async function process_image_variants(input: Buffer, options: ImageProcessingOptions) {
  check_options(options)
  if (! input.length || input.length > options.maxInputBytes)
    throw new ApiError(400, '图片文件为空或超过处理大小限制')
  const open = (data: Buffer) => sharp(data, { limitInputPixels: options.maxPixels, failOn: 'warning', animated: true }).timeout({ seconds: options.timeoutSeconds })
  try {
    const metadata = await open(input).metadata()
    if (! ['png', 'jpeg', 'webp', 'heif'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1)
      throw new ApiError(400, '暂不支持该图片格式、动图或多页图片')
    // Re-open only with controlled options; the original bytes remain untouched.
    // Metadata is stripped by default. Orient pixels before discarding EXIF.
    const avif = await open(input).autoOrient().toColourspace('srgb').avif({ quality: options.avifQuality, effort: options.avifEffort }).toBuffer()
    // Derive both fallbacks from the EXACT final AVIF, not an independent encode
    // from the input. A failure rejects the whole result; nothing is published.
    const jpeg = await open(avif).flatten({ background: options.jpegBackground }).jpeg({ quality: options.jpegQuality }).toBuffer()
    const lqip = await open(avif).resize({ width: options.lqipMaxDimension, height: options.lqipMaxDimension, fit: 'inside', withoutEnlargement: true }).flatten({ background: options.jpegBackground }).jpeg({ quality: options.lqipQuality }).toBuffer()
    const final = await open(avif).metadata()
    return {
      avif,
      jpeg,
      lqip,
      width: final.width!,
      height: final.height!,
    }
  }
  catch (error) {
    if (error instanceof ApiError)
      throw error
    if (error instanceof Error && error.message.includes('Input image exceeds pixel limit'))
      throw new ApiError(400, `图片总像素超过 ${options.maxPixels.toLocaleString('en-US')} 上限，请缩小分辨率后重试`)
    throw new ApiError(400, '图片无法处理，可能是格式损坏、尺寸超限或处理超时')
  }
}
