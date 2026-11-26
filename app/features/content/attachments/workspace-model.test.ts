import type { ContentWorkspaceNode } from '@shared/types/content'
import type { ContentUploadReservation, ContentUploadSession } from '@shared/types/content-upload'
import type { UploadPreparation } from '../uploads/admission'
import type { WorkspaceListRow } from './workspace-model'
import { find_delete_references } from '@shared/content-delete-impact'
import { expect, it } from 'vitest'
import { project_workspace_commands, project_workspace_rows, workspace_capabilities, workspace_command_footprint } from './workspace-model'

it('projects local preparations without granting stored-file actions and hands off by actual session identity', () => {
  const preparation: UploadPreparation = { id: 'local', path: 'docs/large.bin', size: 9000, loaded: 100, phase: 'admitting' }
  const before = project_workspace_rows([], [], 1, new Set(), [preparation])
  expect(before.map(row => row.key)).toEqual(['pending-folder:docs', 'preparing:local'])
  expect(before[0]).toMatchObject({ pending_folder: true, name: 'docs', depth: 0 })
  expect(before[0]!.node).toBeUndefined()
  expect(before[1]).toMatchObject({ key: 'preparing:local', path: preparation.path, preparation, depth: 1 })
  expect(before[1]!.parent_id).toBeLessThan(0)
  expect(workspace_capabilities(before[1]!, { readonly: false, can_private: true, pending: false })).toMatchObject({ open: false, move: false, delete: false })
  const session = { id: 'actual-session', path: preparation.path, parent_id: 50, size: preparation.size, status: 'queued' } as ContentUploadSession
  const after = project_workspace_rows([], [session], 1, new Set(), [{ ... preparation, session_id: session.id, phase: 'admitting' }])
  expect(after.map(row => row.key)).toEqual(['pending-folder:docs', 'session:actual-session'])
  expect(after[1]).toMatchObject({ key: 'session:actual-session', session, depth: 1 })
  expect(after[1]?.preparation).toBeUndefined()
})

it('synthesizes each missing directory level once and nests pending rows even while collapsed', () => {
  const preparation_a: UploadPreparation = { id: 'one', path: 'docs/sub/new.bin', size: 1, loaded: 0, phase: 'waiting' }
  const preparation_b: UploadPreparation = { id: 'two', path: 'docs/sub/other.bin', size: 1, loaded: 0, phase: 'waiting' }
  const rows = project_workspace_rows([], [], 1, new Set(), [preparation_a, preparation_b])
  expect(rows.map(row => [row.key, row.depth])).toEqual([['pending-folder:docs', 0], ['pending-folder:docs/sub', 1], ['preparing:one', 2], ['preparing:two', 2]])
  expect(rows.filter(row => row.pending_folder)).toHaveLength(2)
})

it('nests an admitted session through synthesized folders when its parent folder is not in the catalog yet', () => {
  const docs: ContentWorkspaceNode = { id: 2, parent_id: 1, name: 'docs', path: 'docs', kind: 'folder', version: 'v' }
  const session = { id: 'accepted', path: 'docs/fresh/later.bin', parent_id: 77, status: 'uploading' } as ContentUploadSession
  const rows = project_workspace_rows([docs], [session], 1, new Set([2]))
  expect(rows.map(row => [row.key, row.depth])).toEqual([['node:2', 0], ['pending-folder:docs/fresh', 1], ['session:accepted', 2]])
  expect(rows[2]).toMatchObject({ name: 'later.bin', session })
})

it('places a local preparation inside its existing target folder without exposing the full path as its name', () => {
  const folder: ContentWorkspaceNode = { id: 2, parent_id: 1, name: 'docs', path: 'docs', kind: 'folder', version: 'v' }
  const preparation: UploadPreparation = { id: 'local', path: 'docs/large.bin', size: 9000, loaded: 0, phase: 'waiting' }
  const rows = project_workspace_rows([folder], [], 1, new Set([2]), [preparation])
  expect(rows.map(row => row.key)).toEqual(['node:2', 'preparing:local'])
  expect(rows[1]).toMatchObject({ parent_id: 2, name: 'large.bin', path: 'docs/large.bin', depth: 1 })
  expect(project_workspace_rows([folder], [], 1, new Set(), [preparation]).map(row => row.key)).toEqual(['node:2'])
})

it('projects requested rename and move destinations, including folder descendants', () => {
  const nodes: ContentWorkspaceNode[] = [
    { id: 2, parent_id: 1, name: 'docs', path: 'docs', kind: 'folder', version: 'v1' },
    { id: 3, parent_id: 2, name: 'old.txt.good', path: 'docs/old.txt.good', kind: 'file', version: 'v1', attachment: { file_name: 'old.txt.good' } as ContentWorkspaceNode['attachment'] },
    { id: 4, parent_id: 1, name: 'other', path: 'other', kind: 'folder', version: 'v1' },
  ]
  const renamed = project_workspace_commands(nodes, [{ operation: 'rename', target: { id: 3, version: 'v1' }, name: 'new.txt' }])
  expect(renamed[1]).toMatchObject({ name: 'new.txt.good', path: 'docs/new.txt.good', attachment: { file_name: 'new.txt.good' } })
  const moved = project_workspace_commands(nodes, [{ operation: 'move', targets: [{ id: 2, version: 'v1' }], parent_id: 4 }])
  expect(moved.slice(0, 2).map(row => row.path)).toEqual(['other/docs', 'other/docs/old.txt.good'])
  expect(moved[1]).toMatchObject({ parent_id: 2, name: 'old.txt.good' })
})

it('keeps a folder merge in place until the receipt replaces the tree', () => {
  const nodes: ContentWorkspaceNode[] = [
    { id: 2, parent_id: 1, name: 'docs', path: 'docs', kind: 'folder', version: 'v1' },
    { id: 3, parent_id: 1, name: 'other', path: 'other', kind: 'folder', version: 'v1' },
    { id: 4, parent_id: 2, name: 'other', path: 'docs/other', kind: 'folder', version: 'v1' },
  ]
  const renamed = project_workspace_commands(nodes, [{ operation: 'rename', target: { id: 3, version: 'v1' }, name: 'Docs' }])
  expect(renamed.map(node => node.path)).toEqual(['docs', 'other', 'docs/other'])
  const moved = project_workspace_commands(nodes, [{ operation: 'move', targets: [{ id: 3, version: 'v1' }], parent_id: 2 }])
  expect(moved.map(node => node.path)).toEqual(['docs', 'other', 'docs/other'])
})

it.each(['replace', 'redact'] as const)('shows only the new %s preparation and restores its source when preparation is cancelled', (purpose) => {
  const nodes: ContentWorkspaceNode[] = [{ id: 2, parent_id: 1, name: 'docs', path: 'docs', kind: 'folder', version: 'v1' }, { id: 3, parent_id: 2, name: 'a.txt', path: 'docs/a.txt', kind: 'file', version: 'v1' }]
  const preparation: UploadPreparation = { id: 'replacement', path: 'docs/new.txt', size: 10, loaded: 0, phase: 'waiting', purpose, source_id: 3 }
  const rows = project_workspace_rows(nodes, [], 1, new Set([2]), [preparation])
  expect(rows.map(row => row.key)).toEqual(['node:2', 'preparing:replacement'])
  expect(rows[1]).toMatchObject({ parent_id: 2, name: 'new.txt', depth: 1 })
  expect(project_workspace_rows(nodes, [], 1, new Set([2]), []).map(row => row.key)).toEqual(['node:2', 'node:3'])
})

it.each([true, false])('protects both subtrees when folder privacy changes to %s', (private_value) => {
  const name = private_value ? 'docs' : 'docs.good'
  const node: ContentWorkspaceNode = { id: 2, parent_id: 1, name, path: name, kind: 'folder', version: 'v' }
  const footprint = workspace_command_footprint({ operation: 'set_private', targets: [{ id: 2, version: 'v' }], private: private_value }, [node])
  expect(footprint.paths).toEqual([{ path: name, subtree: true }, { path: private_value ? 'docs.good' : 'docs', subtree: true }])
})

it('allows folder privacy through the normal capability and blocks descendant upload reservations', () => {
  const node: ContentWorkspaceNode = { id: 2, parent_id: 1, name: 'docs', path: 'docs', kind: 'folder', version: 'v' }
  const row = { key: 'folder', name: node.name, path: node.path, parent_id: 1, depth: 0, node }
  const options = { readonly: false, can_private: true, pending: false }
  expect(workspace_capabilities(row, options)).toMatchObject({ private: true, reasons: { private: [] } })
  expect(workspace_capabilities(row, { ... options, can_private: false })).toMatchObject({ private: false, reasons: { private: ['没有机密附件权限'] } })
  const reservation: ContentUploadReservation = { id: 'child-upload', parent_id: 2, path: 'docs/new.txt' }
  const cap = workspace_capabilities(row, { ... options, reservations: [reservation] })
  expect(cap).toMatchObject({ private: false, rename: true, move: true })
  expect(cap.reasons.private).toEqual(['目录内有上传预约'])
})

it('keeps an inherited private file rename at its actual path without adding an independent marker', () => {
  const nodes: ContentWorkspaceNode[] = [
    { id: 2, parent_id: 1, name: 'docs.good', path: 'docs.good', kind: 'folder', version: 'v' },
    { id: 3, parent_id: 2, name: 'photo.png', path: 'docs.good/photo.png', kind: 'file', version: 'v', attachment: { is_private: true } as ContentWorkspaceNode['attachment'] },
  ]
  const footprint = workspace_command_footprint({ operation: 'rename', target: { id: 3, version: 'v' }, name: 'new.png' }, nodes)
  expect(footprint.paths).toEqual([{ path: 'docs.good/photo.png', subtree: false }, { path: 'docs.good/new.png', subtree: false }])
  const folder = nodes[0]!
  expect(workspace_capabilities({ key: 'folder', path: folder.path, name: folder.name, parent_id: 1, depth: 0, node: folder }, { readonly: false, can_private: false, pending: false })).toMatchObject({ rename: false, move: false, delete: false })
})

it('limits upload reservation fences to source files, target names and deletion of containing folders', () => {
  const nodes: ContentWorkspaceNode[] = [
    { id: 2, parent_id: 1, name: 'Docs', path: 'Docs', kind: 'folder', version: 'v' },
    { id: 3, parent_id: 2, name: 'original.png.good', path: 'Docs/original.png.good', kind: 'file', version: 'v' },
    { id: 4, parent_id: 2, name: 'other.txt', path: 'Docs/other.txt', kind: 'file', version: 'v' },
    { id: 5, parent_id: 1, name: 'Other', path: 'Other', kind: 'folder', version: 'v' },
  ]
  const reservations: ContentUploadReservation[] = [{ id: 'foreign-upload', parent_id: 2, path: 'Docs/NEW.png', source_id: 3 }]
  const cap = (id: number) => {
    const node = nodes.find(node => node.id === id)!
    return workspace_capabilities({ key: `node:${id}`, name: node.name, path: node.path, node, parent_id: node.parent_id, depth: 0 }, { readonly: false, can_private: true, pending: false, nodes, reservations })
  }
  expect(cap(3)).toMatchObject({ rename: false, move: false, delete: false, replace: false })
  expect(cap(2)).toMatchObject({ rename: true, move: true, delete: false })
  expect(cap(4)).toMatchObject({ rename: true, move: true, delete: true, replace: true })
  expect(cap(5)).toMatchObject({ rename: true, move: true, delete: true })
  // Target comparisons use the same NFC/case folding as server name occupancy.
  nodes[1] = { ... nodes[1]!, id: 6, name: 'new.png', path: 'Docs/new.png' }
  expect(cap(6)).toMatchObject({ rename: false, move: false, delete: false })
})

it.each(['replace', 'redact'] as const)('replaces the stored row with a %s task and restores the untouched node on cancellation', (purpose) => {
  const nodes: ContentWorkspaceNode[] = [{ id: 2, parent_id: 1, name: 'docs', path: 'docs', kind: 'folder', version: 'v1' }, { id: 3, parent_id: 2, name: 'a.txt', path: 'docs/a.txt', kind: 'file', version: 'v1' }]
  const sessions = [{ id: 'replace', parent_id: 2, source_id: 3, purpose, path: 'docs/new.txt' }, { id: 'new', parent_id: 2, purpose: 'create', path: 'docs/b.txt' }] as ContentUploadSession[]
  const result = project_workspace_rows(nodes, sessions, 1, new Set([2]))
  expect(result.map(row => [row.key, row.depth, row.session?.id])).toEqual([['node:2', 0, undefined], ['session:new', 1, 'new'], ['session:replace', 1, 'replace']])
  expect(result.find(row => row.session?.id === 'replace')).toMatchObject({ path: 'docs/new.txt', name: 'new.txt' })
  expect(result.find(row => row.session?.id === 'replace')?.node).toBeUndefined()
  expect(nodes[1]?.path).toBe('docs/a.txt')
  expect(project_workspace_rows(nodes, [], 1, new Set([2]))[1]).toMatchObject({ key: 'node:3', node: nodes[1] })
  expect(project_workspace_rows(nodes, sessions, 1, new Set()).map(row => row.key)).toEqual(['node:2'])
})

it('merges a published create into its exclusively reserved target while completion is still in flight', () => {
  const file = { id: 3, parent_id: 1, name: 'new.txt', path: 'new.txt', kind: 'file', version: 'v2' } as ContentWorkspaceNode
  const session = { id: 'upload', purpose: 'create', path: 'NEW.txt', parent_id: 1 } as ContentUploadSession
  const rows = project_workspace_rows([file], [session], 1, new Set())
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ key: 'session:upload', path: session.path, session })
  expect(rows[0]?.node).toBeUndefined()
  // Folders never match file publication targets.
  expect(project_workspace_rows([{ ... file, kind: 'folder' }], [session], 1, new Set())).toHaveLength(2)
})

it('uses the same capability projection for menu, selection and drag fences', () => {
  const row = { key: 'node:3', parent_id: 1, depth: 0, name: 'a.txt', path: 'a.txt', node: { id: 3, parent_id: 1, name: 'a.txt', path: 'a.txt', kind: 'file' as const, version: 'v1' } }
  expect(workspace_capabilities(row, { readonly: false, can_private: true, pending: false })).toMatchObject({ delete: true, rename: true, replace: true })
  expect(workspace_capabilities({ ... row, session: { id: 'pending' } as ContentUploadSession }, { readonly: false, can_private: true, pending: false })).toMatchObject({ delete: false, rename: false, replace: false })
})

it('opens the public variant without granting any private owner mutation', () => {
  const attachment = { id: 3, file_name: 'photo.png.good', mime_type: 'image/webp', file_size: 10, version: 'v1',
    url: null, is_image: true, is_private: true, has_redacted: true, is_redacted_view: true, redacted_url: '/read?role=redacted' }
  const row = { key: 'node:3', parent_id: 1, depth: 0, name: attachment.file_name, path: attachment.file_name,
    node: { id: 3, parent_id: 1, name: attachment.file_name, path: attachment.file_name, kind: 'file' as const, version: 'v1', attachment } }
  const options = { readonly: false, can_private: false, pending: false }
  const cap = workspace_capabilities(row, options)
  expect(cap).toMatchObject({ open: true, preview: false, preview_redacted: true, rename: false, replace: false, delete: false, image_edit: false, private: false })
  expect(cap.reasons.open).toEqual([])
  expect(workspace_capabilities({ ... row, node: { ... row.node, attachment: { ... attachment, redacted_url: null } } }, options).open).toBe(false)
})

it('allows deleting referenced targets and reports independent redaction restrictions', () => {
  const row = { key: 'node:3', parent_id: 1, depth: 0, name: 'a.txt', path: 'a.txt', node: { id: 3, parent_id: 1, name: 'a.txt', path: 'a.txt', kind: 'file' as const, version: 'v1' } }
  expect(find_delete_references('[](att://a.txt)', [{ path: row.path, kind: 'file' }])).toHaveLength(1)
  const result = workspace_capabilities(row, { readonly: false, can_private: true, pending: false })
  expect(result.reasons.delete).toEqual([])
  expect(result.reasons.rename).toEqual([])
  expect(result.reasons.replace).toEqual([])
  expect(result.reasons.redact).toEqual(['仅支持机密附件', '格式不支持'])
  expect(result.reasons.open).toEqual(['附件暂不可读取'])
})

it('reports permission, pending and unfinished session reasons without changing capability rules', () => {
  const file = { file_name: 'a.png.good', mime_type: 'image/png', file_size: 1, is_image: true, version: 'v1', url: null, is_private: true }
  const row = { key: 'node:3', parent_id: 1, depth: 0, name: file.file_name, path: file.file_name, node: { id: 3, parent_id: 1, name: file.file_name, path: file.file_name, kind: 'file' as const, version: 'v1', attachment: file }, session: { id: 'pending' } as ContentUploadSession }
  const result = workspace_capabilities(row, { readonly: false, can_private: false, pending: true })
  expect(result).toMatchObject({ open: false, rename: false, replace: false, private: false, redact: false })
  expect(result.reasons.rename).toEqual(['正在提交操作', '没有机密附件权限', '上传会话尚未结束'])
  expect(result.reasons.open).toEqual(['没有机密附件权限'])
  expect(result.reasons.redact).not.toContain('格式不支持')
})

it.each([true, false])('reports only the root read restriction when private permission is %s', (can_private) => {
  const attachment = { file_name: 'photo.png.good', mime_type: 'image/webp', file_size: 1, version: 'v1',
    url: null, is_image: true, is_private: true }
  const row: WorkspaceListRow = { key: 'node:3', parent_id: 1, depth: 0, name: attachment.file_name, path: attachment.file_name,
    node: { id: 3, parent_id: 1, name: attachment.file_name, path: attachment.file_name, kind: 'file', version: 'v1', attachment } }
  const cap = workspace_capabilities(row, { readonly: true, can_private, pending: false })
  const reasons = [can_private ? '附件暂不可读取' : '没有机密附件权限']
  expect(cap.open).toBe(false)
  expect(cap.preview).toBe(false)
  expect(cap.reasons.open).toEqual(reasons)
  expect(cap.reasons.preview).toEqual(reasons)
})

it.each(['image/gif', 'image/svg+xml', 'image/tiff', 'image/x-other'])('keeps original %s previewable but gives an accurate disabled editor reason', (mime) => {
  const attachment = { id: 3, file_name: 'kept-name.jpg.good', mime_type: mime, file_size: 10, version: 'v1', url: '/read', is_image: true, is_private: true }
  const row = { key: 'node:3', parent_id: 1, depth: 0, name: attachment.file_name, path: attachment.file_name,
    node: { id: 3, parent_id: 1, name: attachment.file_name, path: attachment.file_name, kind: 'file' as const, version: 'v1', attachment } }
  const result = workspace_capabilities(row, { readonly: false, can_private: true, pending: false })
  expect(result).toMatchObject({ open: true, replace: true, image_edit: false, redact: false })
  expect(result.reasons.image_edit).toEqual(['此图片格式不支持编辑'])
})
