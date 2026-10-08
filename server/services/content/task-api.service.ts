import type { ContentAttachmentBatchResult, ContentTaskKind } from '@shared/types/content'
import type { ContentTaskWithItems } from './task.service'
import { ApiError } from '@server/errors/ApiError'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { get_scope_attachment } from '@server/services/content-attachments.service'
import { attachment_scope_payload } from './attachment-structure.service'
import { task_item_paths } from './task-operations.service'
import { dispatch_task, run_task_synchronously } from './task-runner.service'
import { create_task, get_task, transition_task } from './task.service'

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
  const current = await get_task(created.task.id)
  return current ?? created
}

/** Cancels a queued task; a running one is a 409 (phase-1 executors finish within the request). */
export async function cancel_content_task(task_id: number): Promise<ContentTaskWithItems> {
  const current = await get_task(task_id)
  if (! current)
    throw new ApiError(404, '任务不存在或已被删除')
  await transition_task(task_id, 'cancelled')
  publish_refresh({ resource: sync_resource('content_story_tasks', current.task.scope_id) })
  return (await get_task(task_id)) ?? current
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
