/** Independent presentation metadata prevents private dimensions/LQIP leaking into public redactions. */
export interface RedactedVariantRow {
  redacted_avif_key?: string | null
  redacted_jpeg_key?: string | null
  redacted_revision?: number
  redacted_metadata?: unknown
  redacted_lqip_jpeg?: Buffer | null
}

export function has_redacted_variant(row: RedactedVariantRow) {
  return Boolean(row.redacted_avif_key && row.redacted_jpeg_key && Number(row.redacted_revision) > 0)
}

export function redacted_object_keys(row: RedactedVariantRow) {
  return [... new Set([row.redacted_avif_key, row.redacted_jpeg_key].filter((key): key is string => !! key))]
}

/** Only the public derivative's own fields are substituted. Identity and private flag stay on the owner. */
export function redacted_presentation_row<T extends RedactedVariantRow>(row: T) {
  const metadata = typeof row.redacted_metadata === 'string' ? JSON.parse(row.redacted_metadata) : row.redacted_metadata
  return { ... row, object_key: row.redacted_avif_key ?? null,
    avif_key: row.redacted_avif_key ?? null, jpeg_key: row.redacted_jpeg_key ?? null,
    image_revision: Number(row.redacted_revision), image_metadata: metadata,
    lqip_jpeg: row.redacted_lqip_jpeg ?? null, original_key: null }
}
