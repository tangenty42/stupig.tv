import type { ImageSaveMode, UploadBatch } from '@shared/content-upload'
import type { ErrorPolicy, WorkspaceIssue } from '@shared/content-workspace'
import type { ContentStoryAttachment } from '@shared/types/content'
import type { ContentUploadSession } from '@shared/types/content-upload'
import type { useApi } from './useApi'
import type { AttachmentUploadPick } from '~/utils/content/attachment'
import type { UploadPreparation } from '~/utils/content/workspace'
import { image_upload_error } from '@shared/content-image-upload'
import { normalized_attachment_extension, processable_image_mime } from '@shared/content-markdown'
import { upload_content_mime } from '@shared/content-upload'
import { error_policy_schema } from '@shared/content-workspace'
import { settings } from '@shared/settings'
import { image_upload_size } from '~/utils/content/image-upload'

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
  const preparations = ref<UploadPreparation[]>([])
  const can_cancel_preparation = computed(() => preparations.value.length > 0 && ! preparations.value.some(item => item.phase === 'admitting'))
  const resolution = ref<{ items: WorkspaceIssue[], valid_count: number } | null>(null)
  const admission_error = ref('')
  const admitting = ref(false)
  let pending: { input: UploadBatch, entries: UploadEntry[] } | null = null
  let accepting = false
  let preparation_generation = 0
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
        const preparation = preparations.value[accepted.index]
        if (preparation)
          preparation.session_id = accepted.session_id
      }
      for (const accepted of result.accepted) {
        const entry = batch.entries[accepted.index]!
        const session = result.sessions.find(session => session.id === accepted.session_id)!
        await options.attach(session, entry)
        if (epoch !== options.snapshot_epoch())
          return
      }
      resolution.value = null
      pending = null
      preparations.value = []
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
      preparations.value = []
    }
  }
  async function start(entries: UploadEntry[]) {
    if (accepting)
      throw new Error('正在处理所选文件，请稍后再试')
    if (pending)
      throw new Error('请先处理上一批上传的受理结果')
    if (entries.length > settings.app.content.workspace.batchLimit)
      throw new Error(`一次最多选择 ${settings.app.content.workspace.batchLimit} 个文件，请分批上传`)
    accepting = true
    const run = ++ preparation_generation
    const epoch = options.snapshot_epoch()
    const current = () => epoch === options.snapshot_epoch() && run === preparation_generation
    preparations.value = entries.map(entry => ({ id: crypto.randomUUID(), path: entry.file_name, size: entry.file.size, loaded: 0, phase: 'waiting' }))
    try {
      for (const preparation of preparations.value) {
        if (preparation.size > settings.app.content.upload.maxSizeMb * 1024 ** 2) {
          preparation.phase = 'failed'
          preparation.error = `文件超过 ${settings.app.content.upload.maxSizeMb} MiB 上传上限`
          throw new Error(preparation.error)
        }
      }
      let invalid = false
      for (const [index, entry] of entries.entries()) {
        if (! current())
          return
        if (! entry.image_mode && ! processable_image_mime(upload_content_mime({ path: entry.file_name, original_name: entry.file.name, content_type: entry.file.type })))
          continue
        const preparation = preparations.value[index]!
        let message = image_upload_error(entry.file.size)
        if (! message) {
          try {
            const size = await image_upload_size(entry.file)
            if (! current())
              return
            message = image_upload_error(entry.file.size, size)
          }
          catch (error) {
            if (! current())
              return
            message = error instanceof Error ? error.message : '无法检查图片尺寸，请重新选择文件'
          }
        }
        if (message) {
          preparation.phase = 'failed'
          preparation.error = message
          invalid = true
        }
      }
      if (invalid)
        return
      if (current() && entries.length) {
        for (const preparation of preparations.value)
          preparation.phase = 'admitting'
        const prepared: UploadBatch['entries'] = entries.map(entry => ({ path: normalized_attachment_extension(entry.file_name), size: entry.file.size,
          purpose: entry.purpose ?? 'create', access: entry.access ?? 'public', source: entry.source, replacement: entry.replacement,
          selection_root: entry.selection_root, image_mode: entry.image_mode, image_input_basis: entry.image_input_basis,
          original_name: entry.file.name, content_type: entry.file.type }))
        pending = { input: { scope_id: scope, request_id: crypto.randomUUID(), on_error: error_policy_schema.parse({}), entries: prepared }, entries }
        await submit()
      }
    }
    finally {
      if (current())
        accepting = false
    }
  }
  function cancel_preparation() {
    if (! can_cancel_preparation.value)
      return
    preparation_generation ++
    accepting = false
    preparations.value = []
  }
  // The owner advances its epoch before resetting all three upload owners.
  function reset() {
    preparation_generation ++
    preparations.value = []
    accepting = false
    pending = null
    resolution.value = null
    admission_error.value = ''
    admitting.value = false
  }
  return { preparations, can_cancel_preparation, cancel_preparation, resolution, admission_error, admitting, submit, dismiss_resolution, start, reset }
}
