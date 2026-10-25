/** Scope-wide occupancy only; never carries another uploader's credentials or byte metadata. */
export interface ContentUploadReservation {
  id: string
  parent_id?: number
  path: string
  source_id?: number
  replacement_id?: number
}

export interface ContentUploadSession {
  id: string
  parent_id?: number
  source_id?: number
  replacement_id?: number
  purpose?: 'create' | 'replace' | 'redact'
  expires_at?: string
  revision?: number
  scope_id?: number
  status: string
  image_status?: string
  image_error?: string
  path: string
  size: number
  sha256: string
  key: string | null
  upload_id: string | null
  part_size: number | null
  parts: { part_number: number, size: number, etag: string }[]
  target: { bucket: string, region: string, endpoint: string }
  object_etag: string | null
}

export interface ContentUploadPartGrant {
  url: string
  method: 'PUT'
  headers: { 'Content-Type': string, 'Content-MD5': string, 'Content-Length': string }
}
