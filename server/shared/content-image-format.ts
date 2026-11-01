/** Physical encodings are independent from the persisted display/fallback roles. */
export const content_image_formats = {
  display: { extension: 'webp', mime: 'image/webp' },
  fallback: { extension: 'jpg', mime: 'image/jpeg' },
  placeholder: { mime: 'image/jpeg' },
} as const

export type ContentImageRole = 'display' | 'fallback'
