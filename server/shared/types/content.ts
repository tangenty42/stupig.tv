import type { ContentEventPrecision } from '../content-markdown'

export type { ContentEventPrecision }
export type { ContentRating, ContentRatingInput, ContentRatingTier } from '../content-markdown'
export { content_rating_tiers, pinned_label, rating_label, story_pinned, story_rating, story_rating_rank, unrated_content_rating } from '../content-markdown'

export interface ContentStorySummary {
  id: number
  title: string
  /** Space-separated front matter labels; `#`-prefixed ones are hidden rating tiers. */
  labels: string[]
  event_precision: ContentEventPrecision
  /** 'YYYY-MM-DD' strings; month-precision stories use the first day of the month. */
  event_dates: string[]
  created_at: string
  updated_at: string
  /** Plain-text description from the markdown front matter, shown under the title. */
  desc: string | null
  /** Cover image link from the markdown front matter (attachment file name or external URL). */
  cover: string | null
  /** Cover image alt text (`![label](file.jpg)`); null when written as a bare link. */
  cover_label: string | null
}

export interface ContentStoryAttachment {
  file_name: string
  mime_type: string | null
  file_size: number
  is_image: boolean
  /** Root-relative path; prefix with the static base URL before rendering. */
  url: string
}

export interface ContentStoryDetail extends ContentStorySummary {
  markdown: string
  attachments: ContentStoryAttachment[]
}

export interface ContentStoryCreated {
  id: number
}
