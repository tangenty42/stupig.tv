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
  /** Cover object's ETag for local attachment covers; rendered as `?version=` to bust the immutable cache. */
  cover_version: string | null
  /** Root-relative object URL for a local-attachment cover; null for external covers. */
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
  /** Object ETag — changes with the object's content; rendered as `?version=` to bust the immutable cache. */
  version: string
  /** Root-relative path; prefix with the static base URL before rendering. */
  url: string | null
  /** Release A: private plaintext in its own bucket; legacy encrypted rows stay separate. */
  is_private?: boolean
  /** Server-side encrypted (`.good` suffix); the object at `url` is AES-256-GCM ciphertext. */
  is_encrypted: boolean
  /** base64 AES-256-GCM key, present only for viewers holding content_private:read. */
  encryption_key?: string
}

export interface ContentBatchSkipped {
  file_name: string
  reason: string
}

export interface ContentAttachmentBatchResult {
  attachments: ContentStoryAttachment[]
  succeeded: string[]
  skipped: ContentBatchSkipped[]
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

export interface ContentAttachmentReplaceRequest {
  story_id: number
  old_file_name: string
  mode: 'keep-name' | 'new-name'
  key: string
  file_name: string
  content_type: string | null
}

export interface ContentUploadSignResponse {
  url: string
  key?: string
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
