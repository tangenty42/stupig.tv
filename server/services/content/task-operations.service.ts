import type { ContentPathLock, ContentTask, ContentTaskDeletePayload, ContentTaskFolderCreatePayload, ContentTaskFolderDeletePayload, ContentTaskFolderRenamePayload, ContentTaskItem, ContentTaskKind, ContentTaskMovePayload, ContentTaskRenamePayload } from '@shared/types/content'
import { ApiError } from '@server/errors/ApiError'
import { list_scope_locks } from '@server/lib/operation-lock'
import { list_scope_attachments, list_scope_folders, list_scope_paths } from '@server/services/content-attachments.service'
import { attachment_ancestor_folders, attachment_base_name, attachment_name_conflict_message, attachment_path_join, attachment_path_taken, extract_attachment_names } from '@shared/content-markdown'
import { apply_attachment_moves, apply_attachment_rename, apply_folder_create, apply_folder_delete, apply_folder_rename, resolve_attachment_name, resolve_renamed_attachment_name } from './attachment-structure.service'
import { get_story, update_story } from './story.service'
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

/* ------------------------------------------------------------------------- */
/* Preflight: the same rules, read-only                                      */
/* ------------------------------------------------------------------------- */

export interface ContentTaskPreflightItem {
  path: string
  action: string
  ok: boolean
  /** Populated when ok is false; the same message the executor would produce. */
  reason: string | null
}

export interface ContentTaskPreflight {
  items: ContentTaskPreflightItem[]
  /** Live locks in the scope; the UI disables whatever they cover. */
  locks: ContentPathLock[]
}

/**
 * Read-only verdicts for a would-be task: every item passes through the same
 * name/conflict rules the executor applies, plus existence and reference
 * checks. Advisory by definition — execution re-checks against fresher state —
 * but the editor's disabled states and conflict previews come from here, never
 * from a client-side copy of the rules.
 */
export async function preflight_task(scope_id: number, kind: ContentTaskKind, payload: Record<string, unknown>): Promise<ContentTaskPreflight> {
  const story = await get_story(scope_id)
  const items = task_item_paths(kind, payload)
  const [paths, attachments, folders, locks] = await Promise.all([
    list_scope_paths(scope_id),
    list_scope_attachments(scope_id),
    list_scope_folders(scope_id),
    list_scope_locks(scope_id),
  ])
  const file_names = new Set(attachments.map(attachment => attachment.file_name))
  // A folder exists explicitly (row) or implicitly (it holds files).
  const folder_set = new Set(folders)
  for (const attachment of attachments) {
    for (const ancestor of attachment_ancestor_folders(attachment.file_name))
      folder_set.add(ancestor)
  }

  let verdicts: ContentTaskPreflightItem[]
  switch (kind) {
    case 'move': {
      const { moves } = payload as unknown as ContentTaskMovePayload
      const sources = new Set(moves.map(move => move.file_name.toLowerCase()))
      const remaining = paths.filter(path => ! sources.has(path.toLowerCase()))
      verdicts = items.map((item) => {
        if (! file_names.has(item.path))
          return { ... item, ok: false, reason: '附件不存在或已被删除' }
        const move = moves.find(entry => entry.file_name === item.path)!
        const destination = attachment_path_join(move.target_folder, attachment_base_name(move.file_name))
        if (destination !== item.path && attachment_path_taken(remaining, destination))
          return { ... item, ok: false, reason: attachment_name_conflict_message }
        return { ... item, ok: true, reason: null }
      })
      break
    }
    case 'rename': {
      const { old_file_name, new_file_name } = payload as unknown as ContentTaskRenamePayload
      verdicts = items.map((item) => {
        if (! file_names.has(old_file_name))
          return { ... item, ok: false, reason: '附件不存在或已被删除' }
        try {
          resolve_renamed_attachment_name(old_file_name, new_file_name, paths)
          return { ... item, ok: true, reason: null }
        }
        catch (error) {
          return { ... item, ok: false, reason: error instanceof ApiError ? error.message : '文件名不合法' }
        }
      })
      break
    }
    case 'delete': {
      const referenced = new Set(extract_attachment_names(story.markdown))
      verdicts = items.map((item) => {
        if (item.action === 'delete') {
          if (! file_names.has(item.path))
            return { ... item, ok: false, reason: '附件不存在或已被删除' }
          // The draft's references are editor-local; execution re-checks against
          // the submitted markdown, so this only mirrors the stored document.
          if (referenced.has(item.path))
            return { ... item, ok: false, reason: '已被正文引用' }
          return { ... item, ok: true, reason: null }
        }
        // folder_delete
        if (! folder_set.has(item.path))
          return { ... item, ok: false, reason: '文件夹不存在或已被删除' }
        if (attachments.some(attachment => attachment.file_name.startsWith(`${item.path}/`)))
          return { ... item, ok: false, reason: '文件夹内仍有附件，无法删除' }
        return { ... item, ok: true, reason: null }
      })
      break
    }
    case 'folder_create': {
      const { folder } = payload as unknown as ContentTaskFolderCreatePayload
      verdicts = items.map((item) => {
        try {
          resolve_attachment_name(folder, paths, 'reject')
          return { ... item, ok: true, reason: null }
        }
        catch (error) {
          return { ... item, ok: false, reason: error instanceof ApiError ? error.message : '文件名不合法' }
        }
      })
      break
    }
    case 'folder_delete': {
      const { folder } = payload as unknown as ContentTaskFolderDeletePayload
      verdicts = items.map((item) => {
        if (! folder_set.has(folder))
          return { ... item, ok: false, reason: '文件夹不存在或已被删除' }
        if (attachments.some(attachment => attachment.file_name.startsWith(`${folder}/`)))
          return { ... item, ok: false, reason: '文件夹内仍有附件，无法删除' }
        return { ... item, ok: true, reason: null }
      })
      break
    }
    case 'folder_rename': {
      const { source_folder, new_folder } = payload as unknown as ContentTaskFolderRenamePayload
      verdicts = items.map((item) => {
        if (new_folder.startsWith(`${source_folder}/`))
          return { ... item, ok: false, reason: '不能移动到文件夹自身内部' }
        if (! folder_set.has(source_folder))
          return { ... item, ok: false, reason: '文件夹不存在或已被删除' }
        // A folder destination merges; a file answering to it is a conflict.
        if (file_names.has(new_folder))
          return { ... item, ok: false, reason: attachment_name_conflict_message }
        try {
          resolve_attachment_name(new_folder, paths, 'merge')
          return { ... item, ok: true, reason: null }
        }
        catch (error) {
          return { ... item, ok: false, reason: error instanceof ApiError ? error.message : '文件名不合法' }
        }
      })
      break
    }
    default:
      throw new ApiError(400, `不支持的任务类型：${kind}`)
  }
  return { items: verdicts, locks }
}
