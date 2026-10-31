import type { ContentEventPrecision } from '../content-markdown'
import type { WorkspaceReport } from '../content-workspace'

export type { ContentEventPrecision }
export type { ContentRating, ContentRatingInput, ContentRatingTier } from '../content-markdown'
export { content_rating_tiers, pinned_label, rating_label, story_pinned, story_rating, story_rating_rank, unrated_content_rating } from '../content-markdown'

export interface ContentStorySummary {
  title_revision?: number
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
  /** Stored cover object's ETag; the read identity is carried separately by cover_url. */
  cover_version: string | null
  /** Same-origin, version-bound attachment read URL; null for external covers. */
  cover_url: string | null
  /** Public cover representation only, including a redaction's own dimensions/LQIP. */
  cover_image?: ContentStoryAttachment['image']
}

export interface ContentStoryAttachment {
  /** Authorized, version-bound presentation; absent for unreadable private files. */
  image?: { revision: number, width: number, height: number, lqip: string | null, has_original: boolean }
  has_redacted?: boolean
  is_redacted_view?: boolean
  redacted_url?: string | null
  redacted_image?: ContentStoryAttachment['image']
  node_version?: string
  /** Stable database identity; optional only for cached pre-journal payloads. */
  id?: number
  file_name: string
  /** Derived from the file extension; null when unknown. */
  mime_type: string | null
  file_size: number
  is_image: boolean
  /** Object ETag; distinct from the read-identity hash in url and the workspace node_version. */
  version: string
  /** Same-origin attachment read URL with a version-bound identity; null when unreadable. */
  url: string | null
  /** Confidentiality flag; current attachment objects contain plaintext. */
  is_private?: boolean
}

/** Body projection carries no attachment/task arrays or decryption material. */
export interface ContentStoryBody extends ContentStorySummary {
  title_revision: number
  markdown: string
  has_private: boolean
  private_readable: boolean
  revision: number
  namespace_revision: number
  viewer_key: string
  representation_version: string
}

/** Attachment files and explicit folders of one story's scope. */
export interface ContentAttachmentScope {
  namespace_revision?: number
  viewer_key?: string
  attachments: ContentStoryAttachment[]
  folders: string[]
}

export interface ContentWorkspaceNode {
  id: number
  parent_id: number
  name: string
  path: string
  kind: 'file' | 'folder'
  version: string
  attachment?: ContentStoryAttachment
}

export interface ContentAttachmentWorkspace extends ContentAttachmentScope {
  nodes?: ContentWorkspaceNode[]
  root_id?: number
  namespace_revision: number
  viewer_key: string
}

export interface ContentWorkspaceCommandResult extends WorkspaceReport {
  workspace: ContentAttachmentWorkspace
}

export interface ContentStoryCreated {
  id: number
}
