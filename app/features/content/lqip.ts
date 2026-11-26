import type { ContentStoryAttachment } from '@shared/types/content'
import { attachment_can_read } from '~/features/content/attachments/rules'

/** Only a bounded inline JPEG may enter CSS; never accept a URL from metadata. */
function image_lqip_background(attachment: Pick<ContentStoryAttachment, 'url' | 'image'> | undefined, max_bytes: number) {
  const image = attachment?.image
  if (! attachment || ! attachment_can_read(attachment) || ! image?.lqip || ! Number.isSafeInteger(image.revision) || image.revision < 1
    || ! Number.isSafeInteger(image.width) || ! Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1
    || ! Number.isSafeInteger(max_bytes) || max_bytes < 0
    || image.lqip.length > 'data:image/jpeg;base64,'.length + Math.ceil(max_bytes / 3) * 4
    || ! /^data:image\/jpeg;base64,[A-Z0-9+/]+={0,2}$/i.test(image.lqip)) {
    return null
  }
  return `url(${image.lqip})`
}

export function image_lqip_style(attachment: (Pick<ContentStoryAttachment, 'url' | 'image'> & Partial<ContentStoryAttachment>) | undefined, max_bytes: number) {
  const background = image_lqip_background(attachment, max_bytes)
  return background ? `--content-lqip:${background}` : null
}
