import type { ContentStoryAttachment } from '@shared/types/content'
import { escapeHtml } from 'markdown-it/lib/common/utils.mjs'
import { image_lqip_style } from './lqip'

const image_lqip_layer = '<span class="image-lqip" aria-hidden="true"></span>'

export function image_loading_mask(label: string) {
  return `<span class="image-loading-mask" role="status"><span class="iconify i-lucide:loader-circle" aria-hidden="true"></span><span class="sr-only">${escapeHtml(label)}</span></span>`
}

export function image_unavailable(label: string) {
  return `<span class="image-unavailable" role="img" aria-label="${escapeHtml(label)}"><span class="iconify i-lucide:image-off" aria-hidden="true"></span></span>`
}

export function image_frame_size(image: ContentStoryAttachment['image']) {
  return image && Number.isSafeInteger(image.width) && image.width > 0
    && Number.isSafeInteger(image.height) && image.height > 0
    ? image
    : undefined
}

export function image_frame_presentation(
  presentation: Pick<ContentStoryAttachment, 'url' | 'image'> | undefined,
  lqip_max_bytes: number,
  layout: 'inline' | 'cover' | 'constrained-cover' = 'inline',
) {
  const size = image_frame_size(presentation?.image)
  const lqip = image_lqip_style(presentation, lqip_max_bytes)
  const dimensions = size ? `--content-image-width:${size.width}px;--content-image-ratio:${size.width / size.height}` : ''
  const style = [lqip, dimensions].filter(Boolean).join(';')
  const cover = layout === 'inline' ? '' : ' content-cover'
  const constrained = layout === 'constrained-cover' ? ' content-cover-constrained' : ''
  return { size, lqip, style, class_name: `img-frame${cover}${constrained}` }
}

/** Wraps already escaped image markup from the Markdown renderer. */
export function render_image_frame(
  img: string,
  presentation: Pick<ContentStoryAttachment, 'url' | 'image'> | undefined,
  lqip_max_bytes: number,
  layout: 'inline' | 'cover' | 'constrained-cover' = 'inline',
  overlay = '',
) {
  const { size, lqip, style, class_name } = image_frame_presentation(img ? presentation : undefined, lqip_max_bytes, layout)
  const attributes = [
    lqip ? 'data-lqip' : '',
    size ? 'data-image-sized' : '',
    style ? `style="${escapeHtml(style)}"` : '',
    img ? 'aria-busy="true"' : 'data-image-error',
  ].filter(Boolean).join(' ')
  const layers = [
    img,
    lqip ? image_lqip_layer : '',
    img ? image_loading_mask('图片加载中') : '',
    image_unavailable('图片加载失败'),
    overlay,
  ].join('')
  return `<span class="${class_name}" ${attributes}>${layers}</span>`
}
