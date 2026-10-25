import type { ContentWorkspaceNode } from '@shared/types/content'
import { describe, expect, it } from 'vitest'
import { folder_picker_rows, move_destination_folders } from './folder-picker'

const nodes: ContentWorkspaceNode[] = [
  { id: 2, parent_id: 1, name: '资料', path: '资料', kind: 'folder', version: 'v1' },
  { id: 3, parent_id: 2, name: '子目录', path: '资料/子目录', kind: 'folder', version: 'v2' },
  { id: 4, parent_id: 2, name: '说明.txt', path: '资料/说明.txt', kind: 'file', version: 'v1' },
  { id: 5, parent_id: 1, name: '资料备份', path: '资料备份', kind: 'folder', version: 'v1' },
]

describe('folder destination picker', () => {
  it('omits files and the moved folders including their descendants, keeping similarly named siblings', () => {
    expect(move_destination_folders(nodes, [2]).map(node => node.id)).toEqual([5])
    expect(move_destination_folders(nodes, [4]).map(node => node.id)).toEqual([2, 3, 5])
    expect(move_destination_folders(nodes, [3, 5]).map(node => node.id)).toEqual([2])
  })

  it('shows the root and only expanded folders using normal list row shapes', () => {
    const rows = folder_picker_rows(nodes, 1, new Set([1, 2]), new Set(['node:3']))
    expect(rows.map(row => [row.source.node!.id, row.depth, row.data.kind])).toEqual([[1, 0, 'folder'], [2, 1, 'folder'], [3, 2, 'folder'], [5, 1, 'folder']])
    expect(rows.filter(row => row.state.selected).map(row => row.source.node!.id)).toEqual([3])
    expect(rows.every(row => ! row.state.draggable && row.upload === null)).toBe(true)
    expect(rows.find(row => row.source.node!.id === 2)?.data).toMatchObject({ count: 1, collapsed: false })
  })

  it('keeps root selection available when empty and hides descendants when collapsed', () => {
    const empty = folder_picker_rows([], 1, new Set([1]), new Set(['node:1']))
    expect(empty).toHaveLength(1)
    expect(empty[0]).toMatchObject({ data: { name: '根目录', count: 0 }, state: { selected: true } })
    expect(folder_picker_rows(nodes, 1, new Set(), new Set()).map(row => row.source.node!.id)).toEqual([1])
    expect(folder_picker_rows(nodes, 1, new Set([1]), new Set(['node:2'])).map(row => row.source.node!.id)).toEqual([1, 2, 5])
  })
})
