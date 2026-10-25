import type { ContentWorkspaceNode } from '@shared/types/content'
import type { MyContentAttachmentRow } from './attachment-list'
import type { WorkspaceListRow } from './workspace'
import { project_workspace_rows } from './workspace'

export function move_destination_folders(nodes: ContentWorkspaceNode[], excluded_ids: readonly number[]) {
  const excluded = nodes.filter(node => node.kind === 'folder' && excluded_ids.includes(node.id))
  return nodes.filter(node => node.kind === 'folder' && ! excluded.some(parent => node.id === parent.id || node.path.startsWith(`${parent.path}/`)))
}

/** Reuse the normal attachment rows while keeping picker selection independent. */
export function folder_picker_rows(folders: ContentWorkspaceNode[], root_id: number, expanded: ReadonlySet<number>, selected: ReadonlySet<string>): MyContentAttachmentRow[] {
  const root: ContentWorkspaceNode = { id: root_id, parent_id: 0, name: '根目录', path: '', kind: 'folder', version: '' }
  const source: WorkspaceListRow[] = [{ key: `node:${root_id}`, parent_id: 0, name: root.name, path: '', depth: 0, node: root }]
  if (expanded.has(root_id))
    source.push(... project_workspace_rows(folders.filter(node => node.kind === 'folder'), [], root_id, expanded).map(row => ({ ... row, depth: row.depth + 1 })))
  return source.map(row => ({
    key: row.key,
    depth: row.depth,
    source: row,
    data: { kind: 'folder', path: row.path, name: row.name, collapsed: ! expanded.has(row.node!.id), count: folders.filter(node => node.kind === 'folder' && node.parent_id === row.node!.id).length, drop_target: false, drop_disabled: false },
    upload: null,
    state: { selected: selected.has(row.key), selection_edges: 'both', pending: false, move_pending: false, draggable: false },
  }))
}
