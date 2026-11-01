/** Current roles and the row's OWN archive, never its parent provenance key. */
export function attachment_owned_object_keys(row: { object_key: string | null, original_key?: string | null, display_key?: string | null, fallback_key?: string | null, redacted_display_key?: string | null, redacted_fallback_key?: string | null }) {
  return [... new Set([row.object_key, row.original_key, row.display_key, row.fallback_key, row.redacted_display_key, row.redacted_fallback_key].filter((key): key is string => !! key))]
}
