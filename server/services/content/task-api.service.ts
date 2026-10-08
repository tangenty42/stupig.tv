import type { ContentAttachmentBatchResult, ContentTask, ContentTaskItem, ContentTaskKind, ContentTaskPart, ContentTaskPartPlan, ContentTaskReplacePayload, ContentTaskResumeState, ContentTaskUploadedPart, ContentTaskUploadPayload } from '@shared/types/content'
import type { ContentTaskWithItems } from './task.service'
import { ApiError } from '@server/errors/ApiError'
import { release_task_locks } from '@server/lib/operation-lock'
import { signed_part_upload_url, signed_put_url } from '@server/lib/storage'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { get_scope_attachment } from '@server/services/content-attachments.service'
import { runtime_config } from '@shared/config'
import { attachment_scope_payload } from './attachment-structure.service'
import { finalize_transfer_item, task_item_paths, transfer_item_resume_state } from './task-operations.service'
import { complete_task_if_finished, dispatch_task, kick_task_runner, run_task_synchronously, touch_task } from './task-runner.service'
import { create_task, get_task, publish_task_state, transition_task, update_task_item } from './task.service'

const config = runtime_config()

/**
 * The application-facing task API (docs/content-task-refactor.md §7): creates
 * tasks from validated payloads and runs them. The legacy per-operation
 * endpoints below are thin wrappers over the same path, keeping their exact
 * old shapes while everything flows through the task queue.
 */

/**
 * Creates a task and best-effort dispatches it inline. Contention leaves it
 * queued for the runner tick; executor failures land on the task (status
 * failed + error), so the caller always gets the task state back.
 */
export async function create_content_task(input: {
  scope_id: number
  kind: ContentTaskKind
  payload: Record<string, unknown>
  actor_id: number | null
  client_id: string | null
}): Promise<ContentTaskWithItems> {
  const created = await create_task({
    scope_id: input.scope_id,
    kind: input.kind,
    payload: input.payload,
    items: task_item_paths(input.kind, input.payload),
    actor_id: input.actor_id,
    client_id: input.client_id,
  })
  try {
    await dispatch_task(created.task.id)
  }
  catch {
    // The failure is recorded on the task; the async API reports state.
  }
  // A new task is a membership change: tell peers to fold it into their list.
  publish_refresh({ resource: sync_resource('content_story_tasks', created.task.scope_id) })
  const current = await get_task(created.task.id)
  return current ?? created
}

/** Cancels a queued task; a running one is a 409 (phase-1 executors finish within the request). */
export async function cancel_content_task(task_id: number): Promise<ContentTaskWithItems> {
  const current = await get_task(task_id)
  if (! current)
    throw new ApiError(404, '任务不存在或已被删除')
  await transition_task(task_id, 'cancelled')
  // A cancelled task keeps nothing: the rows go, and so do its path locks.
  await release_task_locks(current.task.scope_id, task_id).catch(() => {})
  publish_refresh({ resource: sync_resource('content_story_tasks', current.task.scope_id) })
  return (await get_task(task_id)) ?? current
}

/** Re-queues an interrupted task (failed) so the runner picks it up again. Prepared items keep their staging keys. */
export async function resume_content_task(task_id: number): Promise<ContentTaskWithItems> {
  const current = await get_task(task_id)
  if (! current)
    throw new ApiError(404, '任务不存在或已被删除')
  await transition_task(task_id, 'queued')
  kick_task_runner()
  publish_refresh({ resource: sync_resource('content_story_tasks', current.task.scope_id) })
  return (await get_task(task_id)) ?? current
}

/* ------------------------------------------------------------------------- */
/* Transfer endpoints (upload / replace tasks)                                */
/* ------------------------------------------------------------------------- */

/** Parts a transfer item is split into; a single-PUT item is one part. */
function item_part_count(item: ContentTaskItem) {
  if (! item.part_size || item.bytes_total <= 0)
    return 1
  return Math.max(1, Math.ceil(item.bytes_total / item.part_size))
}

/**
 * Signs a batch of part uploads for one item and rolls its lease forward.
 * Parts are requested in batches (`signBatchSize`) so a very large file does
 * not get URLs that expire before the client reaches the end.
 */
export async function sign_task_parts(input: { task_id: number, item_id: number, part_numbers: number[] }): Promise<ContentTaskPartPlan> {
  const { task, item } = await require_active_item(input.task_id, input.item_id)
  if (! item.staging_key)
    throw new ApiError(409, '任务项缺少暂存对象')
  const total = item_part_count(item)
  const numbers = [... new Set(input.part_numbers)].sort((left, right) => left - right)
  if (! numbers.length || numbers.length > config.app.content.upload.signBatchSize)
    throw new ApiError(400, '分片数量不合法')
  const content_type = transfer_content_type(task, item)
  const urls: ContentTaskPart[] = []
  for (const part_number of numbers) {
    if (part_number < 1 || part_number > total)
      throw new ApiError(400, '分片数量不合法')
    urls.push({
      part_number,
      url: item.upload_id
        ? await signed_part_upload_url(item.staging_key, item.upload_id, part_number, config.app.content.upload.urlTtlSeconds)
        : await signed_put_url(item.staging_key, content_type, config.app.content.upload.urlTtlSeconds),
    })
  }
  return { parts: urls, part_size: item.part_size, upload_id: item.upload_id }
}

/** The content type a staged object will be stored with, taken from the task payload. */
function transfer_content_type(task: ContentTask, item: ContentTaskItem) {
  if (item.action === 'replace')
    return (task.payload as unknown as ContentTaskReplacePayload).content_type
  const payload = task.payload as unknown as ContentTaskUploadPayload
  return payload.uploads.find(entry => entry.path === item.path)?.mime_type ?? null
}

/**
 * Reports progress on, or the completion of, a transfer item.
 *
 * Progress is bookkeeping only (bytes_done + a heartbeat). Completion runs the
 * authoritative finalize — complete the multipart, then land the row — and
 * once the last item is terminal the task closes and its locks are released.
 */
export async function report_task_item(input: {
  task_id: number
  item_id: number
  status: 'progress' | 'completed'
  bytes_done?: number
  parts?: ContentTaskUploadedPart[]
}): Promise<ContentTaskWithItems> {
  const { task, item } = await require_active_item(input.task_id, input.item_id)

  if (input.status === 'progress') {
    await update_task_item(task.id, item.id, {
      bytes_done: Math.max(0, Math.min(input.bytes_done ?? item.bytes_done, item.bytes_total)),
    })
    // Progress is payload-only: the snapshot spares every subscriber a refetch
    // for a number that changes many times per second.
    await publish_task_state(task.id)
    return await require_task(task.id)
  }

  const attachment = await finalize_transfer_item(task, item, input.parts ?? [])
  await update_task_item(task.id, item.id, {
    status: 'done',
    bytes_done: item.bytes_total,
    result: { attachment },
  })
  await publish_task_state(task.id)
  await complete_task_if_finished(task.id)
  return await require_task(task.id)
}

/** Where a resuming client continues: the staging key, its upload id and the parts already landed. */
export async function resume_task_item(input: { task_id: number, item_id: number }): Promise<ContentTaskResumeState> {
  const current = await require_active_item(input.task_id, input.item_id)
  return await transfer_item_resume_state(current.item)
}

/** Loads a task, asserting it still exists (we just wrote to it). */
async function require_task(task_id: number): Promise<ContentTaskWithItems> {
  const current = await get_task(task_id)
  if (! current)
    throw new ApiError(404, '任务不存在或已被删除')
  return current
}

/** Loads a task and asserts the addressed item is in flight; every transfer call renews the lease. */
async function require_active_item(task_id: number, item_id: number) {
  await touch_task(task_id)
  const current = await get_task(task_id)
  if (! current)
    throw new ApiError(404, '任务不存在或已被删除')
  const item = current.items.find(entry => entry.id === item_id)
  if (! item)
    throw new ApiError(404, '任务项不存在或已被删除')
  if (item.status !== 'active')
    throw new ApiError(409, '任务项尚未就绪或已结束')
  return { task: current.task, item }
}

/** Creates a task and runs it to a terminal state inline, the way the legacy endpoints used to run. */
async function run_structural_task<T>(
  scope_id: number,
  kind: ContentTaskKind,
  payload: Record<string, unknown>,
  actor_id: number | null,
  shape: (result: ContentTaskWithItems) => Promise<T> | T,
): Promise<T> {
  const created = await create_task({
    scope_id,
    kind,
    payload,
    items: task_item_paths(kind, payload),
    actor_id,
    client_id: null,
  })
  const result = await run_task_synchronously(created.task.id)
  return shape(result)
}

/* ------------------------------------------------------------------------- */
/* Legacy per-operation endpoints (unchanged shapes over the task queue)      */
/* ------------------------------------------------------------------------- */

export async function move_attachments(story_id: number, moves: { file_name: string, target_folder: string | null }[], actor_id: number | null = null): Promise<ContentAttachmentBatchResult> {
  return run_structural_task(story_id, 'move', { moves }, actor_id, async ({ items }) => {
    const scope = await attachment_scope_payload(story_id)
    return {
      attachments: scope.attachments,
      // A no-op move (already in the target folder) is done without a new path —
      // the old batch result simply did not list it.
      succeeded: items
        .filter(item => item.status === 'done' && item.result?.new_path !== undefined && item.result.new_path !== item.path)
        .map(item => item.path),
      skipped: items
        .filter(item => item.status === 'skipped')
        .map(item => ({ file_name: item.path, reason: String(item.result?.reason ?? '') })),
    }
  })
}

export async function move_attachment(story_id: number, file_name: string, target_folder: string | null, actor_id: number | null = null) {
  return run_structural_task(story_id, 'move', { moves: [{ file_name, target_folder }] }, actor_id, async ({ items }) => {
    const item = items[0]!
    // The single-move endpoint always threw instead of skipping.
    if (item.status !== 'done') {
      const reason = String(item.result?.reason ?? '操作失败')
      throw new ApiError(reason === '附件不存在或已被删除' ? 404 : 409, reason)
    }
    const new_file_name = String(item.result?.new_path ?? item.path)
    const row = await get_scope_attachment(story_id, new_file_name)
    if (! row)
      throw new ApiError(500, '附件写入失败，请重试')
    return row
  })
}

export async function rename_attachment(story_id: number, old_file_name: string, new_file_name: string, actor_id: number | null = null) {
  return run_structural_task(story_id, 'rename', { old_file_name, new_file_name }, actor_id, async ({ items }) => {
    const new_name = String(items[0]?.result?.new_path ?? new_file_name)
    const row = await get_scope_attachment(story_id, new_name)
    if (! row)
      throw new ApiError(500, '附件写入失败，请重试')
    return row
  })
}

export async function delete_attachment(story_id: number, file_name: string, markdown: string, base_revision: number, can_private: boolean, actor_id: number | null = null) {
  return run_structural_task(story_id, 'delete', { file_names: [file_name], folders: [], markdown, base_revision, can_private }, actor_id, ({ items }) => {
    if (items[0]?.status !== 'done')
      throw new ApiError(404, '附件不存在或已被删除')
  })
}

export async function create_folder(story_id: number, folder: string, actor_id: number | null = null) {
  return run_structural_task(story_id, 'folder_create', { folder }, actor_id, async () => {
    // Read after the task's locks are released, so the payload reports the
    // scope as idle instead of echoing the caller's own operation as in flight.
    return attachment_scope_payload(story_id)
  })
}

export async function delete_folder(story_id: number, folder: string, actor_id: number | null = null) {
  return run_structural_task(story_id, 'folder_delete', { folder }, actor_id, () => attachment_scope_payload(story_id))
}

export async function move_folder(story_id: number, source_folder: string, new_folder: string, actor_id: number | null = null) {
  return run_structural_task(story_id, 'folder_rename', { source_folder, new_folder }, actor_id, () => attachment_scope_payload(story_id))
}
