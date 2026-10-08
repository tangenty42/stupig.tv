import type { ContentStoryAttachment, ContentTaskProgressSnapshot, ContentTaskState, ContentTaskUploadedPart, ContentTaskUploadPayload } from '@shared/types/content'
import type { AttachmentUploadPick } from '~/utils/content/attachment'
import type { PendingUploadRow } from '~/utils/content/task-row'
import { defineStore } from 'pinia'
import { upload_task_item } from '~/utils/content/task-uploader'
import { create_xhr_upload_transport } from '~/utils/content/upload-transport'

/**
 * Server-side task state for one story scope, plus the local drivers that push
 * bytes into it.
 *
 * This is what replaced Uppy's double bookkeeping (docs/content-task-refactor.md
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
    if (index === - 1)
      tasks.value = [... tasks.value, next]
    else
      tasks.value = tasks.value.map(entry => entry.task.id === next.task.id ? next : entry)
  }

  /** The planned uploads of a task's payload, for the mime type and byte total the rows show. */
  function task_uploads(entry: ContentTaskState) {
    const uploads = (entry.task.payload as unknown as ContentTaskUploadPayload).uploads
    return Array.isArray(uploads) ? uploads : []
  }

  /** Rows for the attachment list: every item of every live task. */
  const pending_rows = computed<PendingUploadRow[]>(() => {
    const rows: PendingUploadRow[] = []
    for (const entry of tasks.value) {
      const uploads = task_uploads(entry)
      for (const item of entry.items) {
        // A landed item is a stored attachment now: the list's own rows carry it.
        if (item.status === 'done' && item.result?.attachment)
          continue
        rows.push({
          task_id: entry.task.id,
          item_id: item.id,
          path: item.path,
          status: item.status,
          bytes_done: item.bytes_done,
          bytes_total: item.bytes_total,
          mime_type: uploads.find(upload => upload.path === item.path)?.mime_type ?? null,
          is_driving: controllers.has(item.id),
          speed: speeds.get(item.id) ?? 0,
          can_resume: files.has(item.id) || item.staging_key !== null,
          error: entry.task.error ?? (typeof item.result?.reason === 'string' ? item.result.reason : null),
        })
      }
    }
    return rows
  })

  /** Active tasks (anything not in a terminal state). */
  const active_tasks = computed(() => tasks.value.filter(entry => ! ['done', 'failed', 'cancelled'].includes(entry.task.status)))

  /** Any transfer running right now, for the controls that must not race one. */
  const transferring = computed(() => pending_rows.value.some(row => row.is_driving))

  async function load() {
    loading.value = true
    try {
      const live = await content.list_scope_tasks(story_id) as ContentTaskState[]
      // Local-only state (held bytes, drivers) is keyed by item id and dropped
      // for items the server no longer lists.
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
      }
      tasks.value = live.filter(entry => ! dismissed.has(entry.task.id))
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
    replace_task({
      task: { ... existing.task, status: snapshot.status },
      items: existing.items.map((item) => {
        const next = snapshot.items.find(candidate => candidate.id === item.id)
        if (! next)
          return item
        return { ... item, status: next.status, bytes_done: next.bytes_done, bytes_total: next.bytes_total }
      }),
    })
  }

  /** Copies the authoritative task the server returned into local state. */
  function adopt(next: ContentTaskState) {
    replace_task(next)
  }

  /** Hides a task locally for good; the server keeps the row until retention sweeps it. */
  function dismiss(task_id: number) {
    const entry = tasks.value.find(candidate => candidate.task.id === task_id)
    for (const item of entry?.items ?? []) {
      pause_item(item.id)
      files.delete(item.id)
    }
    dismissed.add(task_id)
    tasks.value = tasks.value.filter(candidate => candidate.task.id !== task_id)
  }

  /**
   * Registers the bytes to send for an item and drives them. Called once per
   * item after the task exists, and again on resume (the uploader skips the
   * parts the server already holds, so re-running it is safe).
   */
  async function drive_item(item_id: number, local: LocalItem) {
    const entry = tasks.value.find(candidate => candidate.items.some(item => item.id === item_id))
    const item = entry?.items.find(candidate => candidate.id === item_id)
    if (! entry || ! item)
      throw new Error('任务项不存在')

    files.set(item_id, local)
    controllers.get(item_id)?.abort()
    const controller = new AbortController()
    controllers.set(item_id, controller)

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
      if (transfer.get(item_id) === controller)
        transfer.delete(item_id)
      // The task may have finished: refresh so terminal rows and the story's
      // attachment list line up.
      await load().catch(() => {})
    }
  }

  /**
   * Uploads a batch: preflight decides what the server will accept and which
   * names step aside, then one task carries the batch and this client drives
   * every item the server left active.
   */
  async function start_uploads(entries: UploadEntry[]): Promise<StartTransferResult> {
    if (! entries.length)
      return { task: null, rejected: [] }

    const verdicts = await content.preflight_task(story_id, 'upload', {
      uploads: entries.map(entry => ({
        path: entry.file_name,
        size: entry.file.size,
        mime_type: entry.file.type || null,
        insert_position: entry.insert_position ?? null,
      })),
    })
    const rejected = verdicts.items
      .filter(verdict => ! verdict.ok)
      .map(verdict => ({ path: verdict.path, reason: verdict.reason ?? '无法上传' }))
    // A taken name steps aside with the suffix the server suggested, the same
    // name the item would have landed on had the collision been discovered late.
    const sendable = entries.flatMap((entry, index) => {
      const verdict = verdicts.items[index]
      if (! verdict?.ok)
        return []
      return [{ ... entry, file_name: verdict.suggested_name ?? entry.file_name }]
    })
    if (! sendable.length)
      return { task: null, rejected }

    const created = await content.create_task(story_id, 'upload', {
      uploads: sendable.map(entry => ({
        path: entry.file_name,
        size: entry.file.size,
        mime_type: entry.file.type || null,
        insert_position: entry.insert_position ?? null,
      })),
    }, client_id) as ContentTaskState
    adopt(created)

    // Items the server could not prepare (an illegal name it rejected) have no
    // staging key: they are the rows the user has to remove.
    for (const entry of sendable) {
      const item = created.items.find(candidate => candidate.path === entry.file_name)
      if (! item || item.status !== 'active')
        continue
      const local: LocalItem = { file: entry.file, insert_position: entry.insert_position ?? null, on_landed: entry.on_landed }
      void drive_item(item.id, local).catch(() => {})
    }
    return { task: created, rejected }
  }

  /**
   * Continues one item: re-queues its task when the server gave up on it, then
   * pushes the bytes this client holds. Resuming an item that never started, or
   * one the server already finished with, is the caller's business.
   */
  async function resume_item(item_id: number, local: LocalItem) {
    const entry = tasks.value.find(candidate => candidate.items.some(item => item.id === item_id))
    if (entry?.task.status === 'failed')
      await resume_task(entry.task.id)
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
      content_type: input.file.type || null,
    }
    const verdicts = await content.preflight_task(story_id, 'replace', payload)
    const refused = verdicts.items.find(verdict => ! verdict.ok)
    if (refused)
      return { task: null, rejected: [{ path: refused.path, reason: refused.reason ?? '无法替换' }] }

    const created = await content.create_task(story_id, 'replace', payload, client_id) as ContentTaskState
    adopt(created)
    // A replacement swaps the object, so the landed row keeps the old name
    // unless the payload asked for a new one.
    const landed = created.items.find(candidate => candidate.status === 'done')?.result?.attachment
    if (landed)
      input.on_landed?.(landed as ContentStoryAttachment)
    const item = created.items.find(candidate => candidate.status === 'active')
    if (item && ! landed)
      void drive_item(item.id, { file: input.file, insert_position: null, on_landed: input.on_landed }).catch(() => {})
    return { task: created, rejected: [] }
  }

  /** Re-queues an interrupted task; prepared items keep their staging keys. */
  async function resume_task(task_id: number) {
    adopt(await content.resume_task(task_id) as ContentTaskState)
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

  /** Aborts the local transfer of one item; the server task keeps waiting for it. */
  function pause_item(item_id: number) {
    controllers.get(item_id)?.abort()
  }

  return {
    tasks,
    loading,
    last_error,
    pending_rows,
    active_tasks,
    transferring,
    load,
    apply_snapshot,
    adopt,
    drive_item,
    start_uploads,
    start_replace,
    resume_item,
    resume_task,
    cancel,
    remove,
    dismiss,
    pause_item,
    /** The bytes this client still holds for an item, if any. */
    local_item: (item_id: number) => files.get(item_id) ?? null,
  }
}
