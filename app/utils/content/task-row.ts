import type { ContentTaskItemStatus, ContentTaskKind } from '@shared/types/content'
import type { AttachmentFileCardData, AttachmentUploadStatus } from './attachment'

/**
 * One row of a live task — the projection the attachment list renders
 * (docs/content-task-refactor.md §11). Everything the server owns is copied
 * straight from the task item; only genuinely local things (`is_driving`,
 * `speed`) are added by the store.
 */
export interface PendingTaskRow {
  task_id: number
  item_id: number
  /** The path the item plans to land on; the final name may differ (suffix). */
  path: string
  /** The task's kind and the item's action (upload / replace / redact / encrypt…). */
  kind: ContentTaskKind
  action: string
  /** Whether this item waits on client bytes; the rest run on the server. */
  is_transfer: boolean
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

/** An item whose bytes the server moves itself has no percentage to report. */
export function pending_task_indeterminate(row: PendingTaskRow) {
  return ! row.is_transfer && (row.status === 'pending' || row.status === 'active')
}

/**
 * The card status a row reads as.
 *
 * For transfer items, `active` means the server is holding the item open for
 * bytes, which says nothing about whether anything is moving: only a live
 * transfer — here or in another tab — is 上传中, anything else is waiting to
 * be continued. A server-executed item (encrypt/decrypt) reads as 处理中 from
 * the moment it is queued: there is no client-side pause for it.
 */
export function pending_upload_status(row: PendingTaskRow): AttachmentUploadStatus {
  switch (row.status) {
    case 'pending':
      return pending_task_indeterminate(row) ? 'uploading' : 'queued'
    case 'active':
      return row.is_driving || row.bytes_done > 0 || pending_task_indeterminate(row) ? 'uploading' : 'paused'
    case 'done':
      return 'completed'
    default:
      // 'failed' (the task or the sweeper gave up) and 'skipped' (the server
      // refused this file) both land on the retryable error row.
      return 'error'
  }
}

export function pending_upload_percent(row: PendingTaskRow) {
  if (row.status === 'done')
    return 100
  if (row.bytes_total <= 0)
    return 0
  return Math.min(100, Math.round(row.bytes_done / row.bytes_total * 100))
}

/** The status line of a server-executed item — no bytes, no rate, just the verb. */
function pending_task_label(row: PendingTaskRow) {
  switch (row.kind) {
    case 'encrypt':
      return '加密中'
    case 'decrypt':
      return '解密中'
    default:
      return '处理中'
  }
}

/** The row as the attachment card consumes it. */
export function pending_upload_card(row: PendingTaskRow): AttachmentFileCardData {
  const indeterminate = pending_task_indeterminate(row)
  return {
    kind: 'upload',
    file_name: row.path,
    mime_type: row.mime_type,
    file_size: row.bytes_total,
    status: pending_upload_status(row),
    progress: indeterminate ? 0 : pending_upload_percent(row),
    speed: row.speed,
    message: row.error,
    can_resume: row.can_resume,
    indeterminate,
    pending_label: indeterminate ? pending_task_label(row) : null,
    server_side: ! row.is_transfer,
  }
}
