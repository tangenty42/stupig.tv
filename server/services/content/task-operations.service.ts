import type { ContentTask, ContentTaskDeletePayload, ContentTaskFolderCreatePayload, ContentTaskFolderDeletePayload, ContentTaskFolderRenamePayload, ContentTaskItem, ContentTaskKind, ContentTaskMovePayload, ContentTaskRenamePayload } from '@shared/types/content'
import { ApiError } from '@server/errors/ApiError'
import { attachment_base_name, attachment_path_join } from '@shared/content-markdown'
import { apply_attachment_moves, apply_attachment_rename, apply_folder_create, apply_folder_delete, apply_folder_rename } from './attachment-structure.service'
import { update_story } from './story.service'
import { update_task_item } from './task.service'

/**
 * Task executors: apply one task against the scope with its path locks already
 * held by the runner, and report per-item outcomes. Phase 1 covers the pure-DB
 * kinds; upload/replace (transfer) and encrypt/decrypt/redact (OSS transforms)
 * arrive with phases 2 and 3.
 */

/** Lock paths per kind, derived from the payload alone (no DB read). */
export function task_lock_paths(kind: ContentTaskKind, payload: Record<string, unknown>): string[] {
  switch (kind) {
    case 'move': {
      const { moves } = payload as unknown as ContentTaskMovePayload
      return [... new Set(moves.flatMap((move) => {
        const destination = attachment_path_join(move.target_folder, attachment_base_name(move.file_name))
        // The destination is locked by name so a conflicting create/rename
        // targeting it contends; same-path moves (already there) lock only the source.
        return destination === move.file_name ? [move.file_name] : [move.file_name, destination]
      }))]
    }
    case 'rename': {
      const { old_file_name, new_file_name } = payload as unknown as ContentTaskRenamePayload
      return [... new Set([old_file_name, new_file_name])]
    }
    case 'delete': {
      const { file_names, folders } = payload as unknown as ContentTaskDeletePayload
      return [... new Set([... file_names, ... folders])]
    }
    case 'folder_create':
      return [(payload as unknown as ContentTaskFolderCreatePayload).folder]
    case 'folder_delete':
      return [(payload as unknown as ContentTaskFolderDeletePayload).folder]
    case 'folder_rename': {
      const { source_folder, new_folder } = payload as unknown as ContentTaskFolderRenamePayload
      return [... new Set([source_folder, new_folder])]
    }
    default:
      throw new ApiError(400, `不支持的任务类型：${kind}`)
  }
}

/** Task items per kind, derived from the payload alone. */
export function task_item_paths(kind: ContentTaskKind, payload: Record<string, unknown>): { path: string, action: string }[] {
  switch (kind) {
    case 'move': {
      const { moves } = payload as unknown as ContentTaskMovePayload
      return [... new Set(moves.map(move => move.file_name))].map(path => ({ path, action: 'move' }))
    }
    case 'rename': {
      const { old_file_name } = payload as unknown as ContentTaskRenamePayload
      return [{ path: old_file_name, action: 'rename' }]
    }
    case 'delete': {
      const { file_names, folders } = payload as unknown as ContentTaskDeletePayload
      return [
        ... [... new Set(file_names)].map(path => ({ path, action: 'delete' })),
        ... [... new Set(folders)].map(path => ({ path, action: 'folder_delete' })),
      ]
    }
    case 'folder_create':
      return [{ path: (payload as unknown as ContentTaskFolderCreatePayload).folder, action: 'folder_create' }]
    case 'folder_delete':
      return [{ path: (payload as unknown as ContentTaskFolderDeletePayload).folder, action: 'folder_delete' }]
    case 'folder_rename':
      return [{ path: (payload as unknown as ContentTaskFolderRenamePayload).source_folder, action: 'folder_rename' }]
    default:
      throw new ApiError(400, `不支持的任务类型：${kind}`)
  }
}

export async function execute_task(task: ContentTask, items: ContentTaskItem[]) {
  switch (task.kind) {
    case 'move':
      return execute_move_task(task, items)
    case 'rename':
      return execute_rename_task(task, items)
    case 'delete':
      return execute_delete_task(task, items)
    case 'folder_create':
      return execute_folder_create_task(task, items)
    case 'folder_delete':
      return execute_folder_delete_task(task, items)
    case 'folder_rename':
      return execute_folder_rename_task(task, items)
    default:
      throw new ApiError(400, `不支持的任务类型：${task.kind}`)
  }
}

function item_of(items: ContentTaskItem[], path: string, action: string) {
  return items.find(item => item.path === path && item.action === action)
}

async function execute_move_task(task: ContentTask, items: ContentTaskItem[]) {
  const payload = task.payload as unknown as ContentTaskMovePayload
  const result = await apply_attachment_moves(task.scope_id, payload.moves)
  const renamed = new Map(result.succeeded.map(item => [item.old_file_name, item.new_file_name]))
  const skipped = new Map(result.skipped.map(item => [item.file_name, item.reason]))
  for (const item of items) {
    const reason = skipped.get(item.path)
    if (reason !== undefined) {
      await update_task_item(task.id, item.id, { status: 'skipped', result: { reason } })
      continue
    }
    // Not in either list: a same-path move, which is a no-op by definition.
    await update_task_item(task.id, item.id, { status: 'done', result: { new_path: renamed.get(item.path) ?? item.path } })
  }
}

async function execute_rename_task(task: ContentTask, items: ContentTaskItem[]) {
  const payload = task.payload as unknown as ContentTaskRenamePayload
  const row = await apply_attachment_rename(task.scope_id, payload.old_file_name, payload.new_file_name)
  const item = item_of(items, payload.old_file_name, 'rename')
  if (item)
    await update_task_item(task.id, item.id, { status: 'done', result: { new_path: row.file_name } })
}

async function execute_delete_task(task: ContentTask, items: ContentTaskItem[]) {
  const payload = task.payload as unknown as ContentTaskDeletePayload
  // Files go through the revision-checked save, exactly like the editor's
  // delete flow: references are removed in the same write that drops the rows.
  const result = await update_story(task.scope_id, payload.markdown, payload.file_names, payload.base_revision, payload.can_private)
  const skipped = new Map(result.skipped.map(item => [item.file_name, item.reason]))
  const deleted = new Set(result.succeeded)
  for (const item of items.filter(entry => entry.action === 'delete')) {
    if (deleted.has(item.path)) {
      await update_task_item(task.id, item.id, { status: 'done' })
      continue
    }
    const reason = skipped.get(item.path)
    if (reason !== undefined) {
      await update_task_item(task.id, item.id, { status: 'skipped', result: { reason } })
      continue
    }
    await update_task_item(task.id, item.id, { status: 'skipped', result: { reason: '附件不存在或已被删除' } })
  }
  // Folders go after the files: a folder still holding files is a 409, so
  // itemizing the failure beats failing the whole task when one folder stays.
  for (const item of items.filter(entry => entry.action === 'folder_delete')) {
    try {
      await apply_folder_delete(task.scope_id, item.path)
      await update_task_item(task.id, item.id, { status: 'done' })
    }
    catch (error) {
      await update_task_item(task.id, item.id, {
        status: 'failed',
        result: { reason: error instanceof ApiError ? error.message : '删除失败' },
      })
    }
  }
}

async function execute_folder_create_task(task: ContentTask, items: ContentTaskItem[]) {
  const payload = task.payload as unknown as ContentTaskFolderCreatePayload
  await apply_folder_create(task.scope_id, payload.folder)
  const item = item_of(items, payload.folder, 'folder_create')
  if (item)
    await update_task_item(task.id, item.id, { status: 'done' })
}

async function execute_folder_delete_task(task: ContentTask, items: ContentTaskItem[]) {
  const payload = task.payload as unknown as ContentTaskFolderDeletePayload
  await apply_folder_delete(task.scope_id, payload.folder)
  const item = item_of(items, payload.folder, 'folder_delete')
  if (item)
    await update_task_item(task.id, item.id, { status: 'done' })
}

async function execute_folder_rename_task(task: ContentTask, items: ContentTaskItem[]) {
  const payload = task.payload as unknown as ContentTaskFolderRenamePayload
  await apply_folder_rename(task.scope_id, payload.source_folder, payload.new_folder)
  const item = item_of(items, payload.source_folder, 'folder_rename')
  if (item)
    await update_task_item(task.id, item.id, { status: 'done', result: { new_path: payload.new_folder } })
}
