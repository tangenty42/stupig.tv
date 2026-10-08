import type { ContentTaskItemStatus } from '@shared/types/content'
import type { AttachmentFileCardData, AttachmentUploadStatus } from './attachment'

/**
 * One row of a live transfer task — the projection the attachment list renders
 * (docs/content-task-refactor.md §11). Everything the server owns is copied
 * straight from the task item; only genuinely local things (`is_driving`,
 * `speed`) are added by the store.
 */
export interface PendingUploadRow {
  task_id: number
  item_id: number
  /** The path the item plans to land on; the final name may differ (suffix). */
  path: string
  status: ContentTaskItemStatus
  bytes_done: number
  bytes_total: number
  mime_type: string | null
  /** Local-only: this client is pushing this item's bytes right now. */
  is_driving: boolean
  /** Local-only: measured transfer rate in bytes per second, 0 when idle. */
  speed: number
  /**
   * The item can still be continued: the server holds staged parts for it, or
   * this client still holds the bytes.
   */
  can_resume: boolean
  /** Failure text from the task or the item. */
  error: string | null
}

/**
 * The card status a row reads as.
 *
 * `active` means the server is holding the item open for bytes, which says
 * nothing about whether anything is moving: only a live transfer — here or in
 * another tab — is 上传中, anything else is waiting to be continued.
 */
export function pending_upload_status(row: PendingUploadRow): AttachmentUploadStatus {
  switch (row.status) {
    case 'pending':
      return 'queued'
    case 'active':
      return row.is_driving || row.bytes_done > 0 ? 'uploading' : 'paused'
    case 'done':
      return 'completed'
    default:
      // 'failed' (the task or the sweeper gave up) and 'skipped' (the server
      // refused this file) both land on the retryable error row.
      return 'error'
  }
}

export function pending_upload_percent(row: PendingUploadRow) {
  if (row.status === 'done')
    return 100
  if (row.bytes_total <= 0)
    return 0
  return Math.min(100, Math.round(row.bytes_done / row.bytes_total * 100))
}

/** The row as the attachment card consumes it. */
export function pending_upload_card(row: PendingUploadRow): AttachmentFileCardData {
  return {
    kind: 'upload',
    file_name: row.path,
    mime_type: row.mime_type,
    file_size: row.bytes_total,
    status: pending_upload_status(row),
    progress: pending_upload_percent(row),
    speed: row.speed,
    message: row.error,
    can_resume: row.can_resume,
  }
}
