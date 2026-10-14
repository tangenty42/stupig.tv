import type { ContentAttachmentBatchResult, ContentTask, ContentTaskItem, ContentTaskKind, ContentTaskPart, ContentTaskPartPlan, ContentTaskRedactPayload, ContentTaskReplacePayload, ContentTaskResolution, ContentTaskResumeState, ContentTaskUploadedPart, ContentTaskUploadPayload } from '@shared/types/content'
import type { ContentTaskItemInput, ContentTaskWithItems } from './task.service'
import { ApiError } from '@server/errors/ApiError'
import { error_fields, log_error } from '@server/lib/log'
import { release_task_locks } from '@server/lib/operation-lock'
import { signed_part_upload_url, signed_put_url } from '@server/lib/storage'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { get_scope_attachment, list_scope_attachments, list_scope_folders, list_scope_paths } from '@server/services/content-attachments.service'
import { attachment_ancestor_folders, attachment_base_name, attachment_folder_of, attachment_name_conflict_message, attachment_path_join, attachment_path_taken } from '@shared/content-markdown'
import { settings } from '@shared/settings'
import { attachment_scope_payload } from './attachment-structure.service'
import { discard_task_staging, finalize_transfer_item, preflight_task, task_item_paths, transfer_item_resume_state } from './task-operations.service'
import { complete_task_if_finished, dispatch_task, kick_task_runner, run_task_synchronously, touch_task } from './task-runner.service'
import { apply_task_resolutions, create_task, get_retry_task, get_task, publish_task_state, set_transfer_paused, transition_task, update_task_item } from './task.service'

/**
 * The application-facing task API (docs/old/content-task-refactor.md §7): creates
 * tasks from validated payloads and runs them. The legacy per-operation
 * endpoints below are thin wrappers over the same path, keeping their exact
 * old shapes while everything flows through the task queue.
 */

/**
 * Creates a task and best-effort dispatches it inline. Contention leaves it
 * queued for the runner tick; executor failures land on the task (status
 * failed + error), so the caller always gets the task state back.
 *
 * Server-side long-running kinds (encrypt/decrypt) are the exception: their
 * dispatch is kicked without awaiting, because awaiting it would re-create the
 * request-length problem the task queue exists to solve (§13.1) — the queued
 * task row is the receipt, and progress arrives over the sync channel.
 */
export async function create_content_task(input: {
  retry?: { task_id: number, item_id: number, base_payload: Record<string, unknown> }
  scope_id: number
  kind: ContentTaskKind
  payload: Record<string, unknown>
  actor_id: number | null
  client_id: string | null
}): Promise<ContentTaskWithItems> {
  const resolution_kinds: ContentTaskKind[] = ['upload', 'replace', 'folder_rename']
  const preflight = resolution_kinds.includes(input.kind)
    ? await preflight_task(input.scope_id, input.kind, input.payload)
    : null
  const items = task_item_paths(input.kind, input.payload).map<ContentTaskItemInput>((item, index) => {
    if (! preflight)
      return item
    const verdict = preflight
      ? input.kind === 'upload'
        ? preflight.items[index]
        : preflight.items.find(candidate => candidate.path === item.path && candidate.action === item.action)
      : undefined
    if (! verdict?.ok)
      return { ... item, status: 'skipped' as const, result: { reason: verdict?.reason ?? '无法执行', ... (input.kind === 'upload' ? { display_path: verdict?.path } : {}) } }
    if (verdict?.resolution)
      return { ... item, result: { resolve: verdict.resolution } }
    return item
  })
  if (input.kind === 'upload') {
    // A sanitized target can be another unresolved entry's raw name. Reserve
    // independent item keys now so applying either choice cannot hit uq_task_path.
    const suggested_paths = new Set((preflight?.items ?? []).flatMap(item => item.resolution ? [item.resolution.to.toLowerCase()] : []))
    const reserved = new Set([... items.map(item => item.path.toLowerCase()), ... suggested_paths])
    for (const [index, item] of items.entries()) {
      if (! item.result?.resolve)
        continue
      let path = `__pending_upload_${index}`
      while (reserved.has(path.toLowerCase()) && (path !== item.path || suggested_paths.has(path.toLowerCase())))
        path = `_${path}`
      reserved.add(path.toLowerCase())
      item.path = path
    }
  }
  const has_resolution = items.some(item => item.result?.resolve)
  const all_refused = items.length > 0 && items.every(item => item.status === 'skipped')
  const created = await create_task({
    retry: input.retry,
    scope_id: input.scope_id,
    kind: input.kind,
    payload: input.payload,
    items,
    actor_id: input.actor_id,
    client_id: input.client_id,
    status: has_resolution ? 'paused' : all_refused ? 'done' : 'queued',
  })
  if (created.task.status === 'paused' || created.task.status === 'done') {
    // Waiting for a user's decision is durable state; an all-refused batch is
    // already terminal and should not enter the runner.
  }
  else if (input.kind === 'encrypt' || input.kind === 'decrypt') {
    void dispatch_task(created.task.id).catch((error) => {
      log_error('content task dispatch failed', {
        task_id: created.task.id,
        kind: input.kind,
        ... error_fields(error),
      })
    })
  }
  else {
    try {
      await dispatch_task(created.task.id)
    }
    catch {
      // The failure is recorded on the task; the async API reports state.
    }
  }
  // A new task is a membership change: tell peers to fold it into their list.
  publish_refresh({ resource: sync_resource('content_story_tasks', created.task.scope_id) })
  await publish_task_state(created.task.id)
  const current = await get_task(created.task.id)
  return current ?? created
}

/** Retry a terminal failed attempt, preserving its operation and original payload. */
export async function retry_content_task_item(input: {
  task_id: number
  item_id: number
  source_file_name: string
  size: number
  actor_id: number
  client_id: string | null
}) {
  const previous = await get_task(input.task_id)
  const item = previous?.items.find(item => item.id === input.item_id)
  if (! previous || ! item)
    throw new ApiError(404, '原任务项不存在或已过期')
  const existing = await get_retry_task(item.id)
  if (existing) {
    // The first request can commit between our two reads; return the new marker.
    const updated = await get_task(previous.task.id)
    if (! updated)
      throw new ApiError(409, '原任务已过期，请刷新查看新任务')
    return { previous: updated, current: existing }
  }
  if (item.superseded_at || item.status !== 'failed' || ! ['failed', 'done'].includes(previous.task.status))
    throw new ApiError(409, '该任务项不能重新创建，请继续当前任务')
  const kind = previous.task.kind
  if (kind === 'upload' && item.staging_key)
    throw new ApiError(409, '该上传仍可续传，请继续原任务')
  let payload: Record<string, unknown>
  if (kind === 'upload') {
    const uploads = (previous.task.payload as unknown as ContentTaskUploadPayload).uploads
    const entry = uploads.find(entry => entry.path === item.path)
    if (! entry)
      throw new ApiError(409, '原上传信息不存在，请刷新')
    if (input.source_file_name !== (entry.source_file_name ?? attachment_base_name(entry.path)) || input.size !== entry.size)
      throw new ApiError(400, '请选择名称和大小一致的原文件')
    payload = { uploads: [{ ... entry }] }
  }
  else if (kind === 'replace' || kind === 'redact') {
    payload = structuredClone(previous.task.payload)
    const source = kind === 'replace' ? (payload.source_file_name ?? payload.file_name) : null
    if (input.size !== payload.size || (source && input.source_file_name !== source))
      throw new ApiError(400, '请选择名称和大小一致的原文件')
  }
  else {
    throw new ApiError(400, '该任务类型不支持上传重试')
  }
  const current = await create_content_task({
    scope_id: previous.task.scope_id, kind, payload,
    actor_id: input.actor_id, client_id: input.client_id,
    retry: { task_id: previous.task.id, item_id: item.id, base_payload: previous.task.payload },
  })
  const updated = await get_task(previous.task.id)
  if (! updated)
    throw new ApiError(409, '原任务已过期，请刷新查看新任务')
  await publish_task_state(previous.task.id)
  return { previous: updated, current }
}

/**
 * Cancels a task. A task still waiting (queued, or paused mid-transfer) is
 * cancelled outright; one the runner is executing right now can only be marked
 * `cancelling` — the executor notices at its next item boundary and the
 * dispatch winds it down onto `cancelled` (which is also what releases its
 * locks and its stage).
 */
export async function cancel_content_task(task_id: number): Promise<ContentTaskWithItems> {
  const current = await get_task(task_id)
  if (! current)
    throw new ApiError(404, '任务不存在或已被删除')
  if (current.task.status === 'running' && (current.task.kind === 'encrypt' || current.task.kind === 'decrypt')) {
    await transition_task(task_id, 'cancelling')
    publish_refresh({ resource: sync_resource('content_story_tasks', current.task.scope_id) })
    return (await get_task(task_id)) ?? current
  }
  if (current.task.status === 'cancelled')
    return current
  if (current.task.status === 'running')
    await transition_task(task_id, 'cancelling')
  await transition_task(task_id, 'cancelled')
  // A cancelled task keeps nothing: its paths are freed and whatever it staged
  // is released — cancelling is the user saying the transfer is never coming back.
  await release_task_locks(current.task.scope_id, task_id).catch(() => {})
  await discard_task_staging(current.items)
  publish_refresh({ resource: sync_resource('content_story_tasks', current.task.scope_id) })
  return (await get_task(task_id)) ?? current
}

/** Re-queues an interrupted task (failed) so the runner picks it up again. Prepared items keep their staging keys. */
export async function resume_content_task(task_id: number): Promise<ContentTaskWithItems> {
  const current = await get_task(task_id)
  if (! current)
    throw new ApiError(404, '任务不存在或已被删除')
  if (current.items.some(item => item.result?.resolve))
    throw new ApiError(409, '请先处理待确认的名称')
  if (current.items.some(item => item.paused_at))
    throw new ApiError(409, '请对已暂停的文件选择继续上传')
  await transition_task(task_id, 'queued')
  // The client resumes bytes immediately after this response. Prepare transfer
  // items before returning so resumeTaskItem cannot race the periodic runner.
  if (['upload', 'replace', 'redact'].includes(current.task.kind))
    await dispatch_task(task_id)
  kick_task_runner()
  publish_refresh({ resource: sync_resource('content_story_tasks', current.task.scope_id) })
  return (await get_task(task_id)) ?? current
}

export async function pause_content_task_item(task_id: number, item_id: number) {
  const current = await set_transfer_paused(task_id, item_id, true)
  publish_refresh({ resource: sync_resource('content_story_tasks', current.task.scope_id) })
  await publish_task_state(task_id)
  return current
}

export async function continue_content_task_item(task_id: number, item_id: number) {
  const current = await set_transfer_paused(task_id, item_id, false)
  if (current.task.status === 'queued')
    await dispatch_task(task_id)
  publish_refresh({ resource: sync_resource('content_story_tasks', current.task.scope_id) })
  await publish_task_state(task_id)
  return await require_task(task_id)
}

/** Resolves one or more durable built-in choices, then re-queues the task when none remain. */
export async function resolve_content_task(input: {
  task_id: number
  resolutions: { item_id: number, choice: 'apply' | 'skip' }[]
}): Promise<ContentTaskWithItems> {
  const current = await get_task(input.task_id)
  if (! current)
    throw new ApiError(404, '任务不存在或已被删除')
  if (current.task.status !== 'paused')
    throw new ApiError(409, '任务已不在待处理状态，请刷新后重试')
  if (new Set(input.resolutions.map(entry => entry.item_id)).size !== input.resolutions.length)
    throw new ApiError(400, '待处理项重复')

  const payload = structuredClone(current.task.payload)
  const paths = await list_scope_paths(current.task.scope_id)
  const attachments = await list_scope_attachments(current.task.scope_id)
  const folders = new Set((await list_scope_folders(current.task.scope_id)).map(folder => folder.toLowerCase()))
  for (const attachment of attachments) {
    let parent = attachment_folder_of(attachment.file_name)
    while (parent) {
      folders.add(parent.toLowerCase())
      parent = attachment_folder_of(parent)
    }
  }
  const updates = input.resolutions.map(({ item_id, choice }) => {
    const item = current.items.find(entry => entry.id === item_id)
    const resolution = item?.result?.resolve as ContentTaskResolution | undefined
    if (! item || ! resolution)
      throw new ApiError(404, '待处理项不存在或已被解决')
    if (choice === 'skip') {
      return { item_id, path: item.path, status: 'skipped' as const, result: { reason: '用户选择跳过', resolution } }
    }

    let target_path = resolution.to
    if (current.task.kind === 'replace') {
      const replace = current.task.payload as unknown as ContentTaskReplacePayload
      target_path = attachment_path_join(attachment_folder_of(replace.old_file_name), resolution.to)
    }
    const occupied_file = attachments.some(entry => entry.file_name.toLowerCase() === target_path.toLowerCase())
    const is_folder_merge = resolution.kind === 'merge' && folders.has(target_path.toLowerCase())
    const conflict = resolution.kind === 'merge'
      ? occupied_file
      : attachment_path_taken(paths, target_path, current.task.kind === 'replace' ? (current.task.payload as unknown as ContentTaskReplacePayload).old_file_name : null)
    if (conflict && ! is_folder_merge) {
      return { item_id, path: item.path, status: 'skipped' as const, result: { reason: '目标名称已被占用，请重新操作', resolution } }
    }

    if (current.task.kind === 'upload') {
      const upload = (payload as unknown as ContentTaskUploadPayload).uploads
      const entry = resolution.entry_index === undefined
        ? upload.find(candidate => candidate.path === resolution.from)
        : upload[resolution.entry_index]
      if (! entry)
        throw new ApiError(409, '上传任务内容已变化，请刷新后重试')
      entry.source_file_name ??= attachment_base_name(resolution.from)
      entry.path = resolution.to
      return { item_id, path: resolution.to, status: 'pending' as const, result: null }
    }
    if (current.task.kind === 'replace') {
      const replace = payload as unknown as ContentTaskReplacePayload
      replace.source_file_name ??= replace.file_name
      replace.file_name = resolution.to
      return { item_id, path: target_path, status: 'pending' as const, result: null }
    }
    if (current.task.kind === 'folder_rename') {
      ;(payload as unknown as { new_folder: string }).new_folder = resolution.to
      return {
        item_id,
        path: item.path,
        status: 'pending' as const,
        result: resolution.kind === 'merge' ? { resolution_applied: { kind: 'merge' } } : null,
      }
    }
    throw new ApiError(400, '该任务类型不支持名称处理')
  })

  const updated = await apply_task_resolutions(input.task_id, payload, updates, current.task.payload)
  if (updated.task.status === 'queued')
    await dispatch_task(input.task_id)
  const latest = await get_task(input.task_id) ?? updated
  publish_refresh({ resource: sync_resource('content_story_tasks', latest.task.scope_id) })
  await publish_task_state(input.task_id)
  return latest
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
  if (! numbers.length || numbers.length > settings.app.content.upload.signBatchSize)
    throw new ApiError(400, '分片数量不合法')
  const content_type = transfer_content_type(task, item)
  const urls: ContentTaskPart[] = []
  for (const part_number of numbers) {
    if (part_number < 1 || part_number > total)
      throw new ApiError(400, '分片数量不合法')
    urls.push({
      part_number,
      url: item.upload_id
        ? await signed_part_upload_url(item.staging_key, item.upload_id, part_number, settings.app.content.upload.urlTtlSeconds)
        : await signed_put_url(item.staging_key, content_type, settings.app.content.upload.urlTtlSeconds),
    })
  }
  return { parts: urls, part_size: item.part_size, upload_id: item.upload_id, sign_batch_size: settings.app.content.upload.signBatchSize }
}

/** The content type a staged object will be stored with, taken from the task payload. */
function transfer_content_type(task: ContentTask, item: ContentTaskItem) {
  if (item.action === 'replace')
    return (task.payload as unknown as ContentTaskReplacePayload).content_type
  if (item.action === 'redact')
    return (task.payload as unknown as ContentTaskRedactPayload).content_type
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

  let attachment: Awaited<ReturnType<typeof finalize_transfer_item>>
  try {
    attachment = await finalize_transfer_item(task, item, input.parts ?? [])
  }
  catch (error) {
    if (! (error instanceof ApiError) || error.statusCode !== 409 || error.message !== attachment_name_conflict_message)
      throw error
    await update_task_item(task.id, item.id, { status: 'skipped', result: { reason: '目标名称已被占用，请重新操作' } })
    await publish_task_state(task.id)
    await complete_task_if_finished(task.id)
    return await require_task(task.id)
  }
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
  if (item.paused_at || item.superseded_at || item.status !== 'active')
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
  const items: ContentTaskItemInput[] = task_item_paths(kind, payload)
  if (kind === 'folder_rename') {
    const { new_folder } = payload as { source_folder: string, new_folder: string }
    const [folders, attachments] = await Promise.all([
      list_scope_folders(scope_id),
      list_scope_attachments(scope_id),
    ])
    const existing_folders = new Set(folders.map(folder => folder.toLowerCase()))
    for (const attachment of attachments) {
      for (const folder of attachment_ancestor_folders(attachment.file_name))
        existing_folders.add(folder.toLowerCase())
    }
    const target_is_file = attachments.some(attachment => attachment.file_name.toLowerCase() === new_folder.toLowerCase())
    if (existing_folders.has(new_folder.toLowerCase()) && ! target_is_file) {
      for (const item of items) {
        item.result = { resolution_applied: { kind: 'merge' } }
      }
    }
  }
  const created = await create_task({
    scope_id,
    kind,
    payload,
    items,
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
