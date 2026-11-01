import { settings } from './settings'

/** Shared admission budget; the server still inspects actual bytes after sealing. */
export function image_upload_error(bytes: number, size?: { width: number, height: number }) {
  const limits = settings.app.content.image
  if (bytes <= 0 || bytes > limits.uploadMaxBytes)
    return `图片不能为空且不能超过 ${limits.uploadMaxBytes / 1024 ** 2} MiB，请压缩后重试`
  if (size && (! Number.isSafeInteger(size.width) || ! Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1))
    return '无法读取有效的图片尺寸，请检查文件'
  if (size && (size.width > limits.uploadMaxDimension || size.height > limits.uploadMaxDimension || size.width * size.height > limits.uploadMaxPixels))
    return `图片尺寸 ${size.width}×${size.height} 超过上限：宽高均不超过 ${limits.uploadMaxDimension}px，总像素不超过 ${limits.uploadMaxPixels.toLocaleString('en-US')}，请缩小后重试`
  return null
}
