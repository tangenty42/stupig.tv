/** Current roles and the row's OWN archive, never its parent provenance key. */
export function attachment_owned_object_keys(row: { object_key: string | null, original_key?: string | null, avif_key?: string | null, jpeg_key?: string | null, redacted_avif_key?: string | null, redacted_jpeg_key?: string | null }) {
  return [... new Set([row.object_key, row.original_key, row.avif_key, row.jpeg_key, row.redacted_avif_key, row.redacted_jpeg_key].filter((key): key is string => !! key))]
}
