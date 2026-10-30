import type { WorkspaceRow } from './workspace.repository'
import { describe, expect, it, vi } from 'vitest'
import { node_version, workspace_node_versions } from './workspace.repository'

vi.mock('@server/lib/db', () => ({ db: {} }))

function row(id: number, path: string, folder = false): WorkspaceRow {
  return { id, file_name: path, parent_id: id === 1 ? 0 : 1, name: path.split('/').at(- 1) ?? '', is_folder: Number(folder), node_revision: 1, object_key: null, version: 'v1', is_private: 0 } as WorkspaceRow
}

describe('workspace snapshot versions', () => {
  it('retains the original folder/file hash contract and row ordering', () => {
    const rows = [row(1, '', true), row(2, 'folder', true), row(3, 'folder/nested', true), row(4, 'folder/nested/file'), row(5, 'other')]
    const versions = workspace_node_versions(rows)
    for (const node of rows) expect(versions.get(node.id)).toBe(node_version(rows, node))
    rows[3]!.node_revision ++
    const changed = workspace_node_versions(rows)
    expect(changed.get(1)).not.toBe(versions.get(1))
    expect(changed.get(2)).not.toBe(versions.get(2))
    expect(changed.get(5)).toBe(versions.get(5))
  })
  it('constructs a ten-thousand-file snapshot without repeatedly scanning every file', () => {
    const rows = [row(1, '', true), ... Array.from({ length: 10000 }, (_, index) => row(index + 2, `file${index}`))]
    const versions = workspace_node_versions(rows)
    expect(versions.size).toBe(10001)
    expect(versions.get(500)).toBe(node_version(rows, rows[499]!))
    expect(versions.get(1)).toBe(node_version(rows, rows[0]!))
  })
})
