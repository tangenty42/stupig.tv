import type { ContentEventPrecision } from '../content-markdown'

export type { ContentEventPrecision }

export interface ContentStorySummary {
  id: number
  title: string
  rating: number
  event_precision: ContentEventPrecision
  /** 'YYYY-MM-DD' strings; month-precision stories use the first day of the month. */
  event_dates: string[]
  created_at: string
  updated_at: string
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
