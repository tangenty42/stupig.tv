/** Independent presentation metadata prevents private dimensions/LQIP leaking into public redactions. */
export interface RedactedVariantRow {
  redacted_display_key?: string | null
  redacted_fallback_key?: string | null
  redacted_revision?: number
  redacted_metadata?: unknown
  redacted_lqip?: Buffer | null
}

export function has_redacted_variant(row: RedactedVariantRow) {
  return Boolean(row.redacted_display_key && row.redacted_fallback_key && Number(row.redacted_revision) > 0)
}

export function redacted_object_keys(row: RedactedVariantRow) {
  return [... new Set([row.redacted_display_key, row.redacted_fallback_key].filter((key): key is string => !! key))]
}

/** Only the public derivative's own fields are substituted. Identity and private flag stay on the owner. */
export function redacted_presentation_row<T extends RedactedVariantRow>(row: T) {
  const metadata = typeof row.redacted_metadata === 'string' ? JSON.parse(row.redacted_metadata) : row.redacted_metadata
  return { ... row, object_key: row.redacted_display_key ?? null,
    display_key: row.redacted_display_key ?? null, fallback_key: row.redacted_fallback_key ?? null,
    image_revision: Number(row.redacted_revision), image_metadata: metadata,
    lqip: row.redacted_lqip ?? null, original_key: null }
}
