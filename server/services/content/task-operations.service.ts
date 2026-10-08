import type { ContentPathLock, ContentStoryAttachment, ContentTask, ContentTaskDeletePayload, ContentTaskFolderCreatePayload, ContentTaskFolderDeletePayload, ContentTaskFolderRenamePayload, ContentTaskItem, ContentTaskKind, ContentTaskMovePayload, ContentTaskRenamePayload, ContentTaskReplacePayload, ContentTaskUploadedPart, ContentTaskUploadPayload } from '@shared/types/content'
import { ApiError } from '@server/errors/ApiError'
import { list_scope_locks } from '@server/lib/operation-lock'
import { complete_multipart_upload, copy_object, create_multipart_upload, delete_object_best_effort, head_object, list_parts } from '@server/lib/storage'
import { get_scope_attachment, insert_attachment_row, list_scope_attachments, list_scope_folders, list_scope_paths } from '@server/services/content-attachments.service'
import { runtime_config } from '@shared/config'
import { attachment_ancestor_folders, attachment_base_name, attachment_mime_type, attachment_name_conflict_message, attachment_path_join, attachment_path_taken, extract_attachment_names, sanitize_attachment_path } from '@shared/content-markdown'
import { apply_attachment_moves, apply_attachment_rename, apply_folder_create, apply_folder_delete, apply_folder_rename, publish_attachment_change, resolve_attachment_name, resolve_renamed_attachment_name } from './attachment-structure.service'
import { get_story, update_story } from './story.service'
import { update_task_item } from './task.service'
import { apply_attachment_replace, materialize_attachment_folders } from './upload.service'

const config = runtime_config()

/**
 * Task executors: apply one task against the scope with its path locks already
 * held by the runner, and report per-item outcomes. Pure-DB kinds finish inside
 * the dispatch; transfer kinds (upload/replace) only *prepare* here and are
 * finished by the client's reportTaskItem once the bytes have landed.
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
    case 'upload': {
      const { uploads } = payload as unknown as ContentTaskUploadPayload
      return [... new Set(uploads.map(entry => entry.path))]
    }
    case 'replace': {
      const { old_file_name, mode, file_name } = payload as unknown as ContentTaskReplacePayload
      // keep-name swaps only the object, so the old path is the whole claim;
      // new-name lands on a name of its own and has to claim that too.
      return mode === 'new-name' ? [... new Set([old_file_name, file_name])] : [old_file_name]
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
export function task_item_paths(kind: ContentTaskKind, payload: Record<string, unknown>): { path: string, action: string, bytes_total?: number }[] {
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
    case 'upload': {
      const { uploads } = payload as unknown as ContentTaskUploadPayload
      return [... new Set(uploads.map(entry => entry.path))]
        .map(path => ({ path, action: 'upload', bytes_total: uploads.find(entry => entry.path === path)?.size ?? 0 }))
    }
    case 'replace': {
      const replace = payload as unknown as ContentTaskReplacePayload
      return [{ path: replace.old_file_name, action: 'replace', bytes_total: replace.size }]
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

/** Bytes per part for a transfer; null means the file is small enough for one PUT. */
export function upload_part_size(bytes_total: number) {
  const part = config.app.content.upload.partSizeMb * 1024 * 1024
  return bytes_total > part ? part : null
}

export interface ContentTaskOutcome {
  /** false when the client still owes bytes (transfer kinds); the task stays running. */
  complete: boolean
}

export async function execute_task(task: ContentTask, items: ContentTaskItem[]): Promise<ContentTaskOutcome> {
  switch (task.kind) {
    case 'move':
      return execute_move_task(task, items)
    case 'rename':
      return execute_rename_task(task, items)
    case 'delete':
      return execute_delete_task(task, items)
    case 'upload':
      return execute_upload_task(task, items)
    case 'replace':
      return execute_replace_task(task, items)
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

function error_message_of(error: unknown) {
  return error instanceof Error ? error.message : '操作失败'
}

async function execute_move_task(task: ContentTask, items: ContentTaskItem[]): Promise<ContentTaskOutcome> {
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
  return { complete: true }
}

async function execute_rename_task(task: ContentTask, items: ContentTaskItem[]): Promise<ContentTaskOutcome> {
  const payload = task.payload as unknown as ContentTaskRenamePayload
  const row = await apply_attachment_rename(task.scope_id, payload.old_file_name, payload.new_file_name)
  const item = item_of(items, payload.old_file_name, 'rename')
  if (item)
    await update_task_item(task.id, item.id, { status: 'done', result: { new_path: row.file_name } })
  return { complete: true }
}

async function execute_delete_task(task: ContentTask, items: ContentTaskItem[]): Promise<ContentTaskOutcome> {
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
        result: { reason: error_message_of(error) },
      })
    }
  }
  return { complete: true }
}

/* ------------------------------------------------------------------------- */
/* Transfer tasks: prepare here, the client finishes them                    */
/* ------------------------------------------------------------------------- */

/**
 * Prepares one upload item: settles the staging key, decides single-PUT vs
 * multipart and leaves the item `active` for the client to fill. The final
 * attachment name is deliberately NOT resolved here — the scope's paths are
 * arbitrated at finalize time, under the same lock, so a long upload cannot
 * reserve a name against everything else that happens meanwhile (§6.1).
 */
async function execute_upload_task(task: ContentTask, items: ContentTaskItem[]): Promise<ContentTaskOutcome> {
  const payload = task.payload as unknown as ContentTaskUploadPayload
  for (const item of items) {
    const entry = payload.uploads.find(upload => upload.path === item.path)
    if (! entry) {
      await update_task_item(task.id, item.id, { status: 'skipped', result: { reason: '缺少上传信息' } })
      continue
    }
    try {
      // Legality only: an empty existing set leaves the conflict policy moot,
      // so this rejects illegal names and nothing else.
      resolve_attachment_name(entry.path, [], 'suffix')
    }
    catch (error) {
      await update_task_item(task.id, item.id, { status: 'skipped', result: { reason: error_message_of(error) } })
      continue
    }
    // A resumed task already has its staging key; re-allocating would orphan
    // the parts the client already uploaded under the old one.
    if (item.staging_key) {
      await update_task_item(task.id, item.id, { status: 'active' })
      continue
    }
    const staging_key = `content-upload/${task.scope_id}/${crypto.randomUUID()}`
    const part_size = upload_part_size(entry.size)
    const upload_id = part_size ? await create_multipart_upload(staging_key, entry.mime_type) : null
    await update_task_item(task.id, item.id, { status: 'active', staging_key, upload_id, part_size })
  }
  // The client owns the rest of this task's life: reportTaskItem lands the
  // bytes and completes it, so dispatch must not finish it here.
  return { complete: false }
}

/** Prepares a replacement: one staged object that will take the old row's place. */
async function execute_replace_task(task: ContentTask, items: ContentTaskItem[]): Promise<ContentTaskOutcome> {
  const payload = task.payload as unknown as ContentTaskReplacePayload
  const item = item_of(items, payload.old_file_name, 'replace')
  if (! item)
    return { complete: true }
  const attachments = await list_scope_attachments(task.scope_id)
  const target = attachments.find(attachment => attachment.file_name === payload.old_file_name)
  if (! target) {
    await update_task_item(task.id, item.id, { status: 'skipped', result: { reason: '附件不存在或已被删除' } })
    return { complete: true }
  }
  // A replacement swaps the object but not the row's key, so replacing an
  // encrypted file would leave a key on plaintext bytes: the client would try
  // to decrypt readable content and the file would end up unopenable. 取消加密
  // is the operation that owns that transition.
  if (target.is_encrypted) {
    await update_task_item(task.id, item.id, { status: 'skipped', result: { reason: '已加密' } })
    return { complete: true }
  }
  const staging_key = `content-upload/${task.scope_id}/${crypto.randomUUID()}`
  const part_size = upload_part_size(payload.size)
  const upload_id = part_size ? await create_multipart_upload(staging_key, payload.content_type) : null
  await update_task_item(task.id, item.id, { status: 'active', staging_key, upload_id, part_size })
  return { complete: false }
}

/**
 * Lands a finished transfer item: completes the multipart (if any), then hands
 * the staged object to the same code the legacy upload path uses. Runs under
 * the task's path locks, which is what makes the name arbitration safe.
 */
export async function finalize_transfer_item(task: ContentTask, item: ContentTaskItem, parts: ContentTaskUploadedPart[]): Promise<ContentStoryAttachment> {
  if (! item.staging_key)
    throw new ApiError(409, '任务项缺少暂存对象')
  if (item.upload_id)
    await complete_multipart_upload(item.staging_key, item.upload_id, parts)

  if (item.action === 'replace') {
    const payload = task.payload as unknown as ContentTaskReplacePayload
    return await apply_attachment_replace(
      task.scope_id,
      payload.old_file_name,
      item.staging_key,
      payload.file_name,
      payload.content_type,
      payload.mode,
    )
  }

  const payload = task.payload as unknown as ContentTaskUploadPayload
  const entry = payload.uploads.find(upload => upload.path === item.path)
  const object = await head_object(item.staging_key)
  const base_name = sanitize_attachment_path(entry?.path ?? item.path, config.app.content.link.fileNameMaxBytes)
  // The authoritative conflict pass: the planned path was locked, so this
  // normally returns it unchanged; a name that appeared anyway still lands
  // (suffixed) instead of failing an upload the user already paid for.
  const file_name = resolve_attachment_name(base_name, await list_scope_paths(task.scope_id), 'suffix')
  const target_key = `content/att/${crypto.randomUUID()}`
  const etag = await copy_object(item.staging_key, target_key)
  await delete_object_best_effort(item.staging_key)
  const version = etag ?? object.etag ?? String(Date.now())
  try {
    await insert_attachment_row({
      story_id: task.scope_id,
      file_name,
      object_key: target_key,
      mime_type: attachment_mime_type(file_name),
      file_size: object.size,
      version,
    })
  }
  catch (error) {
    await delete_object_best_effort(target_key)
    throw error
  }
  await materialize_attachment_folders(task.scope_id, file_name)
  await publish_attachment_change(task.scope_id)
  const row = await get_scope_attachment(task.scope_id, file_name)
  if (! row)
    throw new ApiError(500, '附件写入失败，请重试')
  return row
}

/** The stage a resuming client needs: where the bytes go and which parts already landed. */
export async function transfer_item_resume_state(item: ContentTaskItem) {
  if (! item.staging_key)
    throw new ApiError(409, '任务项尚未开始')
  return {
    staging_key: item.staging_key,
    upload_id: item.upload_id,
    part_size: item.part_size,
    // A single-PUT item has no parts to inventory: the client re-sends it whole.
    uploaded_parts: item.upload_id ? await list_parts(item.staging_key, item.upload_id) : [],
    sign_batch_size: config.app.content.upload.signBatchSize,
  }
}

async function execute_folder_create_task(task: ContentTask, items: ContentTaskItem[]): Promise<ContentTaskOutcome> {
  const payload = task.payload as unknown as ContentTaskFolderCreatePayload
  await apply_folder_create(task.scope_id, payload.folder)
  const item = item_of(items, payload.folder, 'folder_create')
  if (item)
    await update_task_item(task.id, item.id, { status: 'done' })
  return { complete: true }
}

async function execute_folder_delete_task(task: ContentTask, items: ContentTaskItem[]): Promise<ContentTaskOutcome> {
  const payload = task.payload as unknown as ContentTaskFolderDeletePayload
  await apply_folder_delete(task.scope_id, payload.folder)
  const item = item_of(items, payload.folder, 'folder_delete')
  if (item)
    await update_task_item(task.id, item.id, { status: 'done' })
  return { complete: true }
}

async function execute_folder_rename_task(task: ContentTask, items: ContentTaskItem[]): Promise<ContentTaskOutcome> {
  const payload = task.payload as unknown as ContentTaskFolderRenamePayload
  await apply_folder_rename(task.scope_id, payload.source_folder, payload.new_folder)
  const item = item_of(items, payload.source_folder, 'folder_rename')
  if (item)
    await update_task_item(task.id, item.id, { status: 'done', result: { new_path: payload.new_folder } })
  return { complete: true }
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
  /** The name an upload will land under when its planned one is taken (conflict resolved by suffix). */
  suggested_name?: string | null
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
    case 'upload': {
      const { uploads } = payload as unknown as ContentTaskUploadPayload
      // Per ENTRY, not per task item: a batch legitimately holds two files that
      // plan the same path (the client resolves them from these suggestions),
      // and task_item_paths collapses those by design.
      const claimed = [... paths]
      verdicts = uploads.map((entry) => {
        const base = { path: entry.path, action: 'upload', ok: true, reason: null as string | null }
        if (entry.size <= 0)
          return { ... base, ok: false, reason: '文件为空' }
        try {
          // Uploads step aside with a suffix instead of refusing, so a taken
          // name is not a verdict of "no" — it is a different name to show.
          const suggested = resolve_attachment_name(entry.path, claimed, 'suffix')
          claimed.push(suggested)
          return { ... base, suggested_name: suggested === entry.path ? null : suggested }
        }
        catch (error) {
          return { ... base, ok: false, reason: error_message_of(error) }
        }
      })
      break
    }
    case 'replace': {
      const replace = payload as unknown as ContentTaskReplacePayload
      verdicts = items.map((item) => {
        const target = attachments.find(attachment => attachment.file_name === replace.old_file_name)
        if (! target)
          return { ... item, ok: false, reason: '附件不存在或已被删除' }
        if (target.is_encrypted)
          return { ... item, ok: false, reason: '已加密' }
        if (replace.size <= 0)
          return { ... item, ok: false, reason: '文件为空' }
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
