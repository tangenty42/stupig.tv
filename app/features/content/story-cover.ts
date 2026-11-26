import type { ContentStoryAttachment } from '@shared/types/content'
import { escapeHtml } from 'markdown-it/lib/common/utils.mjs'
import { image_frame_size, render_image_frame } from './image-frame'

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

/** Escaped cover markup for Markdown story references. */
export function render_story_cover(src: string | undefined, alt: string, image: ContentStoryAttachment['image'] | undefined, lqip_max_bytes: number, constrained = false) {
  const size = image_frame_size(image)
  const dimensions = size ? ` width="${size.width}" height="${size.height}"` : ''
  const img = src ? `<img class="built-in-img" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${dimensions} loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''
  return render_image_frame(img, src ? { url: src, image } : undefined, lqip_max_bytes, constrained ? 'constrained-cover' : 'cover')
}
