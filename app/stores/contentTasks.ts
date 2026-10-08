import type { ContentTaskItem, ContentTaskProgressSnapshot, ContentTaskState, ContentTaskUploadedPart } from '@shared/types/content'
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
 */

export interface PendingUploadRow {
  task_id: number
  item_id: number
  /** The path the item plans to land on; the final name may differ (suffix). */
  path: string
  status: ContentTaskItem['status']
  bytes_done: number
  bytes_total: number
  /** Local-only: measured upload speed in bytes/s, 0 when idle. */
  speed: number
  /** Local-only: whether this client can still drive the item. */
  can_resume: boolean
  /** Failure text from the task or the item. */
  error: string | null
}

interface UploadDriver {
  item_id: number
  file: File
  controller: AbortController
}

export function useContentTasksStore(story_id: number) {
  return defineStore(`content-tasks:${story_id}`, () => create_tasks_state(story_id))()
}

function create_tasks_state(story_id: number) {
  const { content } = useApi()

  const tasks = ref<ContentTaskState[]>([])
  const loading = ref(false)
  const last_error = ref<string | null>(null)
  /** Local drivers, keyed by server item id: the File to send and how to abort it. */
  const drivers = new Map<number, UploadDriver>()
  const speeds = reactive(new Map<number, number>())
  const client_id = useClientInstanceId()

  /** Live states by task id, kept in one place so a snapshot can patch in place. */
  function replace_task(next: ContentTaskState) {
    const index = tasks.value.findIndex(entry => entry.task.id === next.task.id)
    if (index === - 1)
      tasks.value = [... tasks.value, next]
    else
      tasks.value = tasks.value.map(entry => entry.task.id === next.task.id ? next : entry)
  }

  /** Rows for the attachment list: every item of every live task. */
  const pending_rows = computed<PendingUploadRow[]>(() => {
    const rows: PendingUploadRow[] = []
    for (const entry of tasks.value) {
      for (const item of entry.items) {
        if (item.status === 'done' && item.result?.attachment)
          continue
        rows.push({
          task_id: entry.task.id,
          item_id: item.id,
          path: item.path,
          status: item.status,
          bytes_done: item.bytes_done,
          bytes_total: item.bytes_total,
          speed: speeds.get(item.id) ?? 0,
          can_resume: drivers.has(item.id) || item.staging_key !== null,
          error: entry.task.error ?? (typeof item.result?.reason === 'string' ? item.result.reason : null),
        })
      }
    }
    return rows
  })

  /** Active tasks (anything not in a terminal state). */
  const active_tasks = computed(() => tasks.value.filter(entry => ! ['done', 'failed', 'cancelled'].includes(entry.task.status)))

  async function load() {
    loading.value = true
    try {
      tasks.value = await content.list_scope_tasks(story_id) as ContentTaskState[]
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

  /**
   * Registers the bytes to send for an item and drives them. Called once per
   * item after the task exists, and again on resume (the uploader skips the
   * parts the server already holds, so re-running it is safe).
   */
  async function drive_item(item_id: number, file: File) {
    const entry = tasks.value.find(candidate => candidate.items.some(item => item.id === item_id))
    const item = entry?.items.find(candidate => candidate.id === item_id)
    if (! entry || ! item)
      throw new Error('任务项不存在')

    const existing = drivers.get(item_id)
    existing?.controller.abort()
    const controller = new AbortController()
    drivers.set(item_id, { item_id, file, controller })

    const started_at = Date.now()
    let last_bytes = 0
    let last_stamp = started_at

    try {
      await upload_task_item({
        file,
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
            adopt(await content.report_task_item({ task_id: entry.task.id, item_id, status: 'completed', parts }))
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
      if (drivers.get(item_id)?.controller === controller)
        drivers.delete(item_id)
      // The task may have finished: refresh so terminal rows and the story's
      // attachment list line up.
      await load().catch(() => {})
    }
  }

  /** Creates the upload task for a batch and starts pushing its bytes. */
  async function start_uploads(entries: { file: File, path: string, insert_position: number | null }[]) {
    if (! entries.length)
      return null
    const created = await content.create_task(story_id, 'upload', {
      uploads: entries.map(entry => ({
        path: entry.path,
        size: entry.file.size,
        mime_type: entry.file.type || null,
        insert_position: entry.insert_position,
      })),
    }, client_id) as ContentTaskState
    adopt(created)

    // Items the server skipped (illegal name, empty file) have no staging key.
    for (const [index, entry] of entries.entries()) {
      const item = created.items.find(candidate => candidate.path === entry.path)
        ?? created.items[index]
      if (! item || item.status !== 'active')
        continue
      void drive_item(item.id, entry.file).catch(() => {})
    }
    return created
  }

  async function cancel(task_id: number) {
    adopt(await content.cancel_task(task_id) as ContentTaskState)
  }

  async function resume(task_id: number) {
    adopt(await content.resume_task(task_id) as ContentTaskState)
  }

  /** Aborts the local transfer of one item (the server task keeps waiting, then times out). */
  function pause_item(item_id: number) {
    drivers.get(item_id)?.controller.abort()
  }

  return {
    tasks,
    loading,
    last_error,
    pending_rows,
    active_tasks,
    load,
    apply_snapshot,
    adopt,
    drive_item,
    start_uploads,
    cancel,
    resume,
    pause_item,
  }
}
