import type { ContentStoryAttachment } from '@shared/types/content'
import { escapeHtml } from 'markdown-it/lib/common/utils.mjs'
import { image_lqip_style } from './lqip'

export function story_front_cover_url(static_url: (path: string) => string, cover: string, cover_url?: string | null) {
  const segments = cover.split('/')
  // Bare names and folder paths point at the story's attachments.
  if (! cover.startsWith('#') && ! /^[a-z][\w+.-]*:/i.test(cover) && segments.every(Boolean))
    return cover_url ? static_url(cover_url) : undefined
  return cover
}

/**
 * Alt text for a cover image: the markdown label (`![label](file.jpg)`) when
 * present, otherwise the cover's file name.
 */
export function cover_alt(cover: string | null | undefined, cover_label: string | null | undefined, fallback: string) {
  const label = cover_label?.trim()
  if (label) {
    return label
  }
  return cover?.split('/').pop() || fallback
}

/** Shared escaped markup for Vue covers and Markdown's string renderer. */
export function render_story_cover(src: string | undefined, alt: string, image: ContentStoryAttachment['image'] | undefined, lqip_max_bytes: number, constrained = false) {
  const dimensions = image && Number.isSafeInteger(image.width) && image.width > 0 && Number.isSafeInteger(image.height) && image.height > 0
    ? ` width="${image.width}" height="${image.height}"`
    : ''
  const lqip = src ? image_lqip_style({ url: src, image }, lqip_max_bytes) : null
  const style = lqip ? ` data-lqip style="${escapeHtml(lqip)}"` : ''
  // Eager loading also avoids stranded lazy loads when keyed list cards move.
  const img = src ? `<img class="built-in-img" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${dimensions} decoding="async" referrerpolicy="no-referrer">` : ''
  return `<span class="img-frame content-cover${constrained ? ' content-cover-constrained' : ''}"${style}${src ? ' aria-busy="true"' : ' data-image-error'}>${img}<span class="image-loading-mask" role="status"><span class="iconify i-lucide:loader-circle" aria-hidden="true"></span><span class="sr-only">图片加载中</span></span><span class="image-unavailable" role="img" aria-label="封面加载失败"><span class="iconify i-lucide:image-off" aria-hidden="true"></span></span></span>`
}
