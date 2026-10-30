import type { WorkspaceListRow } from './workspace'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { attachment_action_item, attachment_batch_action, attachment_menu_context, attachment_privacy_actions, attachment_selection_edges, attachment_summary_rows, attachment_summary_tree, guard_attachment_selection, normalize_attachment_selection, select_attachment_row } from './attachment-list'
import { project_workspace_rows, workspace_capabilities } from './workspace'

const rows: WorkspaceListRow[] = [
  { key: 'folder', path: 'docs', name: 'docs', parent_id: 1, depth: 0, node: { id: 2, parent_id: 1, name: 'docs', path: 'docs', kind: 'folder', version: 'v' } },
  ... ['docs/a.txt', 'b.txt', 'c.txt'].map((path, index) => ({ key: path, path, name: path, parent_id: index ? 1 : 2, depth: index ? 0 : 1, node: { id: index + 3, parent_id: index ? 1 : 2, name: path, path, kind: 'file' as const, version: 'v' } })),
  { key: 'upload', path: 'pending.txt', name: 'pending.txt', parent_id: 1, depth: 0 },
]
const plain = { ctrlKey: false, metaKey: false, shiftKey: false }

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
  const private_file = { file_name: 'docs/photo.png.good', mime_type: 'image/png', file_size: 32, version: 'v1', is_image: true, is_private: true, is_encrypted: false, has_redacted: true, url: null }
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

it.each([true, false])('offers a separate redacted preview to an unprivileged reader (variant exists: %s)', (has_redacted) => {
  // Execute the actual menu builder so the read-only page and editing workspace
  // expose the same permission-free redacted action, with an explicit role.
  const source = readFileSync(new URL('../../components/MyContent/Attachment/Workspace.vue', import.meta.url), 'utf8')
  const builder = source.slice(source.indexOf('function menu_for('), source.indexOf('\nfunction replaced('))
  const row: WorkspaceListRow = { ... rows[1]!, node: { ... rows[1]!.node!, attachment: {
    id: 3, file_name: 'photo.png.good', mime_type: 'image/avif', file_size: 20, version: 'v1', is_image: true, is_private: true, is_encrypted: false,
    url: null, is_redacted_view: has_redacted, has_redacted, redacted_url: has_redacted ? '/redacted' : null,
  } } }
  const calls: unknown[][] = []
  const menu_for = runInNewContext(`${ts.transpile(builder)}; menu_for`, {
    attachment_action_item, attachment_menu_context,
    model: {
      readonly: true, selected_rows: [row],
      capabilities: (item: WorkspaceListRow) => workspace_capabilities(item, { readonly: true, can_private: false, pending: false }),
      preview: (... args: unknown[]) => calls.push(args),
    },
  }) as (row: WorkspaceListRow) => ReturnType<typeof attachment_action_item>[]
  const menu = menu_for(row)
  expect(menu.find(item => item.label === '下载')).toBeUndefined()
  expect(menu.find(item => item.label === '下载原图')).toBeUndefined()
  expect(Boolean(menu.find(item => item.label === '下载删减版'))).toBe(has_redacted)
  const downloads = menu.filter(item => item.icon_name === 'lucide:download')
  expect(downloads.map(item => item.label)).toEqual(has_redacted ? ['没有机密附件权限', '下载删减版'] : ['没有机密附件权限'])
  expect(downloads[0]).toMatchObject({ disabled: true, title: '没有机密附件权限', command: undefined })
  expect(menu.find(item => item.icon_name === 'lucide:eye')).toMatchObject({ label: '没有机密附件权限', title: '没有机密附件权限', disabled: true, command: undefined })
  const redacted = menu.find(item => item.label === '预览删减版')
  if (has_redacted) {
    expect(redacted).toMatchObject({ icon_name: 'lucide:eye-off' })
    expect(redacted?.disabled).not.toBe(true)
    redacted!.command!({ originalEvent: new Event('click'), item: redacted! })
    expect(calls).toEqual([[row, 'redacted_avif']])
  }
  else {
    expect(redacted).toBeUndefined()
    expect(calls).toEqual([])
  }
})

it('uses the same batch menu on every selected file or folder, and restores single-item menus outside the selection', () => {
  // Execute the SFC's actual menu builder: the regression is its single/batch wiring,
  // which cannot be covered by testing the selection utility alone (no DOM needed).
  const source = readFileSync(new URL('../../components/MyContent/Attachment/Workspace.vue', import.meta.url), 'utf8')
  const builder = source.slice(source.indexOf('function menu_for('), source.indexOf('\nfunction replaced('))
  const selected = [rows[0]!, rows[2]!]
  const move_rows = { value: [] as WorkspaceListRow[] }
  const move_visible = { value: false }
  const menu_for = runInNewContext(`${ts.transpile(builder)}; menu_for`, {
    attachment_action_item,
    attachment_batch_action,
    attachment_menu_context,
    attachment_privacy_actions,
    move_rows,
    move_visible,
    move_selected: { value: new Set() },
    move_expanded: { value: new Set() },
    move_anchor: null,
    model: {
      selected_rows: selected,
      root_id: 1,
      readonly: false,
      capabilities: (row: WorkspaceListRow) => ({ open: true, rename: true, replace: true, private: true, redact: true, move: true, delete: row.node?.kind === 'folder', reasons: { delete: row.node?.kind === 'folder' ? [] : ['当前草稿仍有引用'], move: [], open: [], rename: [], replace: [], private: [], redact: [] } }),
    },
  }) as (row: WorkspaceListRow) => ReturnType<typeof attachment_action_item>[]
  const signature = (row: WorkspaceListRow) => menu_for(row).map(item => [item.label, item.icon_name, item.disabled])
  expect(signature(selected[0]!)).toEqual(signature(selected[1]!))
  expect(menu_for(selected[0]!).map(item => item.separator ? 'separator' : item.icon_name)).toEqual(['lucide:copy', 'separator', 'lucide:lock', 'lucide:lock-open', 'lucide:folder-input', 'separator', 'lucide:trash-2'])
  expect(menu_for(selected[0]!).find(item => item.icon_name === 'lucide:lock')).toMatchObject({ label: '设为机密', disabled: false })
  expect(menu_for(selected[0]!).find(item => item.icon_name === 'lucide:lock-open')).toMatchObject({ label: '无机密附件', disabled: true, command: undefined })
  expect(menu_for(selected[0]!).find(item => item.icon_name === 'lucide:trash-2')).toMatchObject({ label: '删除', disabled: false })
  for (const row of selected) {
    const move = menu_for(row).find(item => item.icon_name === 'lucide:folder-input')!
    move.command!({ originalEvent: new Event('click'), item: move })
    expect(move_rows.value).toEqual(selected)
    expect(move_visible.value).toBe(true)
  }
  expect(menu_for(rows[3]!).map(item => item.icon_name)).toContain('lucide:refresh-cw')
  expect(attachment_menu_context(selected[0]!, selected)).toEqual({ selected, single: false })
  expect(attachment_menu_context(rows[3]!, selected)).toEqual({ selected: [rows[3]!], single: true })
})

it.each(['file', 'folder', 'image', 'image_copy', 'replacement', 'upload', 'readonly_file', 'readonly_folder', 'upload_batch'])('groups %s menu actions as read, edit, then delete without empty separators', (scenario) => {
  const source = readFileSync(new URL('../../components/MyContent/Attachment/Workspace.vue', import.meta.url), 'utf8')
  const builder = source.slice(source.indexOf('function menu_for('), source.indexOf('\nfunction replaced('))
  const file: WorkspaceListRow = { ... rows[2]!, node: { ... rows[2]!.node!, attachment: {
    file_name: 'b.txt', mime_type: 'text/plain', file_size: 1, version: 'v', url: '/b.txt', is_image: false, is_encrypted: false,
  } } }
  const image = { ... file, node: { ... file.node!, attachment: { is_image: true, image: { has_original: scenario !== 'image_copy' }, url: '/image.avif' } } } as WorkspaceListRow
  const upload = { ... rows[4]!, session: { id: 'upload', status: 'receiving' } } as WorkspaceListRow
  const replacement = project_workspace_rows([file.node!], [{ ... upload.session!, purpose: 'replace', source_id: file.node!.id, path: 'replacement.gif', parent_id: 1 }], 1, new Set())[0]!
  const selected = scenario === 'folder' || scenario === 'readonly_folder'
    ? [rows[0]!]
    : scenario === 'image' || scenario === 'image_copy'
      ? [image]
      : scenario === 'replacement'
        ? [replacement]
        : scenario === 'upload'
          ? [upload]
          : scenario === 'upload_batch' ? [upload, { ... upload, key: 'second-upload' }] : [file]
  const readonly = scenario.startsWith('readonly_')
  const menu_for = runInNewContext(`${ts.transpile(builder)}; menu_for`, {
    attachment_action_item, attachment_batch_action, attachment_menu_context, attachment_privacy_actions,
    model: {
      selected_rows: selected, readonly,
      uploads: { active: new Set(), queued: new Set() },
      capabilities: (row: WorkspaceListRow) => workspace_capabilities(row, { readonly, can_private: true, pending: false }),
    },
  }) as (row: WorkspaceListRow) => ReturnType<typeof attachment_action_item>[]
  const expected: Record<string, string[]> = {
    file: ['download', 'copy', '|', 'pencil', 'refresh-cw', 'lock', 'folder-input', '|', 'trash-2'],
    folder: ['copy', '|', 'pencil', 'paperclip', 'paperclip', 'folder-plus', 'lock', 'folder-input', '|', 'trash-2'],
    image: ['eye', 'download', 'download', 'copy', '|', 'pencil', 'refresh-cw', 'crop', 'lock', 'folder-input', '|', 'trash-2'],
    image_copy: ['eye', 'download', 'copy', '|', 'pencil', 'refresh-cw', 'crop', 'lock', 'folder-input', '|', 'trash-2'],
    replacement: ['play', '|', 'x'],
    upload: ['play', '|', 'x'],
    readonly_file: ['download'],
    readonly_folder: [],
    upload_batch: ['play', '|', 'x'],
  }
  expect(menu_for(selected[0]!).map(item => item.separator ? '|' : item.icon_name?.replace('lucide:', ''))).toEqual(expected[scenario])
})

it('confirms redacted deletion before executing and keeps ordinary deletion independent', () => {
  // Execute both the actual menu command and dialog submit handler: a service
  // test cannot detect a menu bypassing confirmation and deleting immediately.
  const source = readFileSync(new URL('../../components/MyContent/Attachment/Workspace.vue', import.meta.url), 'utf8')
  const builder = source.slice(source.indexOf('function menu_for('), source.indexOf('\nfunction replaced('))
  const submit = source.slice(source.indexOf('function submit_delete('), source.indexOf('\nfunction menu_for('))
  const row: WorkspaceListRow = { ... rows[2]!, node: { ... rows[2]!.node!, attachment: {
    file_name: 'photo.png.good', mime_type: 'image/avif', file_size: 1, version: 'v1', url: '/normal', is_image: true, is_encrypted: false,
    is_private: true, has_redacted: true,
  } } }
  const requests: unknown[] = []
  const delete_visible = { value: false }
  const redacted_delete_visible = { value: false }
  const delete_impact = { value: { targets: [], sources: [] } }
  const delete_impact_loading = { value: false }
  const delete_impact_failure = { value: false }
  const delete_rows = { value: [] as WorkspaceListRow[] }
  const deleting_redacted = { value: false }
  const model = {
    selected: new Set([row.key]), selected_rows: [row], readonly: false,
    capabilities: (item: WorkspaceListRow) => workspace_capabilities(item, { readonly: false, can_private: true, pending: false }),
    target: (item: WorkspaceListRow) => ({ id: item.node!.id, version: item.node!.version }),
    execute: (command: unknown) => requests.push(command),
  }
  const context = runInNewContext(`${ts.transpile(`${builder}\n${submit}`)}; ({ menu_for, submit_delete })`, {
    model, attachment_action_item, attachment_batch_action, attachment_menu_context, attachment_privacy_actions,
    delete_visible, redacted_delete_visible, delete_impact, delete_impact_loading, delete_impact_failure, delete_rows, deleting_redacted,
  }) as { menu_for: (row: WorkspaceListRow) => ReturnType<typeof attachment_action_item>[], submit_delete: () => void }
  const request = () => {
    const action = context.menu_for(row).find(item => item.label === '删除删减版')!
    action.command!({ originalEvent: new Event('click'), item: action })
  }
  request()
  expect(requests).toEqual([])
  expect(redacted_delete_visible.value).toBe(true)
  expect(delete_rows.value).toEqual([row])
  redacted_delete_visible.value = false
  context.submit_delete()
  expect(requests).toEqual([])
  request()
  context.submit_delete()
  expect(redacted_delete_visible.value).toBe(false)
  expect(requests).toEqual([{ operation: 'delete_redacted', target: model.target(row) }])
  const normal = context.menu_for(row).find(item => item.label === '删除')!
  normal.command!({ originalEvent: new Event('click'), item: normal })
  expect(deleting_redacted.value).toBe(false)
  context.submit_delete()
  expect(requests[1]).toEqual({ operation: 'delete', targets: [model.target(row)] })
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

it.each([true, false].flatMap(desired => ['file', 'folder', 'mixed'].map(kind => ({ desired, kind }))))('submits $desired for every changing $kind target through the shared confirmation', ({ desired, kind }) => {
  const source = readFileSync(new URL('../../components/MyContent/Attachment/Workspace.vue', import.meta.url), 'utf8')
  const builder = source.slice(source.indexOf('function menu_for('), source.indexOf('\nfunction replaced('))
  const submit = source.slice(source.indexOf('function submit_private('), source.indexOf('\nfunction accept_replacement('))
  const other_folder: WorkspaceListRow = { ... rows[0]!, key: 'other-folder', path: 'other', name: 'other', node: { ... rows[0]!.node!, id: 6, path: 'other', name: 'other' } }
  const targets = kind === 'file' ? [rows[1]!, rows[2]!] : kind === 'folder' ? [rows[0]!, other_folder] : [rows[0]!, rows[2]!]
  const changing = targets.map((row) => {
    const path = row.path + (desired ? '' : '.good')
    return { ... row, path, name: path, node: { ... row.node!, path, name: path, ... (row.node!.kind === 'file' ? { attachment: { is_private: ! desired } } : {}) } }
  }) as WorkspaceListRow[]
  const unchanged = { ... rows[3]!, node: { ... rows[3]!.node!, attachment: { is_private: desired } } } as WorkspaceListRow
  const busy = { ... changing[0]!, key: 'busy', session: { id: 'pending' } } as WorkspaceListRow
  const selected = [... changing, unchanged, busy]
  const private_rows = { value: [] as WorkspaceListRow[] }
  const private_value = { value: false }
  const private_visible = { value: false }
  const requests: unknown[] = []
  const model = {
    selected: new Set(selected.map(row => row.key)),
    selected_rows: selected,
    readonly: false,
    target: (row: WorkspaceListRow) => ({ id: row.node!.id, version: row.node!.version }),
    execute: (command: unknown) => requests.push(command),
    capabilities: (row: WorkspaceListRow) => workspace_capabilities(row, { readonly: false, can_private: true, pending: false }),
  }
  const context = runInNewContext(`${ts.transpile(`${builder}\n${submit}`)}; ({menu_for, submit_private})`, {
    attachment_action_item, attachment_batch_action, attachment_menu_context, attachment_privacy_actions,
    private_rows, private_value, private_visible,
    model,
  }) as { menu_for: (row: WorkspaceListRow) => ReturnType<typeof attachment_action_item>[], submit_private: () => void }
  const action = context.menu_for(selected[1]!).find(item => item.icon_name === (desired ? 'lucide:lock' : 'lucide:lock-open'))!
  action.command!({ originalEvent: new Event('click'), item: action })
  expect(private_visible.value).toBe(true)
  expect(private_rows.value).toEqual(changing)
  expect([... model.selected]).toEqual(changing.map(row => row.key))
  expect(requests).toEqual([])
  context.submit_private()
  expect(requests).toEqual([{ operation: 'set_private', targets: changing.map(row => ({ id: row.node!.id, version: 'v' })), private: desired }])
  expect(private_visible.value).toBe(false)
})

it.each(['delete', 'move'] as const)('filters ineligible rows before opening the %s dialog and submits only retained targets', (operation) => {
  const source = readFileSync(new URL('../../components/MyContent/Attachment/Workspace.vue', import.meta.url), 'utf8')
  const builder = source.slice(source.indexOf('function menu_for('), source.indexOf('\nfunction replaced('))
  const submit = operation === 'delete'
    ? source.slice(source.indexOf('function submit_delete('), source.indexOf('\nfunction menu_for('))
    : source.slice(source.indexOf('function submit_move('), source.indexOf('\nfunction clear_move_selection('))
  const busy = { ... rows[1]!, session: { id: 'pending' } } as WorkspaceListRow
  const denied = { ... rows[3]!, node: { ... rows[3]!.node!, attachment: { is_private: true } } } as WorkspaceListRow
  const selected = [rows[0]!, busy, rows[2]!, denied]
  const retained = [rows[0]!, rows[2]!]
  const action_rows = { value: [] as WorkspaceListRow[] }
  const visible = { value: false }
  const requests: { command: unknown, selection: string[] }[] = []
  const model = {
    selected: new Set(selected.map(row => row.key)),
    selected_rows: selected,
    readonly: false,
    root_id: 1,
    target: (row: WorkspaceListRow) => ({ id: row.node!.id, version: row.node!.version }),
    execute: (command: unknown) => requests.push({ command, selection: [... model.selected] }),
    capabilities: (row: WorkspaceListRow) => workspace_capabilities(row, { readonly: false, can_private: false, pending: false }),
  }
  const context = runInNewContext(`${ts.transpile(`${builder}\n${submit}`)}; ({menu_for, submit: submit_${operation}})`, {
    attachment_action_item, attachment_batch_action, attachment_menu_context, attachment_privacy_actions,
    [`${operation}_rows`]: action_rows, [`${operation}_visible`]: visible,
    deleting_redacted: { value: false },
    redacted_delete_visible: { value: false }, delete_impact: { value: { targets: [], sources: [] } },
    delete_impact_loading: { value: false }, delete_impact_failure: { value: false },
    move_ready: { value: true }, move_parent: { value: 9 }, move_selected: { value: new Set() }, move_expanded: { value: new Set() }, move_anchor: null,
    model,
  }) as { menu_for: (row: WorkspaceListRow) => ReturnType<typeof attachment_action_item>[], submit: () => void }
  const icon = operation === 'delete' ? 'lucide:trash-2' : 'lucide:folder-input'
  const action = context.menu_for(selected[0]!).find(item => item.icon_name === icon)!
  expect(action.disabled).toBe(false)
  action.command!({ originalEvent: new Event('click'), item: action })
  expect(visible.value).toBe(true)
  expect(action_rows.value).toEqual(retained)
  expect([... model.selected]).toEqual(retained.map(row => row.key))
  expect(requests).toEqual([])
  context.submit()
  expect(requests).toEqual([{
    command: { operation, targets: retained.map(model.target), ... (operation === 'delete' ? {} : { parent_id: 9 }) },
    selection: retained.map(row => row.key),
  }])
  expect(visible.value).toBe(false)
  model.selected_rows = [busy, denied]
  expect(context.menu_for(busy).find(item => item.icon_name === icon)).toMatchObject({ disabled: true, command: undefined })
})

it.each(['dialog', 'drag'])('deselects no-op moves before submitting from %s', async (entry) => {
  const source = readFileSync(new URL('../../components/MyContent/Attachment/Workspace.vue', import.meta.url), 'utf8')
  const submit = source.slice(source.indexOf('function submit_move('), source.indexOf('\nfunction clear_move_selection('))
  const drop = source.slice(source.indexOf('async function drop('), source.indexOf('\n</script>'))
  const selected = [rows[1]!, rows[2]!]
  const requests: { command: unknown, selection: string[] }[] = []
  const model = {
    readonly: false,
    selected: new Set(selected.map(row => row.key)),
    get selected_rows() { return selected.filter(row => this.selected.has(row.key)) },
    drag_ids: selected.map(row => row.node!.id),
    capabilities: (row: WorkspaceListRow) => workspace_capabilities(row, { readonly: false, can_private: true, pending: false }),
    catalog: { data: { nodes: rows.filter(row => row.node).map(row => row.node!) } },
    target: (row: WorkspaceListRow) => ({ id: row.node!.id, version: row.node!.version }),
    execute: (command: unknown) => { requests.push({ command, selection: [... model.selected] }) },
  }
  const context = runInNewContext(`${ts.transpile(`${submit}\n${drop}`)}; ({submit_move, drop})`, {
    model, prefix: () => '',
    move_ready: { value: true }, move_parent: { value: 1 }, move_rows: { value: selected }, move_visible: { value: true },
  }) as { submit_move: () => void, drop: (event: DragEvent, parent: number) => Promise<void> }
  if (entry === 'dialog')
    context.submit_move()
  else
    await context.drop({} as DragEvent, 1)
  expect([... model.selected]).toEqual([rows[1]!.key])
  expect(requests).toEqual([{ command: { operation: 'move', targets: [{ id: rows[1]!.node!.id, version: 'v' }], parent_id: 1 }, selection: [rows[1]!.key] }])
  if (entry === 'drag') {
    model.selected = new Set([rows[2]!.key])
    model.drag_ids = [rows[2]!.node!.id]
    await context.drop({} as DragEvent, 1)
    expect([... model.selected]).toEqual([])
    expect(requests).toHaveLength(1)
  }
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
it('offers batch controls for ordinary active, paused and failed upload tasks', async () => {
  const source = readFileSync(new URL('../../components/MyContent/Attachment/Workspace.vue', import.meta.url), 'utf8')
  const builder = source.slice(source.indexOf('function menu_for('), source.indexOf('\nfunction replaced('))
  const selected = ['active', 'paused', 'failed'].map(id => ({ ... rows[4]!, key: id, session: { id, status: 'receiving' } })) as WorkspaceListRow[]
  const paused: string[] = []
  const resumed: string[] = []
  const cancelled: string[] = []
  const menu_for = runInNewContext(`${ts.transpile(builder)}; menu_for`, {
    attachment_menu_context,
    model: {
      selected_rows: selected, readonly: false, capabilities: () => ({ reasons: {} }),
      uploads: {
        active: new Set(['active']), queued: new Set(),
        pause: (id: string) => paused.push(id),
        resume: async (id: string) => {
          resumed.push(id)
          return true
        },
        cancel: async (id: string) => { cancelled.push(id) },
      },
    },
  }) as (row: WorkspaceListRow) => ReturnType<typeof attachment_action_item>[]
  for (const row of selected)
    expect(menu_for(row).filter(item => ! item.separator).map(item => item.label)).toEqual(['暂停', '继续', '取消'])
  const menu = menu_for(selected[0]!)
  for (const item of menu.filter(item => ! item.separator))
    await item.command?.({ originalEvent: {} as Event, item })
  expect(paused).toEqual(['active'])
  expect(resumed).toEqual(['paused', 'failed'])
  expect(cancelled).toEqual(['active', 'paused', 'failed'])
})
