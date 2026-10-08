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

/** Structural attachment operations that take a scope lock. */
export type ContentOperationKind = 'move' | 'rename' | 'folder_create' | 'folder_delete' | 'delete' | 'encrypt' | 'decrypt' | 'redact'

/**
 * Attachment task kinds: one per user-level operation (see
 * docs/content-task-refactor.md). A superset of ContentOperationKind — the
 * structural kinds keep their lock names, upload/replace are new (they stay
 * outside the scope lock today) and folder_rename splits off from 'move'.
 */
export type ContentTaskKind = 'upload' | 'replace' | 'move' | 'rename' | 'delete' | 'encrypt' | 'decrypt' | 'redact' | 'folder_create' | 'folder_delete' | 'folder_rename'

/** Task lifecycle: queued → running → done/failed/cancelled; running ↔ paused only for transfer tasks. */
export type ContentTaskStatus = 'queued' | 'running' | 'paused' | 'cancelling' | 'done' | 'failed' | 'cancelled'

export type ContentTaskItemStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed'

export interface ContentTask {
  id: number
  scope_id: number
  kind: ContentTaskKind
  status: ContentTaskStatus
  /** Kind-specific task fields (moves[], file_names[], markdown…); validated on creation. */
  payload: Record<string, unknown>
  actor_id: number | null
  /** Issuer instance id: powers the "resumable on this machine" hint, never an authorization boundary. */
  client_id: string | null
  error: string | null
  heartbeat_at: string | null
  created_at: string
  updated_at: string
}

export interface ContentTaskItem {
  id: number
  task_id: number
  path: string
  action: string
  status: ContentTaskItemStatus
  bytes_done: number
  bytes_total: number
  /** Server-assigned staging object key for upload items. */
  staging_key: string | null
  /** Multipart upload id — the resume anchor. */
  upload_id: string | null
  part_size: number | null
  /** Per-item outcome: { new_path, reason, ... }. */
  result: Record<string, unknown> | null
}

/** A live lock row as listed for preflight and the editor's disabled states. */
export interface ContentPathLock {
  /** '' is the scope-level lock (contends with every path). */
  path: string
  kind: string
  /** null for legacy scope-level operation locks. */
  task_id: number | null
  expires_at: string
}

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
  /** Whether the stored markdown holds private elements (before any viewer stripping). */
  has_private: boolean
  attachments: ContentStoryAttachment[]
  /** Explicitly created folder paths (empty folders persist as rows). */
  folders: string[]
  /** Editor optimistic-concurrency token; bumps on each confirmed submit. */
  revision: number
  /**
   * Server-issued key of the viewer this payload was rendered for; echo it
   * back as `base_viewer_key` so the version check can detect a viewer change.
   */
  viewer_key: string
  /** In-flight attachment structure change by any client; null when idle. */
  operation_lock: ContentOperationLock | null
}

/** Attachment files and explicit folders of one story's scope. */
export interface ContentAttachmentScope {
  attachments: ContentStoryAttachment[]
  folders: string[]
  /** In-flight attachment structure change by any client; null when idle. */
  operation_lock: ContentOperationLock | null
}

export interface ContentStoryCreated {
  id: number
}
