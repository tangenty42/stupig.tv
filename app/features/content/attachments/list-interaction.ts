import type { MenuItem } from 'primevue/menuitem'
import type { MyContentAttachmentRow } from '~/features/content/attachments/list-model'
import type { WorkspaceListRow } from '~/features/content/attachments/workspace-model'

export type AttachmentMenuItem = MenuItem & { icon_name?: string, spin?: boolean }

export function attachment_add_menu_items(actions: { upload: () => void, upload_folder: () => void, create_folder: () => void, upload_busy?: boolean, create_folder_disabled?: boolean }): AttachmentMenuItem[] {
  return [
    { label: '上传', icon_name: 'lucide:paperclip', disabled: actions.upload_busy, command: actions.upload },
    { label: '上传文件夹', icon_name: 'lucide:paperclip', disabled: actions.upload_busy, command: actions.upload_folder },
    { label: '新建文件夹', icon_name: 'lucide:folder-plus', disabled: actions.create_folder_disabled, command: actions.create_folder },
  ]
}

/** An existing selection owns its menu; an outside right-click targets only that row. */
export function attachment_menu_context(row: WorkspaceListRow, selected_rows: WorkspaceListRow[]) {
  const selected = selected_rows.some(item => item.key === row.key) ? selected_rows : [row]
  return { selected, single: selected.length === 1 }
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

/** Keep upload-only selection separate; folders cover their descendants. */
export function normalize_attachment_selection(rows: WorkspaceListRow[], keys: ReadonlySet<string>) {
  const selected = rows.filter(row => keys.has(row.key))
  const group_type = selected.some(row => row.node) ? 'node' : selected.some(row => row.session) ? 'session' : 'preparation'
  const group = selected.filter(row => (row.node ? 'node' : row.session ? 'session' : 'preparation') === group_type)
  return new Set(group.filter(row => ! group.some(parent => parent !== row && parent.node?.kind === 'folder' && (parent.path === '' || row.path.startsWith(`${parent.path}/`)))).map(row => row.key))
}

/** Reject a selection that would exceed the caller's limit, keeping its last valid state. */
export function guard_attachment_selection(selected: ReadonlySet<string>, next: Set<string>, limit = Number.POSITIVE_INFINITY) {
  return next.size > limit ? new Set(selected) : next
}

export function select_attachment_row(rows: WorkspaceListRow[], selected: ReadonlySet<string>, anchor: string | null, row: WorkspaceListRow, event: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>, limit = Number.POSITIVE_INFINITY) {
  const additive = event.ctrlKey || event.metaKey
  if (limit === 1) {
    const deselected = additive && ! event.shiftKey && selected.has(row.key)
    return new Set(! deselected && rows.some(item => item.key === row.key) ? [row.key] : [])
  }
  const kind = (item: WorkspaceListRow) => item.node ? 'node' : item.preparation || item.pending_folder ? 'preparation' : 'session'
  const group = rows.filter(item => kind(item) === kind(row))
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
