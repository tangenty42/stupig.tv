import type { WorkspaceCommand } from '@shared/content-workspace'
import type { ContentWorkspaceNode } from '@shared/types/content'
import type { ContentUploadReservation, ContentUploadSession } from '@shared/types/content-upload'
import { attachment_base_name, attachment_path_is_private, compare_attachment_items, decrypted_attachment_name, is_encrypted_attachment, processable_image_mime, redactable_attachment_mime } from '@shared/content-markdown'
import { attachment_name_key } from '@shared/content-workspace'

export interface WorkspaceListRow {
  key: string
  parent_id: number
  name: string
  path: string
  depth: number
  node?: ContentWorkspaceNode
  session?: ContentUploadSession
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
      paths.push({ path: destination(node.parent_id, command.name + (node.kind === 'file' && is_encrypted_attachment(node.name) ? '.good' : '')), subtree: node.kind === 'folder' })
    if (command.operation === 'move')
      paths.push({ path: destination(command.parent_id, node.name), subtree: node.kind === 'folder' })
    if (command.operation === 'set_private')
      paths.push({ path: destination(node.parent_id, decrypted_attachment_name(node.name) + (command.private ? '.good' : '')), subtree: node.kind === 'folder' })
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
export function project_workspace_rows(nodes: ContentWorkspaceNode[], sessions: ContentUploadSession[], root: number, expanded: ReadonlySet<number>) {
  const entries: WorkspaceListRow[] = nodes.map(node => ({ key: `node:${node.id}`, parent_id: node.parent_id, name: node.name, path: node.path, depth: 0, node }))
  for (const session of sessions) {
    const replacing = session.purpose === 'replace' || session.purpose === 'redact' ? session.source_id : session.replacement_id
    // Admission exclusively reserves the target name. Its published file can
    // arrive before the upload completion response, through the independent
    // attachment subscription. Present one upload task until completion; keep
    // the stored node in the catalog so cancellation can reveal it unchanged.
    const existing = replacing
      ? entries.find(row => row.node?.id === replacing)
      : entries.find(row => row.node?.kind === 'file' && attachment_name_key(row.path) === attachment_name_key(session.path))
    const task = { key: `session:${session.id}`, parent_id: session.parent_id ?? existing?.parent_id ?? root, name: attachment_base_name(session.path), path: session.path, depth: 0, session }
    if (existing)
      entries.splice(entries.indexOf(existing), 1, task)
    else
      entries.push(task)
  }
  const result: WorkspaceListRow[] = []
  const walk = (parent: number, depth: number) => {
    for (const row of entries.filter(row => row.parent_id === parent).sort((a, b) => compare_attachment_items({ name: a.name, is_folder: a.node?.kind === 'folder' }, { name: b.name, is_folder: b.node?.kind === 'folder' }))) {
      result.push({ ... row, depth })
      if (row.node?.kind === 'folder' && expanded.has(row.node.id))
        walk(row.node.id, depth + 1)
    }
  }
  walk(root, 0)
  return result
}
export function workspace_capabilities(row: WorkspaceListRow, options: { readonly: boolean, can_private: boolean, pending: boolean, pending_reason?: string, references: string[], reservations?: ContentUploadReservation[], nodes?: ContentWorkspaceNode[] }) {
  const node = row.node
  const denied = Boolean((node?.attachment?.is_private || attachment_path_is_private(row.path)) && ! options.can_private)
  const public_variant = Boolean(node?.attachment?.is_redacted_view && node.attachment.redacted_url)
  const normal_readable = Boolean(node?.attachment?.url && ! node.attachment.is_redacted_view && ! denied)
  const normal_read_reasons = denied ? ['没有机密附件权限'] : ! normal_readable ? ['附件暂不可读取'] : []
  const reservations = options.reservations ?? []
  const protected_ids = new Set(reservations.flatMap(item => [item.source_id, item.replacement_id]))
  const name = attachment_name_key(row.path)
  const reserved = node?.kind === 'file' && (protected_ids.has(node.id) || reservations.some(item => attachment_name_key(item.path) === name))
  const contains_reservation = node?.kind === 'folder' && (reservations.some(item => item.parent_id === node.id || attachment_name_key(item.path).startsWith(`${name}/`)) || (options.nodes ?? []).some(source => protected_ids.has(source.id) && attachment_name_key(source.path).startsWith(`${name}/`)))
  const busy = Boolean(row.session) || options.pending || reserved
  const referenced = options.references.some(path => path === row.path || row.path.startsWith(`${path}/`) || (node?.kind === 'folder' && path.startsWith(`${row.path}/`)))
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
    rename: edit, move: edit, delete: edit && ! referenced && ! contains_reservation,
    replace: edit && node?.kind === 'file',
    image_edit: edit && ! original_only && !! node?.attachment?.image,
    private: edit && ! contains_reservation && options.can_private,
    redact: edit && ! original_only && !! node?.attachment?.is_private && !! redactable_attachment_mime(node.name),
    reason: options.pending ? options.pending_reason ?? '正在提交操作' : denied ? '没有机密附件权限' : row.session ? '上传会话尚未结束' : reserved ? '附件已被上传预约' : contains_reservation ? '目录内有上传预约' : referenced ? '当前草稿仍有引用' : '',
    reasons: {
      open: public_variant ? [] : denied ? ['没有机密附件权限'] : ! node?.attachment?.url ? ['附件暂不可读取'] : [],
      preview: normal_read_reasons,
      download: normal_read_reasons,
      rename: edit_reasons,
      move: edit_reasons,
      delete: [... edit_reasons, ... (referenced ? ['当前草稿仍有引用'] : []), ... (contains_reservation ? ['目录内有上传预约'] : [])],
      replace: file_reasons,
      image_edit: [... file_reasons, ... (original_only ? ['此图片格式不支持编辑'] : ! node?.attachment?.image ? ['图片尚未处理就绪'] : [])],
      private: [... edit_reasons, ... (! options.can_private ? ['没有机密附件权限'] : []), ... (contains_reservation ? ['目录内有上传预约'] : [])],
      redact: [... edit_reasons, ... (! node?.attachment?.is_private ? ['仅支持机密附件'] : []), ... (original_only ? ['此图片格式不支持编辑'] : ! node || ! redactable_attachment_mime(node.name) ? ['格式不支持'] : [])],
    },
  }
}
