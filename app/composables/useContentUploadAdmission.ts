import type { ImageSaveMode, UploadBatch } from '@shared/content-upload'
import type { ErrorPolicy, WorkspaceIssue, WorkspaceReport } from '@shared/content-workspace'
import type { ContentStoryAttachment } from '@shared/types/content'
import type { ContentUploadSession } from '@shared/types/content-upload'
import type { useApi } from './useApi'
import type { AttachmentUploadPick } from '~/utils/content/attachment'
import { normalized_attachment_extension } from '@shared/content-markdown'
import { error_policy_schema } from '@shared/content-workspace'
import { settings } from '@shared/settings'
import { upload_file_sha256 } from '~/utils/content/browser-upload'

export interface UploadEntry extends AttachmentUploadPick {
  image_mode?: ImageSaveMode
  image_input_basis?: 'avif' | 'original'
  purpose?: 'create' | 'replace' | 'redact'
  access?: 'public' | 'private'
  source?: { id: number, version: string }
  replacement?: { id: number, version: string }
  on_landed?: (attachment: ContentStoryAttachment) => void
}

interface AdmissionOptions {
  begin_upload_batch: ReturnType<typeof useApi>['content']['begin_upload_batch']
  snapshot_epoch: () => number
  attach: (session: ContentUploadSession, entry: UploadEntry) => Promise<void>
  is_paused: (id: string) => boolean
  resume: (id: string) => Promise<boolean>
}

/** One selection's preparation and admission; identity epochs belong to the owning store. */
export function createContentUploadAdmission(scope: number, options: AdmissionOptions) {
  const preparing = ref<{ path: string, loaded: number, total: number } | null>(null)
  const resolution = ref<{ items: WorkspaceIssue[], valid_count: number } | null>(null)
  const report = ref<WorkspaceReport | null>(null)
  const admission_error = ref('')
  const admitting = ref(false)
  let pending: { input: UploadBatch, entries: UploadEntry[] } | null = null
  let hashing: AbortController | null = null
  let accepting = false
  async function submit(policy?: ErrorPolicy) {
    if (! pending || admitting.value)
      return
    if (policy) {
      pending.input.on_error = policy
      pending.input.request_id = crypto.randomUUID()
    }
    admitting.value = true
    admission_error.value = ''
    const epoch = options.snapshot_epoch()
    try {
      const batch = pending
      const result = await options.begin_upload_batch(batch.input)
      if (epoch !== options.snapshot_epoch())
        return
      for (const accepted of result.accepted) {
        const entry = batch.entries[accepted.index]!
        const session = result.sessions.find(session => session.id === accepted.session_id)!
        await options.attach(session, entry)
        if (epoch !== options.snapshot_epoch())
          return
      }
      report.value = result.skipped.length || result.renamed.length ? result : null
      resolution.value = null
      pending = null
      // Admission of the complete selection precedes every byte transfer.
      const queue = [... result.accepted]
      const worker = async () => {
        while (queue.length) {
          if (epoch !== options.snapshot_epoch())
            break
          const next = queue.shift()!
          if (! options.is_paused(next.session_id))
            await options.resume(next.session_id)
        }
      }
      void Promise.all(Array.from({ length: Math.min(queue.length, settings.app.content.workspace.parallelUploads) }, worker))
    }
    catch (error) {
      if (epoch !== options.snapshot_epoch())
        return
      const value = error as { code?: string, details?: { items: WorkspaceIssue[], valid_count: number } }
      if (value.code === 'BATCH_REJECTED' && value.details && 'valid_count' in value.details)
        resolution.value = value.details
      else
        admission_error.value = error instanceof Error ? error.message : '受理结果未知，请重试查询'
    }
    finally {
      if (epoch === options.snapshot_epoch())
        admitting.value = false
    }
  }
  function dismiss_resolution() {
    if (resolution.value) {
      pending = null
      resolution.value = null
    }
  }
  async function start(entries: UploadEntry[]) {
    if (accepting)
      throw new Error('正在处理所选文件，请稍后再试')
    if (pending)
      throw new Error('请先处理上一批上传的受理结果')
    accepting = true
    report.value = null
    const epoch = options.snapshot_epoch()
    const prepared: UploadBatch['entries'] = []
    try {
      for (const entry of entries) {
        if (epoch !== options.snapshot_epoch())
          break
        hashing = new AbortController()
        preparing.value = { path: entry.file_name, loaded: 0, total: entry.file.size }
        try {
          const sha256 = await upload_file_sha256(entry.file, hashing.signal, (value) => {
            if (epoch === options.snapshot_epoch())
              preparing.value = { path: entry.file_name, loaded: value.loaded, total: value.total }
          })
          prepared.push({ path: normalized_attachment_extension(entry.file_name), size: entry.file.size, sha256, purpose: entry.purpose ?? 'create', access: entry.access ?? 'public', source: entry.source, replacement: entry.replacement, selection_root: entry.selection_root, image_mode: entry.image_mode, image_input_basis: entry.image_input_basis, original_name: entry.file.name, content_type: entry.file.type })
          if (epoch !== options.snapshot_epoch())
            break
          preparing.value = null
        }
        finally {
          if (epoch === options.snapshot_epoch())
            preparing.value = null
        }
      }
      if (epoch === options.snapshot_epoch() && prepared.length) {
        pending = { input: { scope_id: scope, request_id: crypto.randomUUID(), on_error: error_policy_schema.parse({}), entries: prepared }, entries }
        await submit()
      }
    }
    finally {
      if (epoch === options.snapshot_epoch()) {
        accepting = false
        hashing = null
      }
    }
  }
  // The owner advances its epoch before resetting all three upload owners.
  function reset() {
    hashing?.abort()
    hashing = null
    preparing.value = null
    accepting = false
    pending = null
    resolution.value = null
    report.value = null
    admission_error.value = ''
    admitting.value = false
  }
  return { preparing, resolution, report, admission_error, admitting, submit, dismiss_resolution, start, reset }
}
