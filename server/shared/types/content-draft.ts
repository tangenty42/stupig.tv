import type { ContentReferenceBaseline } from './content-reference'

export interface DraftLease {
  page_id: string
  epoch: number
  token: string
}

export type DraftCommandKind = 'sync' | 'release' | 'publish' | 'reset' | 'delete'

export interface DraftCommand extends ContentReferenceBaseline {
  id: string
  lease: DraftLease
  seq: number
  kind: DraftCommandKind
  markdown?: string
  expected_revision?: number
  confirm_reference_history?: string
}

export type DraftFailure = 'lease_lost' | 'command_order' | 'snapshot_changed' | 'reference_review_required' | 'validation_failed'

export interface DraftReceipt {
  seq: number
  kind: DraftCommandKind
  ok: boolean
  error?: DraftFailure
  message?: string
  review_token?: string
  story_id?: number | null
  main_revision?: number
}

export interface ContentDraftSnapshot {
  id: string
  story_id: number | null
  markdown: string
  draft_revision: number
  namespace_revision: number
  title_revision: number
  published_main_revision: number | null
  unpublished_changes: boolean
  lease_epoch: number
  occupied: boolean
  owned: boolean
  lease_remaining_ms: number
  updated_at: string
  channel: string
}

export interface DraftResult {
  snapshot: ContentDraftSnapshot | null
  receipt?: DraftReceipt
}

export interface ContentDraftSummary {
  id: string
  story_id: number | null
  title: string
  updated_at: string
}
