import type { ContentUploadSession } from '@shared/types/content-upload'
import type { WorkspaceListRow } from '~/features/content/attachments/workspace-model'
import { expect, it } from 'vitest'
import { attachment_privacy_actions, attachment_summary_rows, attachment_summary_tree } from '~/features/content/attachments/list-model'
import { workspace_capabilities } from '~/features/content/attachments/workspace-model'
import { attachment_action_item, attachment_selection_edges, guard_attachment_selection, normalize_attachment_selection, select_attachment_row } from './list-interaction'

const rows: WorkspaceListRow[] = [
  { key: 'folder', path: 'docs', name: 'docs', parent_id: 1, depth: 0, node: { id: 2, parent_id: 1, name: 'docs', path: 'docs', kind: 'folder', version: 'v' } },
  ... ['docs/a.txt', 'b.txt', 'c.txt'].map((path, index) => ({ key: path, path, name: path, parent_id: index ? 1 : 2, depth: index ? 0 : 1, node: { id: index + 3, parent_id: index ? 1 : 2, name: path, path, kind: 'file' as const, version: 'v' } })),
  { key: 'upload', path: 'pending.txt', name: 'pending.txt', parent_id: 1, depth: 0 },
]
const plain = { ctrlKey: false, metaKey: false, shiftKey: false }

it('does not mix local preparations with server upload selections', () => {
  const preparation: WorkspaceListRow = { key: 'preparing:local', parent_id: 1, name: 'large.bin', path: 'large.bin', depth: 0,
    preparation: { id: 'local', path: 'large.bin', size: 9000, loaded: 0, phase: 'admitting' } }
  const upload: WorkspaceListRow = { key: 'session:actual', parent_id: 1, name: 'other.bin', path: 'other.bin', depth: 0, session: { id: 'actual' } as ContentUploadSession }
  const selected = select_attachment_row([preparation, upload], new Set([upload.key]), upload.key, preparation, { ... plain, ctrlKey: true })
  expect([... selected]).toEqual([preparation.key])
  expect([... normalize_attachment_selection([preparation, upload], new Set([preparation.key, upload.key]))]).toEqual([upload.key])
})

it('builds only the requested hierarchy with shared folders and natural file-list ordering', () => {
  const tree = attachment_summary_tree(['a/c10.png', 'a/c2.png', 'a/sub/d.png', 'root.txt'], rows.flatMap(row => row.node ? [row.node] : []))
  expect(tree.map(row => [row.source.path, row.depth, row.data.kind])).toEqual([
    ['a', 0, 'folder'], ['a/sub', 1, 'folder'], ['a/sub/d.png', 2, 'upload'],
    ['a/c2.png', 1, 'upload'], ['a/c10.png', 1, 'upload'], ['root.txt', 0, 'upload'],
  ])
  expect(tree.some(row => row.source.path === 'docs')).toBe(false)
  expect(tree.filter(row => row.data.kind === 'folder').every(row => row.state.error === false)).toBe(true)
})

it('deduplicates ancestor casing and distinguishes folder targets from supporting parents', () => {
  const tree = attachment_summary_tree(['A/b.png', 'a/c.png', 'a/sub', 'a/sub/d.png'], [], { conflicts: new Set(['a/sub']) })
  expect(tree.filter(row => row.source.path.toLowerCase() === 'a')).toHaveLength(1)
  const parent = tree.find(row => row.source.path.toLowerCase() === 'a')!
  const conflict = tree.find(row => row.source.path === 'a/sub')!
  expect(parent.state.error).toBe(false)
  expect(conflict.state.error).toBe(true)
  expect(conflict.data).toMatchObject({ kind: 'folder', name: 'sub', collapsed: false })
  const folded = attachment_summary_tree(['a/b.png', 'a/sub/d.png', 'root.txt'], [], { collapsed: new Set(['a']) })
  expect(folded.map(row => row.source.path)).toEqual(['a', 'root.txt'])
})

it('keeps explicit empty folders and malformed paths visible instead of losing them in an invented tree', () => {
  const folder = { ... rows[0]!.node!, path: 'empty', name: 'empty' }
  const invalid = ['a//b.png', '/leading.png', 'a/../c.png']
  const tree = attachment_summary_tree(['empty', ... invalid], [folder], { conflicts: new Set(['empty']) })
  expect(tree.find(row => row.source.path === 'empty')).toMatchObject({ depth: 0, data: { kind: 'folder' }, state: { error: true } })
  for (const path of invalid)
    expect(tree.find(row => row.source.path === path)).toMatchObject({ depth: 0, data: { file_name: path } })
  expect(tree).toHaveLength(4)
})

it('projects conflict summaries onto the real list without inventing upload state or losing private metadata', () => {
  const private_file = { file_name: 'docs/photo.png.good', mime_type: 'image/png', file_size: 32, version: 'v1', is_image: true, is_private: true, has_redacted: true, url: null }
  const node = { id: 10, parent_id: 2, name: 'photo.png.good', path: private_file.file_name, kind: 'file' as const, version: 'v1', attachment: private_file }
  const [folder, secret, unknown, duplicate] = attachment_summary_rows(['docs', 'docs/photo.png', 'next.svg', 'next.svg'], [rows[0]!.node!, node])
  expect(folder!.data).toMatchObject({ kind: 'folder', name: 'docs' })
  expect(secret!.data).toMatchObject({ kind: 'stored', file_name: 'docs/photo.png', is_private: true, has_redacted: true })
  expect(secret!.source.node).toBe(node)
  const public_node = { ... node, id: 11, path: 'docs/photo.png', attachment: { ... private_file, file_name: 'docs/photo.png', is_private: false, has_redacted: false } }
  expect(attachment_summary_rows(['docs/photo.png'], [public_node, node])[0]!.source.node).toBe(public_node)
  expect(attachment_summary_rows(['docs/photo.png'], [public_node, node], true)[0]!.source.node).toBe(node)
  expect(unknown!.data).toMatchObject({ file_name: 'next.svg', mime_type: 'image/svg+xml' })
  expect(duplicate!.key).not.toBe(unknown!.key)
  for (const row of [folder!, secret!, unknown!]) {
    expect(row.upload).toBeNull()
    expect(row.state).toEqual({ selected: false, selection_edges: 'both', pending: false, move_pending: false, draggable: false })
  }
})

it('plans shared file/folder privacy states and excludes unchanged or denied targets', () => {
  const public_file = rows[2]!
  const private_file = { ... rows[3]!, node: { ... rows[3]!.node!, attachment: { is_private: true } } } as WorkspaceListRow
  const allowed = () => ({ private: true, reasons: { private: [] } })
  const actions = attachment_privacy_actions([public_file, private_file], allowed)
  expect(actions).toEqual([
    { private: true, targets: [public_file], disabled: false, reasons: [] },
    { private: false, targets: [private_file], disabled: false, reasons: [] },
  ])
  expect(attachment_privacy_actions([private_file], allowed)).toEqual([actions[1]])
  expect(attachment_privacy_actions([public_file, rows[3]!], allowed)[1]).toMatchObject({ disabled: true, targets: [], reasons: ['无机密附件'] })
  expect(attachment_privacy_actions([public_file, rows[0]!], allowed)[0]).toEqual({ private: true, targets: [public_file, rows[0]!], disabled: false, reasons: [] })
  expect(attachment_privacy_actions([public_file, private_file], () => ({ private: false, reasons: { private: ['没有机密附件权限'] } })).every(action => action.disabled && action.reasons.includes('没有机密附件权限'))).toBe(true)
})

it('keeps inherited privacy immutable at the leaf while allowing independent files in the same batch', () => {
  const inherited = { ... rows[3]!, path: 'folder.good/sub/b.txt', node: { ... rows[3]!.node!, attachment: { is_private: true } } } as WorkspaceListRow
  const standalone = { ... rows[3]!, key: 'own', path: 'b.txt.good', node: { ... rows[3]!.node!, attachment: { is_private: true } } } as WorkspaceListRow
  const capabilities = () => ({ private: true, reasons: { private: [] } })
  expect(attachment_privacy_actions([inherited], capabilities)).toEqual([{ private: false, disabled: true, targets: [], reasons: ['机密状态由父目录继承，不能单独取消'] }])
  expect(attachment_privacy_actions([inherited, standalone], capabilities)[1]).toEqual({ private: false, disabled: false, targets: [standalone], reasons: [] })
})

it('reports only applicable, unique reasons when no privacy target is eligible', () => {
  const capabilities = (row: WorkspaceListRow) => workspace_capabilities(row, { readonly: false, can_private: true, pending: false })
  expect(attachment_privacy_actions([rows[0]!], capabilities)).toEqual([{ private: true, targets: [rows[0]!], disabled: false, reasons: [] }])
  const private_folder = { ... rows[0]!, path: 'docs.good', name: 'docs.good' }
  expect(attachment_privacy_actions([private_folder], capabilities)).toEqual([{ private: false, targets: [private_folder], disabled: false, reasons: [] }])
  const inherited_folder = { ... rows[0]!, path: 'docs.good/sub', name: 'sub' }
  expect(attachment_privacy_actions([inherited_folder], capabilities)).toEqual([{ private: false, targets: [], disabled: true, reasons: ['机密状态由父目录继承，不能单独取消'] }])
  const busy = { ... rows[2]!, session: { id: 'pending' } } as WorkspaceListRow
  expect(attachment_privacy_actions([rows[0]!, busy], capabilities)[0]).toMatchObject({ disabled: false, targets: [rows[0]!], reasons: [] })
  const busy_folder = { ... rows[0]!, session: { id: 'pending' } } as WorkspaceListRow
  expect(attachment_privacy_actions([busy_folder, busy], capabilities)[0]).toMatchObject({ disabled: true, targets: [], reasons: ['上传会话尚未结束'] })
  expect(attachment_privacy_actions([rows[0]!, rows[2]!], capabilities)[1]).toMatchObject({ disabled: true, targets: [], reasons: ['无机密附件'] })
  expect(attachment_privacy_actions([busy_folder, busy, rows[3]!], capabilities)[0]).toMatchObject({ disabled: false, targets: [rows[3]!], reasons: [] })
})

it('shows deduplicated blocking reasons on disabled actions while preserving their icon and enabled labels', () => {
  const item = { label: '删除', icon_name: 'lucide:trash-2', disabled: true, class: 'attachment-menu-danger', command: () => {} }
  expect(attachment_action_item(item, ['当前草稿仍有引用', '没有机密附件权限', '当前草稿仍有引用'])).toMatchObject({
    label: '当前草稿仍有引用 + 1',
    title: '当前草稿仍有引用 / 没有机密附件权限',
    icon_name: 'lucide:trash-2',
    disabled: true,
    class: 'attachment-menu-danger',
    command: undefined,
  })
  const enabled = { ... item, disabled: false }
  expect(attachment_action_item(enabled, ['当前草稿仍有引用'])).toBe(enabled)
  expect(attachment_action_item(item, ['仅支持文件', '正在提交操作', '仅支持文件', '', '没有机密附件权限'])).toMatchObject({ label: '仅支持文件 + 2', title: '仅支持文件 / 正在提交操作 / 没有机密附件权限' })
  expect(attachment_action_item(item, ['仅支持文件', '仅支持文件'])).toMatchObject({ label: '仅支持文件', title: '仅支持文件' })
  expect(attachment_action_item(item, [])).toMatchObject({ label: '当前状态不可执行' })
})

it('preserves plain, control and shift selection without mixing upload-only rows', () => {
  expect([... select_attachment_row(rows, new Set(['b.txt']), null, rows[4]!, { ... plain, ctrlKey: true })]).toEqual(['upload'])
  expect([... select_attachment_row(rows, new Set(['c.txt']), 'docs/a.txt', rows[2]!, { ... plain, shiftKey: true })]).toEqual(['docs/a.txt', 'b.txt'])
  expect([... select_attachment_row(rows, new Set(['c.txt']), 'docs/a.txt', rows[2]!, { ... plain, shiftKey: true, ctrlKey: true })]).toEqual(['docs/a.txt', 'b.txt', 'c.txt'])
  expect([... select_attachment_row(rows, new Set(['b.txt']), null, rows[2]!, { ... plain, ctrlKey: true })]).toEqual([])
})
it('keeps selection roots for marquee and lets explicit child selection replace its ancestor', () => {
  expect([... normalize_attachment_selection(rows, new Set(['folder', 'docs/a.txt', 'upload']))]).toEqual(['folder'])
  expect([... select_attachment_row(rows, new Set(['folder']), 'folder', rows[1]!, { ... plain, ctrlKey: true })]).toEqual(['docs/a.txt'])
})
it('joins adjacent selected rows into the original rounded selection block', () => {
  const selected = new Set(['docs/a.txt', 'b.txt', 'c.txt'])
  expect(rows.map((_, i) => attachment_selection_edges(rows, i, selected))).toEqual(['both', 'top', 'none', 'bottom', 'both'])
})

it('limits selection without replacing ordinary control toggles, ranges or marquee selection', () => {
  const current = new Set(['b.txt'])
  expect([... select_attachment_row(rows, current, 'b.txt', rows[3]!, { ... plain, ctrlKey: true }, 1)]).toEqual(['b.txt'])
  expect([... select_attachment_row(rows, current, 'b.txt', rows[3]!, { ... plain, shiftKey: true }, 1)]).toEqual(['b.txt'])
  expect([... select_attachment_row(rows, current, 'b.txt', rows[2]!, { ... plain, ctrlKey: true }, 1)]).toEqual([])
  expect([... select_attachment_row(rows, new Set(), null, rows[3]!, { ... plain, ctrlKey: true }, 1)]).toEqual(['c.txt'])
  expect([... guard_attachment_selection(current, normalize_attachment_selection(rows, new Set(['b.txt', 'c.txt'])), 1)]).toEqual(['b.txt'])
  expect([... guard_attachment_selection(current, new Set(), 1)]).toEqual([])
  expect([... guard_attachment_selection(current, new Set(['c.txt']), 1)]).toEqual(['c.txt'])
})

it('treats a selectable root folder like other ancestors and lets an explicit child replace it', () => {
  const root: WorkspaceListRow = { key: 'root', path: '', name: '根目录', parent_id: 0, depth: 0, node: { id: 1, parent_id: 0, name: '根目录', path: '', kind: 'folder', version: '' } }
  const folders = [root, rows[0]!]
  expect([... normalize_attachment_selection(folders, new Set(['root', 'folder']))]).toEqual(['root'])
  expect([... select_attachment_row(folders, new Set(['root']), 'root', rows[0]!, { ... plain, ctrlKey: true }, 1)]).toEqual(['folder'])
})
