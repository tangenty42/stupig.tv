import type { ContentStoryAttachment, ContentWorkspaceNode } from '@shared/types/content'
import type { WorkspaceListRow } from './workspace-model'
import { attachment_ancestor_folders, attachment_base_name, attachment_folder_of, attachment_has_private_suffix, attachment_inherits_private, attachment_mime_type, attachment_name_without_private_suffix, attachment_path_is_private, attachment_redaction_path, compare_attachment_items } from '@shared/content-markdown'
import { attachment_name_key } from '@shared/content-workspace'

/** Path-based state for rows not yet stored: a file next to `X.good` is its public 删减版. */
export function attachment_upload_privacy(file_paths: readonly string[]) {
  const files = new Set(file_paths.map(attachment_name_key))
  return (path: string) => {
    const twin = `${path}.good`
    const is_redaction = attachment_redaction_path(twin) !== null && files.has(attachment_name_key(twin))
    return { is_private: ! is_redaction && attachment_path_is_private(path), is_redaction }
  }
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
  const declares_private = (row: WorkspaceListRow) => attachment_has_private_suffix(row.path)
    || (!! row.node?.attachment?.is_private && ! attachment_inherits_private(row.path))
  const states = rows.length === 1 ? [! declares_private(rows[0]!)] : [true, false]
  return states.map(private_value => ({
    private: private_value,
    ... attachment_batch_action(nodes, (row) => {
      const cap = capabilities(row)
      if (! cap.private)
        return { allowed: false, reasons: cap.reasons.private }
      if (declares_private(row) === private_value)
        return { allowed: false, reasons: [private_value ? '已有自身机密标记' : '没有自身机密标记'] }
      return { allowed: true, reasons: [] }
    }),
  }))
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
    | { kind: 'upload', file_name: string, mime_type: string | null, file_size: number, is_private?: boolean, is_redaction?: boolean }
    | { kind: 'folder', path: string, name: string, collapsed: boolean, count: number, drop_target: boolean, drop_disabled: boolean }
  upload: AttachmentListUpload | null
  state: {
    selected: boolean
    selection_edges: 'top' | 'bottom' | 'none' | 'both'
    pending: boolean
    move_pending: boolean
    draggable: boolean
    error?: boolean
    result_pending?: boolean
    unused_label?: string
  }
}

/** Read-only summaries use the exact list row, without transfer or task state. */
export function attachment_summary_rows(paths: string[], nodes: readonly ContentWorkspaceNode[], prefer_private = false, target_kinds?: ReadonlyMap<string, boolean>): MyContentAttachmentRow[] {
  const upload_privacy = attachment_upload_privacy([... nodes.filter(node => node.kind !== 'folder').map(node => node.path), ... paths])
  return paths.map((path, index) => {
    const key = attachment_name_key(path)
    const private_source = nodes.find(node => node.attachment?.is_private && attachment_name_key(attachment_name_without_private_suffix(node.path)) === key)
    const is_folder = target_kinds?.get(key)
    const match = (prefer_private ? private_source : undefined) ?? nodes.find(node => attachment_name_key(node.path) === key) ?? private_source
    const node = ! match || is_folder === undefined || (match.kind === 'folder') === is_folder ? match : undefined
    const file = node?.attachment
    const source: WorkspaceListRow = { key: `summary:${index}:${path}`, path, name: path, parent_id: node?.parent_id ?? 0, depth: 0, node }
    return {
      key: source.key, depth: 0, source, upload: null,
      data: is_folder || node?.kind === 'folder'
        ? { kind: 'folder', path, name: path, collapsed: true, count: 0, drop_target: false, drop_disabled: false }
        : file
          ? { ... file, file_name: path, kind: 'stored' }
          : { kind: 'upload', file_name: path, mime_type: attachment_mime_type(attachment_base_name(path)), file_size: 0, ... upload_privacy(path) },
      state: { selected: false, selection_edges: 'both', pending: false, move_pending: false, draggable: false },
    }
  })
}

/** Only the supplied targets and their ancestors belong in a resolve tree. */
export function attachment_summary_tree(paths: string[], nodes: readonly ContentWorkspaceNode[], options: {
  prefer_private?: boolean
  conflicts?: ReadonlySet<string>
  collapsed?: ReadonlySet<string>
  target_kinds?: ReadonlyMap<string, boolean>
} = {}): MyContentAttachmentRow[] {
  // Invalid separators are themselves a possible conflict. Keep such targets
  // visible at the root instead of inventing blank or relative folder nodes.
  const nestable = (path: string) => path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
  const entries = new Map<string, MyContentAttachmentRow>()
  for (const row of attachment_summary_rows(paths, nodes, options.prefer_private, options.target_kinds)) {
    const key = attachment_name_key(row.source.path)
    entries.set(key, { ... row, state: { ... row.state, error: options.conflicts?.has(key) ?? false } })
  }
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
