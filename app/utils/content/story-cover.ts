import type { ContentStoryAttachment } from '@shared/types/content'
import { escapeHtml } from 'markdown-it/lib/common/utils.mjs'
import { image_lqip_style } from './lqip'

/** Shared escaped markup for Vue covers and Markdown's string renderer. */
export function render_story_cover(src: string | undefined, alt: string, image?: ContentStoryAttachment['image'], constrained = false) {
  const dimensions = image && Number.isSafeInteger(image.width) && image.width > 0 && Number.isSafeInteger(image.height) && image.height > 0
    ? ` width="${image.width}" height="${image.height}"`
    : ''
  const lqip = src ? image_lqip_style({ url: src, image }) : null
  const style = lqip ? ` data-lqip style="${escapeHtml(lqip)}"` : ''
  // Eager loading also avoids stranded lazy loads when keyed list cards move.
  const img = src ? `<img class="built-in-img" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${dimensions} decoding="async" referrerpolicy="no-referrer">` : ''
  return `<span class="img-frame content-cover${constrained ? ' content-cover-constrained' : ''}"${style}${src ? ' aria-busy="true"' : ' data-image-error'}>${img}<span class="image-loading-mask" role="status"><span class="iconify i-lucide:loader-circle" aria-hidden="true"></span><span class="sr-only">图片加载中</span></span><span class="image-unavailable" role="img" aria-label="封面加载失败"><span class="iconify i-lucide:image-off" aria-hidden="true"></span></span></span>`
}
