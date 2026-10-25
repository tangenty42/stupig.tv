import type { ContentStoryAttachment } from '@shared/types/content'
import { settings } from '@shared/settings'

/** Deliberately omit every image field when the viewer cannot read its pixels. */
export function image_presentation(row: {
  is_private: number | boolean
  image_revision?: number
  image_metadata?: unknown
  lqip_jpeg?: Buffer | null
  avif_key?: string | null
  jpeg_key?: string | null
  object_key: string | null
  original_key?: string | null
}, private_readable: boolean): ContentStoryAttachment['image'] | undefined {
  if ((row.is_private && ! private_readable) || ! row.avif_key || ! row.jpeg_key || row.object_key !== row.avif_key || ! row.image_revision)
    return undefined
  const metadata = typeof row.image_metadata === 'string' ? JSON.parse(row.image_metadata) : row.image_metadata
  if (! metadata || typeof metadata !== 'object' || ! ('width' in metadata) || ! ('height' in metadata)
    || typeof metadata.width !== 'number' || typeof metadata.height !== 'number' || ! Number.isSafeInteger(metadata.width) || ! Number.isSafeInteger(metadata.height)
    || metadata.width <= 0 || metadata.height <= 0) {
    return undefined
  }
  const bytes = row.lqip_jpeg
  const lqip = Buffer.isBuffer(bytes) && bytes.length >= 4 && bytes.length <= settings.app.content.image.lqipMaxBytes
    && bytes.readUInt16BE(0) === 0xFFD8 && bytes.readUInt16BE(bytes.length - 2) === 0xFFD9
    ? `data:image/jpeg;base64,${bytes.toString('base64')}`
    : null
  return { revision: Number(row.image_revision), width: metadata.width, height: metadata.height, lqip, has_original: Boolean(row.original_key) }
}
