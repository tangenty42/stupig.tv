import type { ContentStoryAttachment, ContentTaskKind, ContentTaskProgressSnapshot, ContentTaskReplacePayload, ContentTaskRetryResult, ContentTaskState, ContentTaskUploadedPart, ContentTaskUploadPayload } from '@shared/types/content'
import type { AttachmentUploadPick } from '~/utils/content/attachment'
import type { PendingTaskRow } from '~/utils/content/task-row'
import { attachment_base_name } from '@shared/content-markdown'
import { settings } from '@shared/settings'
import { content_task_transfer_actions } from '@shared/types/content'
import { defineStore } from 'pinia'
import { upload_task_item } from '~/utils/content/task-uploader'
import { load_upload_file_handle, save_upload_file_handle, upload_source_handle_key } from '~/utils/content/upload-file-handle'
import { create_xhr_upload_transport } from '~/utils/content/upload-transport'

/**
 * Server-side task state for one story scope, plus the local drivers that push
 * bytes into it.
 *
 * This is what replaced Uppy's double bookkeeping (docs/old/content-task-refactor.md
 * §8.2): the task, its items and their progress live on the server and arrive
 * here as full payloads — from `listScopeTasks` on load and from `task_progress`
 * snapshots while uploads run — so there is no local copy to reconcile. Only
 * genuinely local things (the picked File, its AbortController, the measured
 * speed) are kept here, and they are keyed by server item id.
 *
 * The page supplies the one thing the server cannot know: what to do when bytes
 * land (insert a reference at the caret, follow a rename in the draft), through
 * the per-entry `on_landed` hook.
 */

/** One file to send, with everything the driver needs to land it. */
export interface UploadEntry extends AttachmentUploadPick {
  /** Editor caret offset for the reference, inserted once the item lands. */
  insert_position?: number | null
  /** Called once the server confirms the item landed; the final name may differ. */
  on_landed?: (attachment: ContentStoryAttachment) => void
}

export interface StartTransferResult {
  /** The created task, or null when every entry was refused before creating one. */
  task: ContentTaskState | null
  /** Entries the preflight refused, with the server's reason. */
  rejected: { path: string, reason: string }[]
}

interface LocalItem {
  file: File
  handle?: FileSystemFileHandle | null
  /** Editor caret offset for the reference, when this client knows one. */
  insert_position: number | null
  /** Called once the server confirms the item landed; the final name may differ. */
  on_landed?: (attachment: ContentStoryAttachment) => void
}

export function useContentTasksStore(story_id: number) {
  return defineStore(`content-tasks:${story_id}`, () => create_tasks_state(story_id))()
}

function create_tasks_state(story_id: number) {
  const { content } = useApi()

  const tasks = ref<ContentTaskState[]>([])
  const loading = ref(false)
  const last_error = ref<string | null>(null)
  /** Bytes this client holds per item, kept across failures so 重试 needs no re-pick. */
  const files = new Map<number, LocalItem>()
  /** The in-flight transfer per item; present exactly while bytes are being sent. */
  const controllers = new Map<number, AbortController>()
  const driving_items = reactive(new Set<number>())
  const paused_items = reactive(new Set<number>())
  const pending_pauses = new Map<number, Promise<void>>()
  /**
   * Tasks the user removed by hand. The server keeps terminal rows for the whole
   * retention window (the resume/audit window), so hiding is the client's job —
   * without this, the next `load` would put the row back.
   */
  const dismissed = reactive(new Set<number>())
  const speeds = reactive(new Map<number, number>())
  const client_id = useClientInstanceId()

  /** Live states by task id, kept in one place so a snapshot can patch in place. */
  function replace_task(next: ContentTaskState) {
    if (dismissed.has(next.task.id))
      return
    const index = tasks.value.findIndex(entry => entry.task.id === next.task.id)
    next = retain_supersession(next)
    apply_controls(next)
    if (index === - 1)
      tasks.value = [... tasks.value, next]
    else
      tasks.value = tasks.value.map(entry => entry.task.id === next.task.id ? next : entry)
  }

  /** A stale progress response cannot undo an already committed replacement. */
  function retain_supersession(next: ContentTaskState) {
    const previous = tasks.value.find(entry => entry.task.id === next.task.id)
    const stale_control = next.items.some(item => (previous?.items.find(old => old.id === item.id)?.control_version ?? 0) > (item.control_version ?? 0))
    return {
      ... next,
      task: { ... next.task, status: previous?.task.status === 'cancelled' || stale_control ? previous!.task.status : next.task.status },
      items: next.items.map((item) => {
        const old = previous?.items.find(old => old.id === item.id)
        const stale = (old?.control_version ?? 0) > (item.control_version ?? 0)
        return { ... item, paused_at: stale ? old?.paused_at : item.paused_at, control_version: stale ? old?.control_version : item.control_version, superseded_at: old?.superseded_at ?? item.superseded_at ?? null }
      }),
    }
  }

  function apply_controls(next: ContentTaskState) {
    for (const item of next.items) {
      if (item.paused_at)
        paused_items.add(item.id)
      else if (! pending_pauses.has(item.id))
        paused_items.delete(item.id)
      if (item.paused_at || item.superseded_at || next.task.status === 'cancelled' || item.status === 'done' || item.status === 'skipped') {
        controllers.get(item.id)?.abort()
        driving_items.delete(item.id)
        speeds.delete(item.id)
      }
      if (item.superseded_at || next.task.status === 'cancelled')
        files.delete(item.id)
    }
  }

  /** The planned uploads of a task's payload, for the mime type and byte total the rows show. */
  function task_uploads(entry: ContentTaskState) {
    const uploads = (entry.task.payload as unknown as ContentTaskUploadPayload).uploads
    return Array.isArray(uploads) ? uploads : []
  }

  /** Rows for the attachment list: every live item of every live task. */
  const pending_rows = computed<PendingTaskRow[]>(() => {
    const rows: PendingTaskRow[] = []
    for (const entry of tasks.value) {
      if (entry.task.status === 'cancelled')
        continue
      const uploads = task_uploads(entry)
      for (const item of entry.items) {
        // A done item landed (or was resolved) already: the list's own stored
        // rows carry it, and a renamed row arrives with the story refresh.
        // Skipped attempts belong only to task reports, never to attachments.
        if (item.status === 'done' || item.status === 'skipped' || item.superseded_at)
          continue
        const resolution = item.result?.resolve && typeof item.result.resolve === 'object'
          ? item.result.resolve as PendingTaskRow['resolution']
          : null
        const resolved_from = item.result?.resolution && typeof item.result.resolution === 'object'
          ? (item.result.resolution as PendingTaskRow['resolution'])?.from
          : null
        const display_path = typeof item.result?.display_path === 'string' ? item.result.display_path : null
        const upload = resolution?.entry_index === undefined
          ? uploads.find(candidate => candidate.path === item.path)
          : uploads[resolution.entry_index]
        const replace = entry.task.kind === 'replace' ? entry.task.payload as unknown as ContentTaskReplacePayload : null
        const source_file_name = typeof item.result?.source_file_name === 'string'
          ? item.result.source_file_name
          : upload?.source_file_name ?? (upload ? attachment_base_name(upload.path) : null) ?? replace?.source_file_name ?? replace?.file_name ?? null
        rows.push({
          task_id: entry.task.id,
          item_id: item.id,
          path: resolution?.from ?? resolved_from ?? display_path ?? item.path,
          source_file_name,
          kind: entry.task.kind,
          task_status: entry.task.status,
          action: item.action,
          is_transfer: (content_task_transfer_actions as readonly string[]).includes(item.action),
          status: item.status,
          bytes_done: item.bytes_done,
          bytes_total: item.bytes_total,
          mime_type: upload?.mime_type ?? null,
          is_driving: driving_items.has(item.id),
          is_paused: !! item.paused_at || paused_items.has(item.id),
          speed: speeds.get(item.id) ?? 0,
          can_resume: files.has(item.id) || item.staging_key !== null,
          error: entry.task.error ?? (typeof item.result?.reason === 'string' ? item.result.reason : null),
          resolution,
        })
      }
    }
    return rows
  })

  /** Active tasks (anything not in a terminal state). */
  const active_tasks = computed(() => tasks.value.filter(entry => ! ['done', 'failed', 'cancelled'].includes(entry.task.status)))

  /** Any transfer running right now, for the controls that must not race one. */
  const transferring = computed(() => pending_rows.value.some(row => row.is_driving))

  /** Applies a fetched membership list without dropping local bytes for retained items. */
  function apply_list(live: ContentTaskState[]) {
    const known = new Set(live.flatMap(entry => entry.items.map(item => item.id)))
    for (const item_id of [... files.keys()]) {
      if (! known.has(item_id))
        files.delete(item_id)
    }
    for (const [item_id, controller] of [... controllers]) {
      if (known.has(item_id))
        continue
      controller.abort()
      controllers.delete(item_id)
      driving_items.delete(item_id)
      paused_items.delete(item_id)
    }
    const next = live.filter(entry => ! dismissed.has(entry.task.id)).map(retain_supersession)
    for (const entry of next)
      apply_controls(entry)
    tasks.value = next
  }

  async function load() {
    loading.value = true
    try {
      const live = await content.list_scope_tasks(story_id) as ContentTaskState[]
      // Local-only state (held bytes, drivers) is keyed by item id and dropped
      // for items the server no longer lists.
      apply_list(live)
    }
    finally {
      loading.value = false
    }
  }

  /**
   * Folds a progress event into the local state. The event carries the whole
   * task so no refetch is needed; an unknown task (created by someone else
   * between reloads) is fetched once to learn its items.
   */
  function apply_snapshot(snapshot: ContentTaskProgressSnapshot) {
    const existing = tasks.value.find(entry => entry.task.id === snapshot.task_id)
    if (! existing) {
      void load()
      return
    }
    const sources = new Map(pending_rows.value.map(row => [row.item_id, row.source_file_name]))
    const next_state: ContentTaskState = {
      task: { ... existing.task, status: snapshot.status },
      items: existing.items.map((item) => {
        const next = snapshot.items.find(candidate => candidate.id === item.id)
        if (! next)
          return item
        const { resolve: _previous_resolution, ... previous_result } = item.result ?? {}
        const source_file_name = sources.get(item.id)
        if (source_file_name)
          previous_result.source_file_name = source_file_name
        const result = next.resolution
          ? { ... previous_result, resolve: next.resolution }
          : next.reason
            ? { ... previous_result, reason: next.reason }
            : Object.keys(previous_result).length ? previous_result : null
        return { ... item, paused_at: next.paused_at, control_version: next.control_version, retry_of_item_id: next.retry_of_item_id ?? item.retry_of_item_id, superseded_at: item.superseded_at ?? next.superseded_at, path: next.path, status: next.status, bytes_done: next.bytes_done, bytes_total: next.bytes_total, result }
      }),
    }
    replace_task(next_state)
    if (snapshot.status === 'running') {
      for (const item of next_state.items) {
        const local = files.get(item.id)
        if (! item.superseded_at && ! paused_items.has(item.id) && item.status === 'active' && local && ! controllers.has(item.id))
          void drive_item(item.id, local).catch(() => {})
      }
    }
  }

  /** Copies the authoritative task the server returned into local state. */
  function adopt(next: ContentTaskState) {
    replace_task(next)
  }

  /** Hides a task locally for good; the server keeps the row until retention sweeps it. */
  function dismiss(task_id: number) {
    const entry = tasks.value.find(candidate => candidate.task.id === task_id)
    for (const item of entry?.items ?? []) {
      stop_local_item(item.id)
      files.delete(item.id)
    }
    dismissed.add(task_id)
    tasks.value = tasks.value.filter(candidate => candidate.task.id !== task_id)
  }

  /** Keep a failed row until a replacement task exists; never retry skipped reports. */
  async function retry_item(item_id: number, pick_file: () => Promise<File | null>, on_landed?: LocalItem['on_landed']) {
    const entry = tasks.value.find(entry => entry.items.some(item => item.id === item_id))
    const item = entry?.items.find(item => item.id === item_id)
    if (! entry || item?.status !== 'failed' || item.superseded_at)
      return null
    const local = files.get(item_id)
    const file = local?.file ?? await pick_file()
    if (! file)
      return null
    const handle = local?.handle ?? (await load_upload_file_handle(settings.app.content.upload.handleStorageName, upload_source_handle_key(story_id, item_id)).catch(() => null))?.handle
    const source = { ... local, file, handle, insert_position: local?.insert_position ?? null, on_landed: local?.on_landed ?? on_landed }
    if (entry.task.kind === 'upload' && item.staging_key && entry.task.status === 'failed') {
      const resumed = await content.resume_task(entry.task.id) as ContentTaskState
      adopt(resumed)
      files.set(item_id, source)
      if (resumed.items.find(candidate => candidate.id === item_id)?.status === 'active')
        void drive_item(item_id, source).catch(() => {})
      return resumed
    }
    const result = await content.retry_task_item(entry.task.id, item_id, file.name, file.size, client_id) as ContentTaskRetryResult
    adopt(result.previous)
    adopt(result.current)
    files.delete(item_id)
    const next = result.current.items[0]
    if (next && ! ['done', 'skipped', 'failed'].includes(next.status) && ! next.superseded_at) {
      files.set(next.id, source)
      if (source.handle)
        await save_upload_file_handle(settings.app.content.upload.handleStorageName, upload_source_handle_key(story_id, next.id), { file_name: file.name, file_size: file.size, handle: source.handle }).catch(() => {})
      if (result.current.task.status === 'running' && next.status === 'active' && ! controllers.has(next.id))
        void drive_item(next.id, source).catch(() => {})
    }
    return result.current
  }

  /**
   * Registers the bytes to send for an item and drives them. Called once per
   * item after the task exists, and again on resume (the uploader skips the
   * parts the server already holds, so re-running it is safe).
   */
  async function drive_item(item_id: number, local: LocalItem) {
    const entry = tasks.value.find(candidate => candidate.items.some(item => item.id === item_id))
    const item = entry?.items.find(candidate => candidate.id === item_id)
    if (! entry || ! item || item.superseded_at)
      throw new Error('任务项不存在')

    files.set(item_id, local)
    controllers.get(item_id)?.abort()
    const controller = new AbortController()
    controllers.set(item_id, controller)
    paused_items.delete(item_id)
    driving_items.add(item_id)

    const transfer = controllers
    let last_bytes = item.bytes_done
    let last_stamp = Date.now()

    try {
      await upload_task_item({
        file: local.file,
        size: item.bytes_total,
        signal: controller.signal,
        transport: create_xhr_upload_transport(),
        callbacks: {
          sign_parts: part_numbers => content.sign_task_parts(entry.task.id, item_id, part_numbers),
          report_progress: async (bytes_done) => {
            const now = Date.now()
            if (now - last_stamp >= 500) {
              speeds.set(item_id, Math.round((bytes_done - last_bytes) / ((now - last_stamp) / 1000)))
              last_bytes = bytes_done
              last_stamp = now
            }
            adopt(await content.report_task_item({ task_id: entry.task.id, item_id, status: 'progress', bytes_done }))
          },
          report_completed: async (parts: ContentTaskUploadedPart[]) => {
            const landed = await content.report_task_item({ task_id: entry.task.id, item_id, status: 'completed', parts }) as ContentTaskState
            adopt(landed)
            const attachment = landed.items.find(candidate => candidate.id === item_id)?.result?.attachment
            if (attachment)
              files.get(item_id)?.on_landed?.(attachment as ContentStoryAttachment)
            files.delete(item_id)
          },
          fetch_resume_state: () => content.resume_task_item(entry.task.id, item_id),
        },
      })
    }
    catch (error) {
      if ((error as Error)?.name !== 'AbortError')
        last_error.value = (error as Error).message
      throw error
    }
    finally {
      speeds.delete(item_id)
      // Only the controller that is still current may clean up: a resume may
      // have replaced it while this attempt was unwinding.
      if (transfer.get(item_id) === controller) {
        transfer.delete(item_id)
        driving_items.delete(item_id)
      }
      // The task may have finished: refresh so terminal rows and the story's
      // attachment list line up.
      await load().catch(() => {})
    }
  }

  /** Creates one durable batch; the server records refusals and resolve choices per item. */
  async function start_uploads(entries: UploadEntry[]): Promise<StartTransferResult> {
    if (! entries.length)
      return { task: null, rejected: [] }

    const created = await content.create_task(story_id, 'upload', {
      uploads: entries.map(entry => ({
        path: entry.file_name,
        source_file_name: entry.file.name,
        size: entry.file.size,
        mime_type: entry.file.type || null,
        insert_position: entry.insert_position ?? null,
      })),
    }, client_id) as ContentTaskState
    adopt(created)

    for (const [index, entry] of entries.entries()) {
      const item = created.items[index]
      if (item && item.status !== 'skipped') {
        files.set(item.id, { file: entry.file, handle: entry.handle, insert_position: entry.insert_position ?? null, on_landed: entry.on_landed })
        if (entry.handle)
          await save_upload_file_handle(settings.app.content.upload.handleStorageName, upload_source_handle_key(story_id, item.id), { file_name: entry.file.name, file_size: entry.file.size, handle: entry.handle }).catch(() => {})
      }
    }

    if (created.task.status === 'paused')
      return { task: created, rejected: [] }

    for (const item of created.items) {
      if (item.status !== 'active')
        continue
      void drive_item(item.id, files.get(item.id)!).catch(() => {})
    }
    return {
      task: created,
      rejected: created.items
        .filter(item => item.status === 'skipped')
        .map(item => ({ path: String(item.result?.display_path ?? item.path), reason: String(item.result?.reason ?? '无法上传') })),
    }
  }

  /**
   * Continues one item: re-queues its task when the server gave up on it, then
   * pushes the bytes this client holds. Resuming an item that never started, or
   * one the server already finished with, is the caller's business.
   */
  async function resume_item(item_id: number, local: LocalItem) {
    await pending_pauses.get(item_id)
    const entry = tasks.value.find(candidate => candidate.items.some(item => item.id === item_id))
    files.set(item_id, local)
    if (entry?.items.find(item => item.id === item_id)?.paused_at) {
      adopt(await content.continue_task_item(entry.task.id, item_id) as ContentTaskState)
      paused_items.delete(item_id)
    }
    else if (entry?.task.status === 'failed') {
      await resume_task(entry.task.id)
    }
    if (controllers.get(item_id)?.signal.aborted)
      controllers.delete(item_id)
    if (controllers.has(item_id))
      return
    await drive_item(item_id, local)
  }

  /** Replaces one stored attachment with a picked file, driven like any other transfer. */
  async function start_replace(input: {
    file: File
    old_file_name: string
    mode: 'keep-name' | 'new-name'
    on_landed?: (attachment: ContentStoryAttachment) => void
  }): Promise<StartTransferResult> {
    const payload = {
      old_file_name: input.old_file_name,
      mode: input.mode,
      size: input.file.size,
      mime_type: input.file.type || null,
      file_name: input.file.name,
      source_file_name: input.file.name,
      content_type: input.file.type || null,
    }
    const created = await content.create_task(story_id, 'replace', payload, client_id) as ContentTaskState
    adopt(created)
    const item = created.items.find(candidate => candidate.action === 'replace')
    if (item && item.status !== 'skipped')
      files.set(item.id, { file: input.file, insert_position: null, on_landed: input.on_landed })
    if (created.task.status === 'paused')
      return { task: created, rejected: [] }
    const skipped = created.items.find(candidate => candidate.status === 'skipped')
    if (skipped)
      return { task: created, rejected: [{ path: skipped.path, reason: String(skipped.result?.reason ?? '无法替换') }] }
    // A replacement swaps the object, so the landed row keeps the old name
    // unless the payload asked for a new one.
    const landed = created.items.find(candidate => candidate.status === 'done')?.result?.attachment
    if (landed)
      input.on_landed?.(landed as ContentStoryAttachment)
    const active_item = created.items.find(candidate => candidate.status === 'active')
    if (active_item && ! landed)
      void drive_item(active_item.id, files.get(active_item.id)!).catch(() => {})
    return { task: created, rejected: [] }
  }

  /** Re-queues an interrupted task; prepared items keep their staging keys. */
  async function resume_task(task_id: number) {
    adopt(await content.resume_task(task_id) as ContentTaskState)
  }

  /** Applies durable resolve choices and resumes transfers whose bytes are local. */
  async function resolve_task(task_id: number, resolutions: { item_id: number, choice: 'apply' | 'skip' }[]) {
    const previous = tasks.value.find(entry => entry.task.id === task_id)
    const resolved = await content.resolve_task(task_id, resolutions) as ContentTaskState
    adopt(resolved)
    const previous_paths = new Map(previous?.items.map(item => [item.id, item.path]) ?? [])
    for (const item of resolved.items) {
      if (item.status === 'skipped')
        files.delete(item.id)
      const local = files.get(item.id)
      if (! local?.handle || previous_paths.get(item.id) === item.path)
        continue
      void save_upload_file_handle(settings.app.content.upload.handleStorageName, `${story_id}:${item.path}`, {
        file_name: local.file.name,
        file_size: local.file.size,
        handle: local.handle,
      }).catch(() => {})
    }
    if (resolved.task.status !== 'running')
      return resolved
    for (const item of resolved.items) {
      const local = files.get(item.id)
      if (! paused_items.has(item.id) && item.status === 'active' && local && ! controllers.has(item.id))
        void drive_item(item.id, local).catch(() => {})
    }
    return resolved
  }

  /**
   * Creates a server-executed task (encrypt/decrypt) and adopts it for the
   * pending rows. There is nothing to drive: the runner does the work and the
   * sync channel reports the progress.
   */
  async function start_server_task(kind: 'encrypt' | 'decrypt', file_names: string[]): Promise<ContentTaskState> {
    const created = await content.create_task(story_id, kind, { file_names }, client_id) as ContentTaskState
    adopt(created)
    return created
  }

  /** Creates a task whose payload is owned by another editor operation. */
  async function start_task(kind: ContentTaskKind, payload: Record<string, unknown>): Promise<ContentTaskState> {
    const created = await content.create_task(story_id, kind, payload, client_id) as ContentTaskState
    adopt(created)
    return created
  }

  /**
   * Creates a 删减版 of an encrypted image: the redacted bitmap goes through
   * the same transfer pipeline as any upload, then lands as the source's
   * plaintext twin. Unlike a batch upload the caller awaits the whole drive —
   * the redact editor stays open (pending) until the twin exists.
   */
  async function start_redact(input: {
    file: File
    source_file_name: string
    on_landed?: (attachment: ContentStoryAttachment) => void
  }): Promise<StartTransferResult> {
    const payload = {
      source_file_name: input.source_file_name,
      content_type: input.file.type || null,
      size: input.file.size,
    }
    const verdicts = await content.preflight_task(story_id, 'redact', payload)
    const refused = verdicts.items.find(verdict => ! verdict.ok)
    if (refused)
      return { task: null, rejected: [{ path: refused.path, reason: refused.reason ?? '无法创建删减版' }] }

    const created = await content.create_task(story_id, 'redact', payload, client_id) as ContentTaskState
    adopt(created)
    const item = created.items.find(candidate => candidate.status === 'active')
    if (! item) {
      // The prepare stage refused it after all (the source changed since the
      // preflight): surface the item's reason like a preflight refusal.
      const reason = created.items.find(candidate => typeof candidate.result?.reason === 'string')?.result?.reason
      return { task: created, rejected: [{ path: input.source_file_name, reason: String(reason ?? '无法创建删减版') }] }
    }
    await drive_item(item.id, { file: input.file, insert_position: null, on_landed: input.on_landed })
    return { task: created, rejected: [] }
  }

  /** Cancels a task server-side (freeing its paths) and drops it from view. */
  async function cancel(task_id: number) {
    const cancelled = await content.cancel_task(task_id) as ContentTaskState
    adopt(cancelled)
    dismiss(task_id)
  }

  /**
   * Removes a row. Anything the server could still resume is cancelled instead
   * — that is what releases the stage it holds (a failed transfer keeps its
   * parts for a later resume, so writing it off has to go through the API).
   * A task that already ended for good is only hidden.
   */
  async function remove(task_id: number) {
    const entry = tasks.value.find(candidate => candidate.task.id === task_id)
    if (entry && ! ['done', 'cancelled'].includes(entry.task.status)) {
      await cancel(task_id)
      return
    }
    dismiss(task_id)
  }

  function stop_local_item(item_id: number) {
    paused_items.add(item_id)
    driving_items.delete(item_id)
    speeds.delete(item_id)
    controllers.get(item_id)?.abort()
  }

  /** Abort immediately, then persist pause before allowing an explicit resume. */
  async function pause_item(item_id: number) {
    const existing = pending_pauses.get(item_id)
    if (existing)
      return existing
    const entry = tasks.value.find(entry => entry.items.some(item => item.id === item_id))
    if (! entry || entry.task.status === 'cancelled')
      return
    stop_local_item(item_id)
    const pending = (async () => {
      try {
        adopt(await content.pause_task_item(entry.task.id, item_id) as ContentTaskState)
      }
      catch (error) {
        paused_items.delete(item_id)
        throw error
      }
      finally {
        pending_pauses.delete(item_id)
        const current = tasks.value.find(candidate => candidate.task.id === entry.task.id)?.items.find(item => item.id === item_id)
        if (! current?.paused_at)
          paused_items.delete(item_id)
      }
    })()
    pending_pauses.set(item_id, pending)
    return pending
  }

  return {
    tasks,
    loading,
    last_error,
    pending_rows,
    active_tasks,
    transferring,
    load,
    apply_list,
    apply_snapshot,
    adopt,
    drive_item,
    start_uploads,
    start_replace,
    start_redact,
    start_server_task,
    start_task,
    resume_item,
    resume_task,
    resolve_task,
    cancel,
    remove,
    dismiss,
    retry_item,
    pause_item,
    /** The bytes this client still holds for an item, if any. */
    local_item: (item_id: number) => files.get(item_id) ?? null,
  }
}
