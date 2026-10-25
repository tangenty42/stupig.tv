export type StorageAuditKind = 'missing_object' | 'size_mismatch' | 'public_object' | 'invalid_reference' | 'orphan_candidate' | 'unregistered_static' | 'unmanaged_object' | 'retired_object_present'

export interface StorageAuditFinding {
  id: number
  object_key: string
  kind: StorageAuditKind
  expected_size: number | null
  observed_size: number | null
  observations: number
  first_seen_at: string
  last_seen_at: string
  resolved_at: string | null
}
