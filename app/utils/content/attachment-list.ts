import type { ContentStoryAttachment, ContentWorkspaceNode } from '@shared/types/content'
import type { MenuItem } from 'primevue/menuitem'
import type { WorkspaceListRow } from './workspace'
import { attachment_ancestor_folders, attachment_base_name, attachment_folder_of, attachment_inherits_private, attachment_mime_type, attachment_path_is_private, compare_attachment_items, decrypted_attachment_name } from '@shared/content-markdown'
import { attachment_name_key } from '@shared/content-workspace'

export type AttachmentMenuItem = MenuItem & { icon_name?: string, spin?: boolean }

/** An existing selection owns its menu; an outside right-click targets only that row. */
export function attachment_menu_context(row: WorkspaceListRow, selected_rows: WorkspaceListRow[]) {
  const selected = selected_rows.some(item => item.key === row.key) ? selected_rows : [row]
  return { selected, single: selected.length === 1 }
}

/** A batch remains available while any selected row is eligible. */
export function attachment_batch_action(rows: WorkspaceListRow[], assess: (row: WorkspaceListRow) => { allowed: boolean, reasons: readonly string[] }) {
  const assessed = rows.map(row => ({ row, ... assess(row) }))
  const targets = assessed.filter(item => item.allowed).map(item => item.row)
  const reasons = targets.length ? [] : [... new Set(assessed.flatMap(item => item.reasons).filter(Boolean))]
  return { targets, disabled: ! targets.length, reasons: rows.length ? reasons : ['请先选择附件'] }
}

/** Files and folder declarations share explicit batch states and eligibility. */
export function attachment_privacy_actions(rows: WorkspaceListRow[], capabilities: (row: WorkspaceListRow) => { private: boolean, reasons: { private: string[] } }) {
  const nodes = rows.filter(row => row.node)
  if (! nodes.length)
    return []
  const is_private = (row: WorkspaceListRow) => !! row.node?.attachment?.is_private || attachment_path_is_private(row.path)
  const states = rows.length === 1 ? [! is_private(rows[0]!)] : [true, false]
  return states.map(private_value => ({
    private: private_value,
    ... attachment_batch_action(nodes, (row) => {
      const cap = capabilities(row)
      if (! cap.private)
        return { allowed: false, reasons: cap.reasons.private }
      if (! private_value && attachment_inherits_private(row.path))
        return { allowed: false, reasons: ['机密状态由父目录继承，不能单独取消'] }
      if (is_private(row) === private_value)
        return { allowed: false, reasons: [private_value ? '已设为机密' : '无机密附件'] }
      return { allowed: true, reasons: [] }
    }),
  }))
}

/** Keep the action's icon, replacing a disabled label with its blocking reasons. */
export function attachment_action_item(item: AttachmentMenuItem, reasons: readonly string[]): AttachmentMenuItem {
  if (! item.disabled)
    return item
  const unique = [... new Set(reasons.filter(Boolean))]
  const first = unique[0] || '当前状态不可执行'
  const label = unique.length > 1 ? `${first} + ${unique.length - 1}` : first
  return { ... item, label, title: unique.join(' / ') || first, command: undefined }
}

export interface AttachmentListUpload {
  status: 'queued' | 'uploading' | 'paused' | 'error'
  progress: number
  file_size: number
  message: string | null
  label: string
}
/** Presentation adapter for the original Card/List; no legacy task protocol. */
export interface MyContentAttachmentRow {
  key: string
  depth: number
  source: WorkspaceListRow
  data: (ContentStoryAttachment & { kind: 'stored' })
    | { kind: 'upload', file_name: string, mime_type: string | null, file_size: number }
    | { kind: 'folder', path: string, name: string, collapsed: boolean, count: number, drop_target: boolean, drop_disabled: boolean }
  upload: AttachmentListUpload | null
  state: {
    selected: boolean
    selection_edges: 'top' | 'bottom' | 'none' | 'both'
    pending: boolean
    move_pending: boolean
    draggable: boolean
    error?: boolean
  }
}

/** Read-only summaries use the exact list row, without transfer or task state. */
export function attachment_summary_rows(paths: string[], nodes: readonly ContentWorkspaceNode[], prefer_private = false): MyContentAttachmentRow[] {
  return paths.map((path, index) => {
    const key = attachment_name_key(path)
    const private_source = nodes.find(node => node.attachment?.is_private && attachment_name_key(decrypted_attachment_name(node.path)) === key)
    const node = (prefer_private ? private_source : undefined) ?? nodes.find(node => attachment_name_key(node.path) === key) ?? private_source
    const file = node?.attachment
    const source: WorkspaceListRow = { key: `summary:${index}:${path}`, path, name: path, parent_id: node?.parent_id ?? 0, depth: 0, node }
    return {
      key: source.key, depth: 0, source, upload: null,
      data: node?.kind === 'folder'
        ? { kind: 'folder', path, name: path, collapsed: true, count: 0, drop_target: false, drop_disabled: false }
        : file
          ? { ... file, file_name: path, kind: 'stored' }
          : { kind: 'upload', file_name: path, mime_type: attachment_mime_type(attachment_base_name(path)), file_size: 0 },
      state: { selected: false, selection_edges: 'both', pending: false, move_pending: false, draggable: false },
    }
  })
}

/** Only the supplied targets and their ancestors belong in a resolve tree. */
export function attachment_summary_tree(paths: string[], nodes: readonly ContentWorkspaceNode[], options: {
  prefer_private?: boolean
  conflicts?: ReadonlySet<string>
  collapsed?: ReadonlySet<string>
} = {}): MyContentAttachmentRow[] {
  // Invalid separators are themselves a possible conflict. Keep such targets
  // visible at the root instead of inventing blank or relative folder nodes.
  const nestable = (path: string) => path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
  const entries = new Map<string, MyContentAttachmentRow>()
  for (const row of attachment_summary_rows(paths, nodes, options.prefer_private))
    entries.set(attachment_name_key(row.source.path), row)
  const folders = new Map<string, string>()
  for (const path of paths) {
    if (! nestable(path))
      continue
    for (const parent of attachment_ancestor_folders(path))
      folders.set(attachment_name_key(parent), parent)
  }
  for (const row of entries.values()) {
    if (row.data.kind === 'folder')
      folders.set(attachment_name_key(row.source.path), row.source.path)
  }
  for (const [key, path] of folders) {
    const row = entries.get(key) ?? attachment_summary_rows([path], nodes)[0]!
    entries.set(key, {
      ... row,
      data: { kind: 'folder', path, name: nestable(path) ? attachment_base_name(path) : path, collapsed: options.collapsed?.has(key) ?? false, count: 0, drop_target: false, drop_disabled: false },
      state: { ... row.state, error: options.conflicts?.has(key) ?? false },
    })
  }
  const children = new Map<string, MyContentAttachmentRow[]>()
  for (const [key, row] of entries) {
    row.key = `summary-tree:${key}`
    const parent = nestable(row.source.path) ? attachment_folder_of(row.source.path) : null
    const parent_key = parent ? attachment_name_key(parent) : ''
    const siblings = children.get(parent_key) ?? []
    siblings.push(row)
    children.set(parent_key, siblings)
  }
  const result: MyContentAttachmentRow[] = []
  function walk(parent: string, depth: number) {
    const siblings = children.get(parent) ?? []
    siblings.sort((a, b) => compare_attachment_items({ name: attachment_base_name(a.source.path), is_folder: a.data.kind === 'folder' }, { name: attachment_base_name(b.source.path), is_folder: b.data.kind === 'folder' }))
    for (const row of siblings) {
      result.push({ ... row, depth })
      if (row.data.kind === 'folder' && ! row.data.collapsed && nestable(row.source.path))
        walk(attachment_name_key(row.source.path), depth + 1)
    }
  }
  walk('', 0)
  return result
}

/** Keep upload-only selection separate; folders cover their descendants. */
export function normalize_attachment_selection(rows: WorkspaceListRow[], keys: ReadonlySet<string>) {
  const selected = rows.filter(row => keys.has(row.key))
  const stored = selected.some(row => row.node)
  const group = selected.filter(row => Boolean(row.node) === stored)
  return new Set(group.filter(row => ! group.some(parent => parent !== row && parent.node?.kind === 'folder' && (parent.path === '' || row.path.startsWith(`${parent.path}/`)))).map(row => row.key))
}

/** Reject a selection that would exceed the caller's limit, keeping its last valid state. */
export function guard_attachment_selection(selected: ReadonlySet<string>, next: Set<string>, limit = Number.POSITIVE_INFINITY) {
  return next.size > limit ? new Set(selected) : next
}

export function select_attachment_row(rows: WorkspaceListRow[], selected: ReadonlySet<string>, anchor: string | null, row: WorkspaceListRow, event: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>, limit = Number.POSITIVE_INFINITY) {
  const group = rows.filter(item => Boolean(item.node) === Boolean(row.node))
  const additive = event.ctrlKey || event.metaKey
  const next = additive ? new Set(group.filter(item => selected.has(item.key)).map(item => item.key)) : new Set<string>()
  const from = group.findIndex(item => item.key === anchor)
  const to = group.findIndex(item => item.key === row.key)
  if (event.shiftKey && from >= 0 && to >= 0) {
    for (const item of group.slice(Math.min(from, to), Math.max(from, to) + 1))
      next.add(item.key)
  }
  else if (next.has(row.key)) {
    next.delete(row.key)
  }
  else {
    // Explicitly selecting a child takes it out of an ancestor selection.
    for (const item of group) {
      if (item.node?.kind === 'folder' && (item.path === '' || row.path.startsWith(`${item.path}/`)))
        next.delete(item.key)
    }
    next.add(row.key)
  }
  return guard_attachment_selection(selected, normalize_attachment_selection(rows, next), limit)
}

export function attachment_selection_edges(rows: WorkspaceListRow[], index: number, selected: ReadonlySet<string>): MyContentAttachmentRow['state']['selection_edges'] {
  if (! selected.has(rows[index]!.key))
    return 'both'
  const before = index > 0 && selected.has(rows[index - 1]!.key)
  const after = index + 1 < rows.length && selected.has(rows[index + 1]!.key)
  return before ? after ? 'none' : 'bottom' : after ? 'top' : 'both'
}
