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
  /** Cover object's ETag for local attachment covers; rendered as `?version=` to bust the immutable cache. */
  cover_version: string | null
  /** Root-relative object URL for a local-attachment cover; null for external covers. */
  cover_url: string | null
}

export interface ContentStoryAttachment {
  file_name: string
  /** Derived from the file extension; null when unknown. */
  mime_type: string | null
  file_size: number
  is_image: boolean
  /** Object ETag — changes with the object's content; rendered as `?version=` to bust the immutable cache. */
  version: string
  /** Root-relative path; prefix with the static base URL before rendering. */
  url: string
}

export type ContentUploadS3Method = 'PUT' | 'POST' | 'GET' | 'DELETE'

export interface ContentUploadSignRequest {
  story_id: number
  method: ContentUploadS3Method
  key: string
  upload_id?: string
  part_number?: number
  content_type?: string | null
}

export interface ContentUploadSignResponse {
  url: string
  key?: string
}

/** Structural attachment operations that take a scope lock. */
export type ContentOperationKind = 'move' | 'rename' | 'folder_create' | 'folder_delete' | 'delete'

/**
 * A live attachment-operation lock on a scope, published so peers disable the
 * controls the operation would collide with. The lease is stealable after
 * `expires_at`, so consumers must treat it as advisory and still handle a 409.
 */
export interface ContentOperationLock {
  kind: ContentOperationKind
  /** UTC ISO timestamp of the lease expiry. */
  expires_at: string
}

export interface ContentStoryDetail extends ContentStorySummary {
  markdown: string
  attachments: ContentStoryAttachment[]
  /** Explicitly created folder paths (empty folders persist as rows). */
  folders: string[]
  /** Editor optimistic-concurrency token; bumps on each confirmed submit. */
  revision: number
  /** In-flight attachment structure change by any client; null when idle. */
  operation_lock: ContentOperationLock | null
}

/** Attachment files and explicit folders of one scope (a story or the orphan pool). */
export interface ContentAttachmentScope {
  attachments: ContentStoryAttachment[]
  folders: string[]
  /** In-flight attachment structure change by any client; null when idle. */
  operation_lock: ContentOperationLock | null
}

export interface ContentStoryCreated {
  id: number
}
