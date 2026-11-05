import type { ContentStoryAttachment } from '@shared/types/content'
import type { ContentUploadSession } from '@shared/types/content-upload'
import type { useAttachmentPanel } from '~/features/content/attachments/panel'
import type { WorkspaceListRow } from '~/features/content/attachments/workspace-model'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { DOMWrapper, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { content_selection_markdown } from '~/features/content/attachments/drag'
import { project_workspace_rows, workspace_capabilities } from '~/features/content/attachments/workspace-model'
import { get_content_attachment_drag_data, get_content_folder_drag_data } from '../internal/attachment-drag'
import Workspace from './Workspace.vue'

mockNuxtImport('useMyToast', () => () => ({ error: vi.fn() }))

const wrappers: { unmount: () => void }[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function file(id: number, name = `${id}.txt`, attachment: Partial<ContentStoryAttachment> = {}, parent_id = 1): WorkspaceListRow {
  return {
    key: `node:${id}`, path: name, name, parent_id, depth: 0,
    node: { id, parent_id, name, path: name, kind: 'file', version: 'v', attachment: {
      id, file_name: name, mime_type: 'text/plain', file_size: 10, version: 'v', url: `/${name}`, is_image: false, ... attachment,
    } },
  }
}

function folder(id: number, name: string): WorkspaceListRow {
  return { key: `node:${id}`, path: name, name, parent_id: 1, depth: 0, node: { id, parent_id: 1, name, path: name, kind: 'folder', version: 'v' } }
}

function upload(id: string): WorkspaceListRow {
  return { key: `session:${id}`, path: `${id}.txt`, name: `${id}.txt`, parent_id: 1, depth: 0,
    session: { id, status: 'receiving', size: 10, parts: [] } as unknown as ContentUploadSession }
}

async function mount(rows = [file(2), file(3), file(4)], options: { readonly?: boolean, can_private?: boolean } = {}) {
  // The business controller is the boundary. Workspace, List, Card, menus and
  // deletion confirmation stay real so events exercise their actual wiring.
  const model = reactive({
    rows, readonly: options.readonly ?? false, selected: new Set<string>(), expanded: new Set<number>(), drag_ids: [] as number[], root_id: 1,
    get selected_rows(): WorkspaceListRow[] { return this.rows.filter(row => this.selected.has(row.key)) },
    catalog: { data: { nodes: rows.flatMap(row => row.node ? [row.node] : []), root_id: 1 } },
    uploads: {
      identity_key: 'user:scope', preparations: [], admitting: false, admission_error: '',
      errors: new Map<string, string>(), progress: new Map(), active: new Set<string>(), queued: new Set<string>(),
      pause: vi.fn(), resume: vi.fn(async () => true), cancel: vi.fn(async () => {}),
    },
    capabilities: (row: WorkspaceListRow) => workspace_capabilities(row, { readonly: options.readonly ?? false, can_private: options.can_private ?? true, pending: false }),
    target: (row: WorkspaceListRow) => ({ id: row.node!.id, version: row.node!.version }),
    command_pending: () => false, command_moving: () => false, command_failed: () => false, can_execute: () => true,
    request_error: '', draft_markdown: '', pending: false,
    execute: vi.fn(async (_command: unknown) => {}),
    get_delete_impact: vi.fn(async () => ({ targets: [], sources: [] })),
    open: vi.fn(), download: vi.fn(), preview: vi.fn(), start: vi.fn(), toggle_folder: vi.fn(),
  })
  const wrapper = await mountSuspended(Workspace, {
    attachTo: document.body,
    props: { controller: model as unknown as ReturnType<typeof useAttachmentPanel>, dialogs: false },
    global: { stubs: {
      MyDialog: { props: ['visible', 'header'], emits: ['update:visible'], template: '<section v-if="visible" role="dialog" :aria-label="header" class="p-dialog"><slot /><slot name="footer" /></section>' },
      MyIcon: { props: ['name'], template: '<span :data-icon="name" />' },
      MyContentAttachmentImageEditor: true,
    } },
  })
  wrappers.push(wrapper)
  return { wrapper, model }
}

type Mounted = Awaited<ReturnType<typeof mount>>
const row_element = (mounted: Mounted, key: string) => mounted.wrapper.get(`[data-row-key="${key}"]`)
async function context_menu(mounted: Mounted, key: string) {
  await row_element(mounted, key).trigger('contextmenu', { button: 2 })
  await flushPromises()
  const menus = document.querySelectorAll('.p-contextmenu')
  const menu = menus.item(menus.length - 1)
  expect(menu).not.toBeNull()
  return new DOMWrapper(menu as HTMLElement)
}
async function action(menu: DOMWrapper<Element>, label: string) {
  const item = menu.findAll('[role="menuitem"]').find(item => item.text() === label)
  expect(item, `menu action: ${label}`).toBeDefined()
  await item!.get('.p-contextmenu-item-content').trigger('click')
  await flushPromises()
}
async function confirm(mounted: Mounted, dialog: string, label: string) {
  const element = mounted.wrapper.get(`[role="dialog"][aria-label="${dialog}"]`)
  const button = element.findAll('button').find(button => button.text() === label)
  expect(button).toBeDefined()
  await button!.trigger('click')
  await flushPromises()
}

it('connects plain, control and shift selection and right-click targeting through real rows', async () => {
  const mounted = await mount()
  await row_element(mounted, 'node:2').trigger('click')
  await row_element(mounted, 'node:4').trigger('click', { shiftKey: true })
  expect([... mounted.model.selected]).toEqual(['node:2', 'node:3', 'node:4'])
  await row_element(mounted, 'node:3').trigger('click', { ctrlKey: true })
  expect([... mounted.model.selected]).toEqual(['node:2', 'node:4'])
  expect(row_element(mounted, 'node:4').classes()).toContain('file-row-selected')
  const batch = await context_menu(mounted, 'node:2')
  expect(batch.text()).toContain('移动')
  expect(batch.text()).not.toContain('重命名')
  const single = await context_menu(mounted, 'node:3')
  expect([... mounted.model.selected]).toEqual(['node:3'])
  expect(single.text()).toContain('重命名')
})

it('keeps the locked file suffix through blank and complete rename submissions', async () => {
  const row = file(2, 'photo.png.good', { is_private: true, mime_type: 'image/png' })
  const mounted = await mount([row])
  await action(await context_menu(mounted, row.key), '重命名')
  const dialog = mounted.wrapper.get('[role="dialog"][aria-label="重命名"]')
  const input = dialog.get('input[aria-label="名称"]')
  expect((input.element as HTMLInputElement).value).toBe('photo')

  await input.setValue('')
  await input.trigger('keydown.enter')
  await flushPromises()
  expect(mounted.model.execute).not.toHaveBeenCalled()
  expect(mounted.wrapper.find('[role="dialog"][aria-label="重命名"]').exists()).toBe(true)

  await input.setValue('New.Name')
  await confirm(mounted, '重命名', '确定')
  expect(mounted.model.execute).toHaveBeenCalledExactlyOnceWith({ operation: 'rename', target: mounted.model.target(row), name: 'New.Name.png' })
  expect(mounted.wrapper.find('[role="dialog"][aria-label="重命名"]').exists()).toBe(false)
})

it('renames dotted folders as folders and creates a child folder at the selected parent', async () => {
  const row = folder(2, 'Folder.JPG')
  const mounted = await mount([row])
  await action(await context_menu(mounted, row.key), '重命名')
  const rename_input = mounted.wrapper.get('[role="dialog"][aria-label="重命名"] input[aria-label="名称"]')
  expect((rename_input.element as HTMLInputElement).value).toBe('Folder.JPG')
  await rename_input.setValue('New.Name')
  await confirm(mounted, '重命名', '确定')
  expect(mounted.model.execute).toHaveBeenLastCalledWith({ operation: 'rename', target: mounted.model.target(row), name: 'New.Name' })

  await action(await context_menu(mounted, row.key), '新建文件夹')
  const create_input = mounted.wrapper.get('[role="dialog"][aria-label="新建文件夹"] input[aria-label="名称"]')
  expect((create_input.element as HTMLInputElement).value).toBe('')
  await create_input.setValue('Folder.png')
  await confirm(mounted, '新建文件夹', '确定')
  expect(mounted.model.execute).toHaveBeenLastCalledWith({ operation: 'create_folder', parent_id: 2, name: 'Folder.png' })
})

/** Minimal DataTransfer stand-in: the drag handlers only touch these members. */
function fake_data_transfer() {
  const store = new Map<string, string>()
  return {
    effectAllowed: 'uninitialized',
    types: [] as string[],
    setData(type: string, value: string) {
      store.set(type, value)
      if (! this.types.includes(type))
        this.types.push(type)
    },
    getData(type: string) {
      return store.get(type) ?? ''
    },
  }
}

it('copies and drags the same entire selection from folder, image, file and private rows', async () => {
  const rows = [folder(2, 'docs'), file(3, 'image.png', { is_image: true, mime_type: 'image/png' }), file(4, 'note.txt'), file(5, 'private.pdf.good', { is_private: true, url: null })]
  const write = vi.fn()
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
  const mounted = await mount(rows)
  try {
    for (const row of rows)
      await row_element(mounted, row.key).trigger('click', { ctrlKey: true })
    const expected = content_selection_markdown(mounted.model.rows as never)
    expect(expected).toBe('[](att://docs)\n![](att://image.png)\n[](att://note.txt)\n[](att://private.pdf.good)')
    for (const origin of rows) {
      await action(await context_menu(mounted, origin.key), '复制')
      expect(write).toHaveBeenLastCalledWith(expected)
      const transfer = fake_data_transfer()
      await row_element(mounted, origin.key).trigger('dragstart', { dataTransfer: transfer })
      expect(transfer.effectAllowed).toBe('copyMove')
      expect(mounted.model.drag_ids).toEqual([2, 3, 4, 5])
      if (origin.node?.kind === 'folder')
        expect(get_content_folder_drag_data(transfer as unknown as DataTransfer)).toMatchObject({ folder: 'docs', file_names: ['docs', 'image.png', 'note.txt', 'private.pdf.good'], markdown: expected })
      else
        expect(get_content_attachment_drag_data(transfer as unknown as DataTransfer)).toMatchObject({ file_name: origin.name, file_names: ['docs', 'image.png', 'note.txt', 'private.pdf.good'], markdown: expected })
    }

    // Dragging an unselected row hands the drag its own selection.
    const single = fake_data_transfer()
    await row_element(mounted, rows[1]!.key).trigger('click')
    await row_element(mounted, rows[1]!.key).trigger('dragstart', { dataTransfer: single })
    expect([... mounted.model.selected]).toEqual([rows[1]!.key])
    expect(get_content_attachment_drag_data(single as unknown as DataTransfer)).toMatchObject({ file_name: 'image.png', markdown: '![](att://image.png)' })
  }
  finally {
    if (clipboard)
      Object.defineProperty(navigator, 'clipboard', clipboard)
  }
})

it('clears selection and its anchor outside the workspace, and releases its document listener on unmount', async () => {
  const mounted = await mount()
  await row_element(mounted, 'node:2').trigger('click')
  await row_element(mounted, 'node:2').trigger('pointerdown')
  expect([... mounted.model.selected]).toEqual(['node:2'])
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await row_element(mounted, 'node:4').trigger('click', { shiftKey: true })
  expect([... mounted.model.selected]).toEqual(['node:4'])
  mounted.wrapper.unmount()
  wrappers.pop()
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  expect([... mounted.model.selected]).toEqual(['node:4'])
})

it.each(['identity', 'removed-row'] as const)('resets the shift anchor after %s changes', async (change) => {
  const mounted = await mount()
  await row_element(mounted, 'node:2').trigger('click')
  if (change === 'identity') {
    mounted.model.uploads.identity_key = 'other:scope'
  }
  else {
    mounted.model.rows = mounted.model.rows.filter(row => row.key !== 'node:2')
    await flushPromises()
    mounted.model.rows.unshift(file(2))
  }
  await flushPromises()
  await row_element(mounted, 'node:4').trigger('click', { shiftKey: true })
  expect([... mounted.model.selected]).toEqual(['node:4'])
})

it.each([true, false])('offers only authorized redacted actions in the read-only menu (variant: %s)', async (has_redacted) => {
  const row = file(2, 'photo.png.good', { is_image: true, mime_type: 'image/webp', is_private: true, url: null, has_redacted, is_redacted_view: has_redacted, redacted_url: has_redacted ? '/redacted' : null })
  const mounted = await mount([row], { readonly: true, can_private: false })
  const menu = await context_menu(mounted, row.key)
  expect(menu.findAll('[role="menuitem"]').filter(item => item.attributes('aria-disabled') === 'true')).toHaveLength(2)
  expect(menu.text().includes('下载删减版')).toBe(has_redacted)
  expect(menu.text()).not.toContain('下载原图')
  expect(menu.text()).not.toContain('重命名')
  if (has_redacted) {
    await action(menu, '预览删减版')
    expect(mounted.model.preview).toHaveBeenCalledWith(row, 'redacted_display')
    await action(await context_menu(mounted, row.key), '下载删减版')
    expect(mounted.model.download).toHaveBeenCalledWith(row, 'redacted_display')
  }
  expect(mounted.model.execute).not.toHaveBeenCalled()
})

it('uses the same batch menu from selected files and folders, and moves the selected batch', async () => {
  const rows = [folder(2, 'docs'), file(3), folder(9, 'destination')]
  const mounted = await mount(rows)
  await row_element(mounted, rows[0]!.key).trigger('click', { ctrlKey: true })
  await row_element(mounted, rows[1]!.key).trigger('click', { ctrlKey: true })
  const first = (await context_menu(mounted, rows[0]!.key)).text()
  const second = await context_menu(mounted, rows[1]!.key)
  expect(second.text()).toBe(first)
  expect(second.text()).not.toContain('重命名')
  await action(second, '移动')
  const picker = mounted.wrapper.get('[aria-label="目标目录"]')
  await picker.get('[data-row-key="node:9"]').trigger('click', { ctrlKey: true })
  expect(mounted.model.execute).not.toHaveBeenCalled()
  await confirm(mounted, '移动', '移动')
  expect(mounted.model.execute).toHaveBeenCalledWith({ operation: 'move', targets: rows.slice(0, 2).map(mounted.model.target), parent_id: 9 })
})

it.each(['file', 'folder', 'image', 'image_copy', 'replacement', 'upload', 'readonly_file', 'readonly_folder', 'upload_batch'])('groups %s menu actions as read, edit and delete', async (scenario) => {
  const normal = file(2)
  const image = file(2, 'photo.webp', { is_image: true, mime_type: 'image/webp', image: { has_original: scenario !== 'image_copy' } as ContentStoryAttachment['image'] })
  const session = upload('upload')
  const replacement = project_workspace_rows([normal.node!], [{ ... session.session!, purpose: 'replace', source_id: 2, path: 'replacement.gif', parent_id: 1 }], 1, new Set())[0]!
  const rows = scenario.includes('folder')
    ? [folder(2, 'docs')]
    : scenario.startsWith('image')
      ? [image]
      : scenario === 'replacement'
        ? [replacement]
        : scenario === 'upload_batch'
          ? [session, upload('second')]
          : scenario === 'upload' ? [session] : [normal]
  const mounted = await mount(rows, { readonly: scenario.startsWith('readonly_') })
  for (const row of rows)
    await row_element(mounted, row.key).trigger('click', { ctrlKey: true })
  await row_element(mounted, rows[0]!.key).trigger('contextmenu', { button: 2 })
  await flushPromises()
  const expected: Record<string, string[]> = {
    file: ['download', 'copy', '|', 'pencil', 'refresh-cw', 'lock', 'folder-input', '|', 'trash-2'],
    folder: ['copy', '|', 'pencil', 'paperclip', 'paperclip', 'folder-plus', 'lock', 'folder-input', '|', 'trash-2'],
    image: ['eye', 'download', 'download', 'copy', '|', 'pencil', 'refresh-cw', 'crop', 'lock', 'folder-input', '|', 'trash-2'],
    image_copy: ['eye', 'download', 'copy', '|', 'pencil', 'refresh-cw', 'crop', 'lock', 'folder-input', '|', 'trash-2'],
    replacement: ['play', '|', 'x'], upload: ['play', '|', 'x'],
    readonly_file: ['download'], readonly_folder: [], upload_batch: ['play', '|', 'x'],
  }
  const entries = [... document.querySelectorAll('.p-contextmenu [role="menuitem"], .p-contextmenu [role="separator"]')]
  expect(entries.map(item => item.getAttribute('role') === 'separator' ? '|' : item.querySelector('[data-icon]')?.getAttribute('data-icon')?.replace('lucide:', ''))).toEqual(expected[scenario])
})

it('requires confirmation for redacted deletion, supports cancellation and keeps ordinary deletion separate', async () => {
  const row = file(2, 'photo.png.good', { is_image: true, mime_type: 'image/webp', is_private: true, has_redacted: true })
  const mounted = await mount([row])
  await action(await context_menu(mounted, row.key), '删除删减版')
  expect(mounted.model.execute).not.toHaveBeenCalled()
  await confirm(mounted, '删除删减版', '取消')
  expect(mounted.wrapper.find('[aria-label="删除删减版"]').exists()).toBe(false)
  expect(mounted.model.execute).not.toHaveBeenCalled()
  await action(await context_menu(mounted, row.key), '删除删减版')
  await confirm(mounted, '删除删减版', '删除')
  expect(mounted.model.execute).toHaveBeenLastCalledWith({ operation: 'delete_redacted', target: mounted.model.target(row) })
  await action(await context_menu(mounted, row.key), '删除')
  expect(mounted.model.get_delete_impact).toHaveBeenCalledWith([2])
  expect(mounted.model.execute).toHaveBeenCalledTimes(1)
  await confirm(mounted, '空城计？', '仍然删除')
  expect(mounted.model.execute).toHaveBeenLastCalledWith({ operation: 'delete', targets: [mounted.model.target(row)] })
})

it.each([true, false].flatMap(desired => ['file', 'folder', 'mixed'].map(kind => ({ desired, kind }))))('confirms $desired privacy for changing $kind targets and excludes unchanged or busy rows', async ({ desired, kind }) => {
  const name = (value: string) => value + (desired ? '' : '.good')
  const changing = kind === 'file'
    ? [file(2, name('a.txt'), { is_private: ! desired }), file(3, name('b.txt'), { is_private: ! desired })]
    : kind === 'folder'
      ? [folder(2, name('docs')), folder(3, name('other'))]
      : [folder(2, name('docs')), file(3, name('b.txt'), { is_private: ! desired })]
  const unchanged = file(4, 'unchanged.txt', { is_private: desired })
  const busy = { ... file(5), session: upload('busy').session }
  const rows = [... changing, unchanged, busy]
  const mounted = await mount(rows)
  for (const row of rows)
    await row_element(mounted, row.key).trigger('click', { ctrlKey: true })
  await action(await context_menu(mounted, rows[1]!.key), desired ? '设为机密' : '取消机密')
  expect([... mounted.model.selected]).toEqual(changing.map(row => row.key))
  expect(mounted.model.execute).not.toHaveBeenCalled()
  await confirm(mounted, '修改机密状态', '确认')
  expect(mounted.model.execute).toHaveBeenCalledWith({ operation: 'set_private', targets: changing.map(mounted.model.target), private: desired })
})

it.each(['delete', 'move'] as const)('filters denied and busy rows before confirming %s', async (operation) => {
  const retained = [folder(2, 'docs'), file(3)]
  const busy = { ... file(4), session: upload('busy').session }
  const denied = file(5, 'secret.good', { is_private: true })
  const selected = [... retained, busy, denied]
  const mounted = await mount([... selected, folder(9, 'destination')], { can_private: false })
  for (const row of selected)
    await row_element(mounted, row.key).trigger('click', { ctrlKey: true })
  await action(await context_menu(mounted, retained[0]!.key), operation === 'delete' ? '删除' : '移动')
  expect([... mounted.model.selected]).toEqual(retained.map(row => row.key))
  expect(mounted.model.execute).not.toHaveBeenCalled()
  if (operation === 'move') {
    await mounted.wrapper.get('[aria-label="目标目录"] [data-row-key="node:9"]').trigger('click', { ctrlKey: true })
    await confirm(mounted, '移动', '移动')
  }
  else {
    await confirm(mounted, '空城计？', '仍然删除')
  }
  expect(mounted.model.execute).toHaveBeenCalledWith({ operation, targets: retained.map(mounted.model.target), ... (operation === 'move' ? { parent_id: 9 } : {}) })
  await row_element(mounted, busy.key).trigger('click')
  await row_element(mounted, denied.key).trigger('click', { ctrlKey: true })
  const menu = await context_menu(mounted, busy.key)
  const icon = operation === 'delete' ? 'lucide:trash-2' : 'lucide:folder-input'
  const item = menu.findAll('[role="menuitem"]').find(item => item.find(`[data-icon="${icon}"]`).exists())!
  expect(item.attributes('aria-disabled')).toBe('true')
  await item.trigger('click')
  expect(mounted.model.execute).toHaveBeenCalledTimes(1)
})

it.each(['dialog', 'drag'] as const)('excludes no-op moves from %s and ignores a wholly no-op drag', async (entry) => {
  const nested = file(3, 'docs/a.txt', {}, 2)
  const root = file(4, 'b.txt')
  const mounted = await mount([folder(2, 'docs'), nested, root])
  await row_element(mounted, nested.key).trigger('click')
  await row_element(mounted, root.key).trigger('click', { ctrlKey: true })
  if (entry === 'dialog') {
    await action(await context_menu(mounted, nested.key), '移动')
    await mounted.wrapper.get('[aria-label="目标目录"] [data-row-key="node:1"]').trigger('click', { ctrlKey: true })
    await confirm(mounted, '移动', '移动')
  }
  else {
    await row_element(mounted, nested.key).trigger('dragstart', { dataTransfer: { setData: vi.fn() } })
    await mounted.wrapper.get('.file-list-root').trigger('drop')
  }
  expect([... mounted.model.selected]).toEqual([nested.key])
  expect(mounted.model.execute).toHaveBeenCalledWith({ operation: 'move', targets: [mounted.model.target(nested)], parent_id: 1 })
  if (entry === 'drag') {
    await row_element(mounted, root.key).trigger('click')
    await row_element(mounted, root.key).trigger('dragstart', { dataTransfer: { setData: vi.fn() } })
    await mounted.wrapper.get('.file-list-root').trigger('drop')
    expect([... mounted.model.selected]).toEqual([])
    expect(mounted.model.execute).toHaveBeenCalledTimes(1)
  }
})

it('connects batch pause, resume and cancellation to active, paused and failed uploads', async () => {
  const rows = ['active', 'paused', 'failed'].map(upload)
  const mounted = await mount(rows)
  mounted.model.uploads.active.add('active')
  mounted.model.uploads.errors.set('failed', 'interrupted')
  for (const row of rows)
    await row_element(mounted, row.key).trigger('click', { ctrlKey: true })
  for (const row of rows)
    expect((await context_menu(mounted, row.key)).findAll('[role="menuitem"]').map(item => item.text())).toEqual(['暂停', '继续', '取消'])
  for (const label of ['暂停', '继续', '取消'])
    await action(await context_menu(mounted, rows[0]!.key), label)
  expect(mounted.model.uploads.pause.mock.calls).toEqual([['active']])
  expect(mounted.model.uploads.resume.mock.calls).toEqual([['paused'], ['failed']])
  expect(mounted.model.uploads.cancel.mock.calls).toEqual([['active'], ['paused'], ['failed']])
})
