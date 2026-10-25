import type { ContentStoryAttachment } from '@shared/types/content'
import { settings } from '@shared/settings'
import { attachment_can_read } from './attachment'

/** Only a bounded inline JPEG may enter CSS; never accept a URL from metadata. */
export function image_lqip_style(attachment: (Pick<ContentStoryAttachment, 'url' | 'image'> & Partial<ContentStoryAttachment>) | undefined) {
  const image = attachment?.image
  if (! attachment || ! attachment_can_read(attachment) || ! image?.lqip || ! Number.isSafeInteger(image.revision) || image.revision < 1
    || ! Number.isSafeInteger(image.width) || ! Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1
    || image.lqip.length > 'data:image/jpeg;base64,'.length + Math.ceil(settings.app.content.image.lqipMaxBytes / 3) * 4
    || ! /^data:image\/jpeg;base64,[A-Z0-9+/]+={0,2}$/i.test(image.lqip)) {
    return null
  }
  return `--content-lqip:url(${image.lqip})`
}

/** A representation switch must not reuse the previous image's settled state. */
export function reset_image_placeholder(image: HTMLImageElement) {
  const frame = image.parentElement
  if (! frame)
    return
  delete frame.dataset.imageLoaded
  delete frame.dataset.imageError
  frame.setAttribute('aria-busy', 'true')
}

/** DOM-owned loading state, including raw formats without an LQIP. */
export function observe_image_placeholders(root: HTMLElement) {
  const cleanups: (() => void)[] = []
  root.querySelectorAll<HTMLImageElement>('.img-frame > img').forEach((image) => {
    const frame = image.parentElement!
    reset_image_placeholder(image)
    const loaded = () => {
      if (image.naturalWidth > 0) {
        frame.dataset.imageLoaded = ''
        delete frame.dataset.imageError
        frame.removeAttribute('aria-busy')
      }
    }
    const failed = () => {
      delete frame.dataset.imageLoaded
      frame.dataset.imageError = ''
      frame.removeAttribute('aria-busy')
    }
    image.addEventListener('load', loaded)
    image.addEventListener('error', failed)
    if (image.complete)
      image.naturalWidth > 0 ? loaded() : failed()
    cleanups.push(() => {
      image.removeEventListener('load', loaded)
      image.removeEventListener('error', failed)
    })
  })
  return () => cleanups.forEach(cleanup => cleanup())
}
