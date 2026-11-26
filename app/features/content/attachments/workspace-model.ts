import type { WorkspaceCommand } from '@shared/content-workspace'
import type { ContentWorkspaceNode } from '@shared/types/content'
import type { ContentUploadReservation, ContentUploadSession } from '@shared/types/content-upload'
import type { UploadPreparation } from '../uploads/admission'
import { attachment_base_name, attachment_has_private_suffix, attachment_name_without_private_suffix, attachment_path_is_private, compare_attachment_items, processable_image_mime, redactable_attachment_mime } from '@shared/content-markdown'
import { attachment_name_key } from '@shared/content-workspace'

export interface WorkspaceListRow {
  key: string
  parent_id: number
  name: string
  path: string
  depth: number
  node?: ContentWorkspaceNode
  session?: ContentUploadSession
  preparation?: UploadPreparation
  /** Folder synthesized for a pending upload whose target directory does not exist yet. */
  pending_folder?: true
}

export interface WorkspaceCommandFootprint {
  ids: number[]
  paths: { path: string, subtree: boolean }[]
}
export type WorkspaceAction = WorkspaceCommand extends infer C ? C extends WorkspaceCommand ? Omit<C, 'request_id' | 'scope_id' | 'on_error'> : never : never

/** Capture both old and intended destinations before a synchronized snapshot changes. */
export function workspace_command_footprint(command: WorkspaceAction, nodes: ContentWorkspaceNode[]): WorkspaceCommandFootprint {
  const targets = 'targets' in command ? command.targets : 'target' in command ? [command.target] : []
  const source = nodes.filter(node => targets.some(target => target.id === node.id))
  const paths = source.map(node => ({ path: node.path, subtree: node.kind === 'folder' }))
  const destination = (parent: number, name: string) => {
    const prefix = nodes.find(node => node.id === parent)?.path
    return prefix ? `${prefix}/${name}` : name
  }
  if (command.operation === 'create_folder')
    paths.push({ path: destination(command.parent_id, command.name), subtree: true })
  for (const node of source) {
    if (command.operation === 'rename')
      paths.push({ path: destination(node.parent_id, command.name + (node.kind === 'file' && attachment_has_private_suffix(node.name) ? '.good' : '')), subtree: node.kind === 'folder' })
    if (command.operation === 'move')
      paths.push({ path: destination(command.parent_id, node.name), subtree: node.kind === 'folder' })
    if (command.operation === 'set_private')
      paths.push({ path: destination(node.parent_id, attachment_name_without_private_suffix(node.name) + (command.private ? '.good' : '')), subtree: node.kind === 'folder' })
  }
  return { ids: targets.map(target => target.id), paths }
}

export function workspace_footprints_overlap(left: WorkspaceCommandFootprint, right: WorkspaceCommandFootprint) {
  return left.ids.some(id => right.ids.includes(id)) || left.paths.some(a => right.paths.some((b) => {
    const first = attachment_name_key(a.path)
    const second = attachment_name_key(b.path)
    return first === second || (a.subtree && second.startsWith(`${first}/`)) || (b.subtree && first.startsWith(`${second}/`))
  }))
}

export function workspace_row_footprint(row: WorkspaceListRow): WorkspaceCommandFootprint {
  return { ids: row.node ? [row.node.id] : [], paths: [{ path: row.path, subtree: row.node?.kind === 'folder' }] }
}

/** Deepest existing folder along a pending path; undefined when no segment matches. */
export function workspace_deepest_folder_id(path: string, nodes: ContentWorkspaceNode[]) {
  const folders = nodes.filter(node => node.kind === 'folder')
  let current: ContentWorkspaceNode | undefined
  let prefix = ''
  for (const segment of path.split('/').slice(0, - 1)) {
    prefix = prefix ? `${prefix}/${segment}` : segment
    const next = folders.find(node => attachment_name_key(node.path) === attachment_name_key(prefix))
    if (! next)
      break
    current = next
  }
  return current?.id
}

/** Keep requested destinations visible while a command is in flight or its receipt is unknown. */
export function project_workspace_commands(nodes: ContentWorkspaceNode[], commands: readonly WorkspaceAction[]) {
  let projected = nodes
  for (const command of commands) {
    if (command.operation !== 'rename' && command.operation !== 'move')
      continue
    const ids = command.operation === 'rename' ? [command.target.id] : command.targets.map(target => target.id)
    // A folder landing on a same-named folder merges instead of moving; keep
    // the rows in place until the receipt replaces the whole tree.
    const merge = projected.some(node => ids.includes(node.id) && node.kind === 'folder' && projected.some(other => other.kind === 'folder' && other.id !== node.id
      && other.parent_id === (command.operation === 'move' ? command.parent_id : node.parent_id)
      && attachment_name_key(other.name) === attachment_name_key(command.operation === 'rename' ? command.name : node.name)))
    if (merge)
      continue
    const changes = projected.filter(node => ids.includes(node.id)).map((node) => {
      const parent_id = command.operation === 'move' ? command.parent_id : node.parent_id
      const name = command.operation === 'rename'
        ? command.name + (node.kind === 'file' && attachment_has_private_suffix(node.name) ? '.good' : '')
        : node.name
      const parent_path = projected.find(candidate => candidate.id === parent_id)?.path ?? ''
      return { id: node.id, parent_id, name, old_path: node.path, new_path: parent_path ? `${parent_path}/${name}` : name }
    })
    projected = projected.map((node) => {
      const change = changes.find(item => node.id === item.id || (item.old_path !== node.path && node.path.startsWith(`${item.old_path}/`)))
      if (! change)
        return node
      const path = change.new_path + node.path.slice(change.old_path.length)
      const direct = node.id === change.id
      return {
        ... node,
        parent_id: direct ? change.parent_id : node.parent_id,
        name: direct ? change.name : node.name,
        path,
        attachment: node.attachment ? { ... node.attachment, file_name: attachment_base_name(path) } : undefined,
      }
    })
  }
  return projected
}

export function project_workspace_rows(nodes: ContentWorkspaceNode[], sessions: ContentUploadSession[], root: number, expanded: ReadonlySet<number>, preparations: readonly UploadPreparation[] = []) {
  const entries: WorkspaceListRow[] = nodes.map(node => ({ key: `node:${node.id}`, parent_id: node.parent_id, name: node.name, path: node.path, depth: 0, node }))
  const folder_ids = new Set(nodes.filter(node => node.kind === 'folder').map(node => node.id))
  const folders_by_key = new Map(nodes.filter(node => node.kind === 'folder').map(node => [attachment_name_key(node.path), node]))
  // Missing target directories are synthesized so pending rows nest at their
  // destination instead of surfacing at the root with their whole path.
  const synthesized = new Map<string, { row: WorkspaceListRow, id: number }>()
  let next_synthetic_id = - 1
  const ensure_parent = (path: string): number => {
    const slash = path.lastIndexOf('/')
    if (slash <= 0)
      return root
    const folder_path = path.slice(0, slash)
    const key = attachment_name_key(folder_path)
    const existing = folders_by_key.get(key)
    if (existing)
      return existing.id
    const shared = synthesized.get(key)
    if (shared)
      return shared.id
    const id = next_synthetic_id --
    const row: WorkspaceListRow = { key: `pending-folder:${key}`, parent_id: ensure_parent(folder_path), name: attachment_base_name(folder_path), path: folder_path, depth: 0, pending_folder: true }
    synthesized.set(key, { row, id })
    entries.push(row)
    return id
  }
  for (const session of sessions) {
    const replacing = session.purpose === 'replace' || session.purpose === 'redact' ? session.source_id : session.replacement_id
    // Admission exclusively reserves the target name. Its published file can
    // arrive before the upload completion response, through the independent
    // attachment subscription. Present one upload task until completion; keep
    // the stored node in the catalog so cancellation can reveal it unchanged.
    const existing = replacing
      ? entries.find(row => row.node?.id === replacing)
      : entries.find(row => row.node?.kind === 'file' && attachment_name_key(row.path) === attachment_name_key(session.path))
    // A receipt may precede the new folder's independent catalog snapshot.
    const parent = session.parent_id ?? existing?.parent_id
    const parent_id = parent !== undefined && parent !== root && folder_ids.has(parent) ? parent : ensure_parent(session.path)
    const task = { key: `session:${session.id}`, parent_id, name: attachment_base_name(session.path), path: session.path, depth: 0, session }
    if (existing)
      entries.splice(entries.indexOf(existing), 1, task)
    else
      entries.push(task)
  }
  for (const preparation of preparations) {
    if (sessions.some(session => session.id === preparation.session_id))
      continue
    const replacing = preparation.purpose === 'replace' || preparation.purpose === 'redact' ? preparation.source_id : preparation.replacement_id
    const existing = replacing ? entries.find(row => row.node?.id === replacing) : undefined
    const task = {
      key: `preparing:${preparation.id}`,
      parent_id: ensure_parent(preparation.path),
      name: attachment_base_name(preparation.path),
      path: preparation.path,
      depth: 0,
      preparation,
    }
    if (existing)
      entries.splice(entries.indexOf(existing), 1, task)
    else
      entries.push(task)
  }
  const is_folder = (row: WorkspaceListRow) => row.node?.kind === 'folder' || row.pending_folder === true
  const result: WorkspaceListRow[] = []
  const walk = (parent: number, depth: number) => {
    for (const row of entries.filter(row => row.parent_id === parent).sort((a, b) => compare_attachment_items({ name: a.name, is_folder: is_folder(a) }, { name: b.name, is_folder: is_folder(b) }))) {
      result.push({ ... row, depth })
      if (row.node?.kind === 'folder' && expanded.has(row.node.id)) {
        walk(row.node.id, depth + 1)
      }
      else if (row.pending_folder) {
        const chain = synthesized.get(attachment_name_key(row.path))
        if (chain)
          walk(chain.id, depth + 1)
      }
    }
  }
  walk(root, 0)
  return result
}
export function workspace_capabilities(row: WorkspaceListRow, options: { readonly: boolean, can_private: boolean, pending: boolean, pending_reason?: string, reservations?: ContentUploadReservation[], nodes?: ContentWorkspaceNode[] }) {
  const node = row.node
  // A stored file's flag is authoritative: a 删减版 stays public inside a private folder.
  const denied = Boolean((node?.attachment ? node.attachment.is_private : attachment_path_is_private(row.path)) && ! options.can_private)
  const public_variant = Boolean(node?.attachment?.is_image && node.attachment.is_redacted_view && node.attachment.redacted_url)
  const normal_readable = Boolean(node?.attachment?.url && ! node.attachment.is_redacted_view && ! denied)
  const normal_read_reasons = denied ? ['没有机密附件权限'] : ! normal_readable ? ['附件暂不可读取'] : []
  const reservations = options.reservations ?? []
  const protected_ids = new Set(reservations.flatMap(item => [item.source_id, item.replacement_id]))
  const name = attachment_name_key(row.path)
  const reserved = node?.kind === 'file' && (protected_ids.has(node.id) || reservations.some(item => attachment_name_key(item.path) === name))
  const contains_reservation = node?.kind === 'folder' && (reservations.some(item => item.parent_id === node.id || attachment_name_key(item.path).startsWith(`${name}/`)) || (options.nodes ?? []).some(source => protected_ids.has(source.id) && attachment_name_key(source.path).startsWith(`${name}/`)))
  const busy = Boolean(row.session) || options.pending || reserved
  const edit = ! options.readonly && ! denied && ! busy && !! node
  const edit_reasons = [
    ... (options.readonly ? ['只读模式'] : []),
    ... (options.pending ? [options.pending_reason ?? '正在提交操作'] : []),
    ... (denied ? ['没有机密附件权限'] : []),
    ... (row.session ? ['上传会话尚未结束'] : []),
    ... (reserved && ! row.session ? ['附件已被上传预约'] : []),
    ... (! node ? ['附件尚未发布'] : []),
  ]
  const file_reasons = [... edit_reasons, ... (node?.kind !== 'file' ? ['仅支持文件'] : [])]
  const original_only = node?.attachment?.is_image && ! processable_image_mime(node.attachment.mime_type)
  return {
    open: public_variant || (Boolean(node?.attachment?.url) && ! denied),
    download: normal_readable,
    preview: Boolean(node?.attachment?.is_image && normal_readable),
    preview_redacted: Boolean(node?.attachment?.is_image && node.attachment.has_redacted && node.attachment.redacted_url),
    rename: edit, move: edit, delete: edit && ! contains_reservation,
    replace: edit && node?.kind === 'file',
    image_edit: edit && ! original_only && !! node?.attachment?.image,
    private: edit && ! contains_reservation && options.can_private,
    redact: edit && ! original_only && !! node?.attachment?.is_private && !! redactable_attachment_mime(node.name),
    reason: options.pending ? options.pending_reason ?? '正在提交操作' : denied ? '没有机密附件权限' : row.session ? '上传会话尚未结束' : reserved ? '附件已被上传预约' : contains_reservation ? '目录内有上传预约' : '',
    reasons: {
      open: public_variant ? [] : denied ? ['没有机密附件权限'] : ! node?.attachment?.url ? ['附件暂不可读取'] : [],
      preview: normal_read_reasons,
      download: normal_read_reasons,
      rename: edit_reasons,
      move: edit_reasons,
      delete: [... edit_reasons, ... (contains_reservation ? ['目录内有上传预约'] : [])],
      replace: file_reasons,
      image_edit: [... file_reasons, ... (original_only ? ['此图片格式不支持编辑'] : ! node?.attachment?.image ? ['图片尚未处理就绪'] : [])],
      private: [... edit_reasons, ... (! options.can_private ? ['没有机密附件权限'] : []), ... (contains_reservation ? ['目录内有上传预约'] : [])],
      redact: [... edit_reasons, ... (! node?.attachment?.is_private ? ['仅支持机密附件'] : []), ... (original_only ? ['此图片格式不支持编辑'] : ! node || ! redactable_attachment_mime(node.name) ? ['格式不支持'] : [])],
    },
  }
}
