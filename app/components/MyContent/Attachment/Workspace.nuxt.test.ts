import type { ContentStoryAttachment } from '@shared/types/content'
import type { ContentDeleteImpact } from '@shared/types/content-delete-impact'
import type { ContentUploadSession } from '@shared/types/content-upload'
import type { useAttachmentPanel } from '~/features/content/attachments/panel'
import type { WorkspaceListRow } from '~/features/content/attachments/workspace-model'
import type { UploadPreparation } from '~/features/content/uploads/admission'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { DOMWrapper, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { get_content_attachment_drag_data, get_content_folder_drag_data } from '~/features/content/attachments/drag-transfer'
import { project_workspace_rows, workspace_capabilities } from '~/features/content/attachments/workspace-model'
import Workspace from './Workspace.vue'

const toast = vi.hoisted(() => ({ error: vi.fn(), ok: vi.fn(), info: vi.fn() }))
mockNuxtImport('useMyToast', () => () => toast)

const wrappers: { unmount: () => void }[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  document.body.innerHTML = ''
  Object.values(toast).forEach(mock => mock.mockClear())
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

async function mount(rows = [file(2), file(3), file(4)], options: { readonly?: boolean, can_private?: boolean, catalog?: boolean, loading?: boolean, error?: string | null, layout?: 'stack' | 'columns' } = {}) {
  // The business controller is the boundary. Workspace, List, Card, menus and
  // deletion confirmation stay real so events exercise their actual wiring.
  const model = reactive({
    rows, readonly: options.readonly ?? false, can_private: options.can_private ?? true, selected: new Set<string>(), expanded: new Set<number>(), drag_ids: [] as number[],
    get root_id(): number { return this.catalog.data?.root_id ?? 0 },
    get selected_rows(): WorkspaceListRow[] { return this.rows.filter(row => this.selected.has(row.key)) },
    catalog: { loading: options.loading ?? false, error: options.error ?? null, active: true, refresh: vi.fn(), data: options.catalog === false
      ? null
      : {
          nodes: rows.flatMap(row => row.node ? [row.node] : []), root_id: 1,
          attachments: rows.flatMap(row => row.node?.attachment ?? []),
          folders: rows.filter(row => row.node?.kind === 'folder').map(row => row.path),
        } },
    uploads: {
      identity_key: 'user:scope', preparations: [] as UploadPreparation[], admitting: false, admission_error: '',
      errors: new Map<string, string>(), progress: new Map(), active: new Set<string>(), queued: new Set<string>(),
      pause: vi.fn(), resume: vi.fn(async () => true), cancel: vi.fn(async () => {}),
    },
    capabilities: (row: WorkspaceListRow) => workspace_capabilities(row, { readonly: options.readonly ?? false, can_private: options.can_private ?? true, pending: false }),
    target: (row: WorkspaceListRow) => ({ id: row.node!.id, version: row.node!.version }),
    command_pending: () => false, command_moving: () => false, command_failed: () => false, can_execute: () => true,
    request_error: '', draft_markdown: '', pending: false,
    referenced_paths: null as ReadonlySet<string> | null,
    execute: vi.fn(async (_command: unknown) => {}),
    get_delete_impact: vi.fn(async (_targets: number[]): Promise<ContentDeleteImpact> => ({ targets: [], sources: [] })),
    open: vi.fn(), download: vi.fn(), preview: vi.fn(), start: vi.fn(), toggle_folder: vi.fn(),
  })
  const wrapper = await mountSuspended(Workspace, {
    attachTo: document.body,
    props: { controller: model as unknown as ReturnType<typeof useAttachmentPanel>, dialogs: false, layout: options.layout ?? 'columns' },
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

it.each([[false, 'columns'], [false, 'stack'], [true, 'columns'], [true, 'stack']] as const)('separates loading, failure, retry and recovered rows (readonly=%s, layout=%s)', async (readonly, layout) => {
  const mounted = await mount([], { readonly, layout, catalog: false, loading: true })
  expect(mounted.wrapper.find('[role="status"][aria-label="正在加载附件"]').exists()).toBe(true)
  expect(mounted.wrapper.findAll('.p-skeleton')).toHaveLength(3)
  expect(mounted.wrapper.text()).not.toContain('暂无附件~')

  mounted.model.catalog.loading = false
  mounted.model.catalog.error = '附件服务暂时不可用'
  await flushPromises()
  const alert = mounted.wrapper.get('[role="alert"]')
  expect(alert.text()).toBe('重新加载')
  expect(alert.find('[data-icon="lucide:rotate-cw"]').exists()).toBe(true)
  expect(alert.get('button').classes()).not.toContain('p-button-text')
  expect(alert.get('button').classes()).toEqual(expect.arrayContaining(['p-button-outlined', 'p-button-secondary', 'p-button-lg']))
  expect(alert.element.parentElement?.classList.contains('text-center')).toBe(true)
  expect(alert.classes()).toContain('pointer-events-auto')
  expect(mounted.wrapper.text()).not.toContain('附件服务暂时不可用')
  expect(mounted.wrapper.findAll('.p-skeleton')).toHaveLength(0)
  expect(mounted.wrapper.text()).not.toContain('暂无附件~')
  mounted.model.catalog.refresh.mockImplementationOnce(() => {
    mounted.model.catalog.loading = true
  })
  await mounted.wrapper.get('[role="alert"] button').trigger('click')
  await flushPromises()
  expect(mounted.model.catalog.refresh).toHaveBeenCalledOnce()
  expect(mounted.model.catalog.error).toBe('附件服务暂时不可用')
  expect(mounted.wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(mounted.wrapper.findAll('.p-skeleton')).toHaveLength(3)

  const recovered = file(2, 'recovered.txt')
  mounted.model.rows = [recovered]
  mounted.model.catalog.data = { root_id: 1, nodes: [recovered.node!], attachments: [recovered.node!.attachment!], folders: [] }
  mounted.model.catalog.loading = false
  mounted.model.catalog.error = null
  await flushPromises()
  expect(row_element(mounted, recovered.key).text()).toContain('recovered.txt')
  expect(mounted.wrapper.find('[role="alert"]').exists()).toBe(false)
  const menu = await context_menu(mounted, recovered.key)
  expect(menu.text()).toContain('复制 Markdown')
  expect(menu.text().includes('重命名')).toBe(! readonly)

  mounted.model.catalog.loading = true
  mounted.model.catalog.error = '刷新暂时失败'
  await flushPromises()
  expect(row_element(mounted, recovered.key).isVisible()).toBe(true)
  expect(mounted.wrapper.find('[role="status"]').exists()).toBe(false)
  expect(mounted.wrapper.find('[role="alert"]').exists()).toBe(false)
})

it('only shows the empty state for a confirmed empty catalog, including while refreshing it', async () => {
  const mounted = await mount([])
  expect(mounted.wrapper.text()).toContain('暂无附件~')
  mounted.model.catalog.loading = true
  mounted.model.catalog.error = '刷新暂时失败'
  await flushPromises()
  expect(mounted.wrapper.text()).toContain('暂无附件~')
  expect(mounted.wrapper.findAll('.p-skeleton')).toHaveLength(0)
  expect(mounted.wrapper.find('[role="alert"]').exists()).toBe(false)
})

it('keeps pending rows visible and offers a catalog retry alongside them', async () => {
  const pending = upload('pending')
  const mounted = await mount([pending], { catalog: false, loading: true })
  expect(row_element(mounted, pending.key).isVisible()).toBe(true)
  expect(mounted.wrapper.findAll('.p-skeleton')).toHaveLength(0)
  mounted.model.catalog.loading = false
  mounted.model.catalog.error = '附件目录加载失败'
  await flushPromises()
  expect(row_element(mounted, pending.key).isVisible()).toBe(true)
  expect(mounted.wrapper.get('[role="alert"]').text()).toBe('重新加载')
  expect(mounted.wrapper.text()).not.toContain('附件目录加载失败')
  await mounted.wrapper.get('[role="alert"] button').trigger('click')
  expect(mounted.model.catalog.refresh).toHaveBeenCalledOnce()
})

it('blocks creating a folder without a known root and restores its background menu after recovery', async () => {
  const mounted = await mount([], { catalog: false, error: '附件目录加载失败' })
  const background_menu = async () => {
    await mounted.wrapper.get('.file-list-root').trigger('contextmenu')
    await flushPromises()
    return new DOMWrapper(document.querySelector('.p-contextmenu')!)
  }
  const unavailable = await background_menu()
  const create_item = unavailable.findAll('[role="menuitem"]').find(item => item.text() === '新建文件夹')!
  expect(create_item.attributes('aria-disabled')).toBe('true')
  await action(unavailable, '新建文件夹')
  expect(mounted.wrapper.find('[role="dialog"][aria-label="新建文件夹"]').exists()).toBe(false)
  mounted.model.catalog.data = { root_id: 1, nodes: [], attachments: [], folders: [] }
  mounted.model.catalog.error = null
  await flushPromises()
  await action(await background_menu(), '新建文件夹')
  const input = mounted.wrapper.get('[role="dialog"][aria-label="新建文件夹"] input[aria-label="名称"]')
  await input.setValue('Recovered folder')
  await confirm(mounted, '新建文件夹', '确定')
  expect(mounted.model.execute).toHaveBeenCalledWith({ operation: 'create_folder', parent_id: 1, name: 'Recovered_folder' })
})

it.each([[false, '当前草稿未引用'], [true, '未引用']] as const)('updates the unused marker for the current snapshot (readonly=%s)', async (readonly, label) => {
  const mounted = await mount([file(2, 'cover.png'), file(3, 'note.txt')], { readonly })
  const selector = `[aria-label="${label}"]`
  expect(mounted.wrapper.find(selector).exists()).toBe(false)
  mounted.model.referenced_paths = new Set(['cover.png', 'note.txt'])
  await flushPromises()
  expect(mounted.wrapper.find(selector).exists()).toBe(false)
  mounted.model.referenced_paths = new Set(['cover.png'])
  await flushPromises()
  expect(row_element(mounted, 'node:3').get(selector).attributes('title')).toBe(label)
  expect(row_element(mounted, 'node:2').find(selector).exists()).toBe(false)
  mounted.model.referenced_paths = null
  await flushPromises()
  expect(mounted.wrapper.find(selector).exists()).toBe(false)
})

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
  expect(dialog.find('button[aria-label="取消"]').exists()).toBe(false)
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

it('disables creating a folder whose name is already taken in the target folder', async () => {
  const parent = folder(2, 'docs')
  const child: WorkspaceListRow = { key: 'node:3', path: 'docs/inner', name: 'inner', parent_id: 2, depth: 1,
    node: { id: 3, parent_id: 2, name: 'inner', path: 'docs/inner', kind: 'folder', version: 'v' } }
  const taken_name: WorkspaceListRow = { key: 'node:4', path: 'docs/taken.txt', name: 'taken.txt', parent_id: 2, depth: 1,
    node: { id: 4, parent_id: 2, name: 'taken.txt', path: 'docs/taken.txt', kind: 'file', version: 'v' } }
  const mounted = await mount([parent, child, taken_name])
  await action(await context_menu(mounted, parent.key), '新建文件夹')
  const input = mounted.wrapper.get('[role="dialog"][aria-label="新建文件夹"] input[aria-label="名称"]')
  const submit = mounted.wrapper.findAll('[role="dialog"][aria-label="新建文件夹"] button').find(button => button.text() === '确定')!
  await input.setValue('INNER')
  expect(submit.attributes('disabled')).toBeDefined()
  await input.setValue('taken.txt')
  expect(submit.attributes('disabled')).toBeDefined()
  await input.setValue('other')
  expect(submit.attributes('disabled')).toBeUndefined()
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

it('asks once before copying a mixed selection and drags the same item paths from any selected row', async () => {
  const rows = [folder(2, 'docs'), file(3, 'image.png', { is_image: true, mime_type: 'image/png' }), file(4, 'note.txt'), file(5, 'private.pdf.good', { is_private: true, url: null })]
  const write = vi.fn().mockResolvedValue(undefined)
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
  const mounted = await mount(rows)
  try {
    for (const row of rows)
      await row_element(mounted, row.key).trigger('click', { ctrlKey: true })
    const expected = '<carousel>\n  [](att://docs)\n  ![](att://image.png)\n  [](att://note.txt)\n  [](att://private.pdf.good)\n</carousel>'
    for (const origin of rows) {
      write.mockClear()
      toast.ok.mockClear()
      await action(await context_menu(mounted, origin.key), '复制 Markdown')
      expect(write).not.toHaveBeenCalled()
      expect(toast.ok).not.toHaveBeenCalled()
      expect(mounted.wrapper.findAll('[role="dialog"][aria-label="选择文件夹展开方式"]')).toHaveLength(1)
      await confirm(mounted, '选择文件夹展开方式', '仅文件夹')
      expect(write).toHaveBeenCalledExactlyOnceWith(expected)
      expect(toast.ok).toHaveBeenCalledExactlyOnceWith('已复制 Markdown')
      const transfer = fake_data_transfer()
      await row_element(mounted, origin.key).trigger('dragstart', { dataTransfer: transfer })
      expect(transfer.effectAllowed).toBe('copyMove')
      expect(mounted.model.drag_ids).toEqual([2, 3, 4, 5])
      if (origin.node?.kind === 'folder')
        expect(get_content_folder_drag_data(transfer as unknown as DataTransfer)).toMatchObject({ folder: 'docs', file_names: ['docs', 'image.png', 'note.txt', 'private.pdf.good'] })
      else
        expect(get_content_attachment_drag_data(transfer as unknown as DataTransfer)).toMatchObject({ file_name: origin.name, file_names: ['docs', 'image.png', 'note.txt', 'private.pdf.good'] })
    }

    // Dragging an unselected row hands the drag its own selection.
    const single = fake_data_transfer()
    await row_element(mounted, rows[1]!.key).trigger('click')
    await row_element(mounted, rows[1]!.key).trigger('dragstart', { dataTransfer: single })
    expect([... mounted.model.selected]).toEqual([rows[1]!.key])
    expect(get_content_attachment_drag_data(single as unknown as DataTransfer)).toMatchObject({ file_name: 'image.png', file_names: ['image.png'] })
    write.mockClear()
    toast.ok.mockClear()
    await action(await context_menu(mounted, rows[1]!.key), '复制 Markdown')
    expect(write).toHaveBeenCalledExactlyOnceWith('![](att://image.png)')
    expect(toast.ok).toHaveBeenCalledExactlyOnceWith('已复制 Markdown')
    expect(mounted.wrapper.find('[role="dialog"][aria-label="选择文件夹展开方式"]').exists()).toBe(false)
    toast.ok.mockClear()
    write.mockRejectedValueOnce(new Error('Clipboard denied'))
    await action(await context_menu(mounted, rows[1]!.key), '复制 Markdown')
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('无法复制 Markdown')
    expect(toast.ok).not.toHaveBeenCalled()
  }
  finally {
    if (clipboard)
      Object.defineProperty(navigator, 'clipboard', clipboard)
    else
      Reflect.deleteProperty(navigator, 'clipboard')
  }
})

it.each([
  { mode: '展开直属文件', include_file: false },
  { mode: '展开直属图片', include_file: true },
])('skips empty folders silently when copying with $mode, include file: $include_file', async ({ mode, include_file }) => {
  const empty_folder = folder(2, 'docs')
  const rows = include_file ? [empty_folder, file(3, 'note.txt')] : [empty_folder]
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  const mounted = await mount(rows)
  for (const row of rows)
    await row_element(mounted, row.key).trigger('click', { ctrlKey: true })
  await action(await context_menu(mounted, empty_folder.key), '复制 Markdown')
  await confirm(mounted, '选择文件夹展开方式', mode)

  expect(toast.info).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
  if (include_file) {
    expect(write).toHaveBeenCalledExactlyOnceWith('[](att://note.txt)')
    expect(toast.ok).toHaveBeenCalledExactlyOnceWith('已复制 Markdown')
  }
  else {
    expect(write).not.toHaveBeenCalled()
    expect(toast.ok).not.toHaveBeenCalled()
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

it.each([true, false])('keeps the read-only menu of a private image free of 删减版 actions (has 删减版: %s)', async (has_redacted) => {
  const row = file(2, 'photo.png.good', { is_image: true, mime_type: 'image/webp', is_private: true, url: null, has_redacted, is_redacted_view: has_redacted, redacted_url: has_redacted ? '/redacted' : null })
  const mounted = await mount([row], { readonly: true, can_private: false })
  const menu = await context_menu(mounted, row.key)
  expect(menu.findAll('[role="menuitem"]').filter(item => item.attributes('aria-disabled') === 'true')).toHaveLength(2)
  expect(menu.text()).not.toContain('删减版')
  expect(menu.text()).not.toContain('下载原图')
  expect(menu.text()).not.toContain('重命名')
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

it('switches the single move destination between sibling folders and submits the last choice', async () => {
  const source = file(2)
  const mounted = await mount([source, folder(9, 'first'), folder(10, 'second')])
  await action(await context_menu(mounted, source.key), '移动')
  const picker = mounted.wrapper.get('[aria-label="目标目录"]')
  const first = picker.get('[data-row-key="node:9"]')
  const second = picker.get('[data-row-key="node:10"]')
  const selected = () => picker.findAll('.folder-row-selected').map(row => row.attributes('data-row-key'))

  await first.trigger('click', { ctrlKey: true })
  expect(selected()).toEqual(['node:9'])
  await second.trigger('click', { ctrlKey: true })
  expect(selected()).toEqual(['node:10'])
  await first.trigger('click', { metaKey: true })
  expect(selected()).toEqual(['node:9'])
  await second.trigger('click', { shiftKey: true })
  expect(selected()).toEqual(['node:10'])
  await first.trigger('keydown.enter')
  expect(selected()).toEqual(['node:9'])
  const touch = { identifier: 1, clientX: 100, clientY: 20 }
  await second.trigger('touchstart', { touches: { length: 1, item: () => touch } })
  await second.trigger('touchmove', { touches: [{ identifier: 1, clientX: 30, clientY: 20 }] })
  await second.trigger('touchend')
  expect(selected()).toEqual(['node:10'])

  await confirm(mounted, '移动', '移动')
  expect(mounted.model.execute).toHaveBeenCalledExactlyOnceWith({ operation: 'move', targets: [mounted.model.target(source)], parent_id: 10 })
})

it('switches the move destination when a Ctrl marquee reaches just one other folder', async () => {
  const source = file(2)
  const mounted = await mount([source, folder(9, 'first'), folder(10, 'second')])
  await action(await context_menu(mounted, source.key), '移动')
  const picker = mounted.wrapper.get('[aria-label="目标目录"]')
  const [root, first, second] = picker.findAll('[data-row-key]')
  vi.spyOn(root!.element, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 0, 50, 20))
  vi.spyOn(first!.element, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 25, 50, 20))
  vi.spyOn(second!.element, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 50, 50, 20))
  await first!.trigger('click', { ctrlKey: true })
  await picker.trigger('pointerdown', { button: 0, isPrimary: true, pointerId: 7, clientX: 0, clientY: 75, ctrlKey: true })
  window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: 65, clientY: 20, ctrlKey: true }))
  await flushPromises()
  expect(picker.get('.folder-row-selected').attributes('data-row-key')).toBe('node:9')
  window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: 65, clientY: 48, ctrlKey: true }))
  window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7 }))
  await flushPromises()
  expect(picker.findAll('.folder-row-selected').map(row => row.attributes('data-row-key'))).toEqual(['node:10'])
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
    readonly_file: ['download', 'copy'], readonly_folder: ['copy'], upload_batch: ['play', '|', 'x'],
  }
  const entries = [... document.querySelectorAll('.p-contextmenu [role="menuitem"], .p-contextmenu [role="separator"]')]
  expect(entries.map(item => item.getAttribute('role') === 'separator' ? '|' : item.querySelector('[data-icon]')?.getAttribute('data-icon')?.replace('lucide:', ''))).toEqual(expected[scenario])
})

it('deletes a private image through the ordinary confirmation only', async () => {
  const row = file(2, 'photo.png.good', { is_image: true, mime_type: 'image/webp', is_private: true, has_redacted: true })
  const mounted = await mount([row])
  expect((await context_menu(mounted, row.key)).text()).not.toContain('删减版')
  await action(await context_menu(mounted, row.key), '删除')
  expect(mounted.model.get_delete_impact).toHaveBeenCalledWith([2])
  expect(mounted.model.execute).not.toHaveBeenCalled()
  await confirm(mounted, '空城计？', '仍然删除')
  expect(mounted.model.execute).toHaveBeenLastCalledWith({ operation: 'delete', targets: [mounted.model.target(row)] })
})

it('keeps the attachment delete entry pending until references arrive and confirms the original targets', async () => {
  const mounted = await mount()
  const impact = Promise.withResolvers<ContentDeleteImpact>()
  mounted.model.get_delete_impact.mockReturnValueOnce(impact.promise)
  const dialog = '[role="dialog"][aria-label="空城计？"]'

  await action(await context_menu(mounted, 'node:2'), '删除')
  expect(mounted.model.get_delete_impact).toHaveBeenCalledExactlyOnceWith([2])
  expect(mounted.wrapper.find(dialog).exists()).toBe(false)
  expect(row_element(mounted, 'node:2').find('[data-icon="lucide:loader-circle"].animate-spin').exists()).toBe(true)
  expect(row_element(mounted, 'node:3').find('[data-icon="lucide:loader-circle"].animate-spin').exists()).toBe(false)

  const menu = await context_menu(mounted, 'node:3')
  expect(mounted.model.selected).toEqual(new Set(['node:3']))
  const checking = menu.findAll('[role="menuitem"]').find(item => item.text() === '检查引用中')
  expect(checking?.attributes('aria-disabled')).toBe('true')
  expect(checking?.find('[data-icon="lucide:loader-circle"].animate-spin').exists()).toBe(true)
  await action(menu, '检查引用中')
  expect(mounted.model.get_delete_impact).toHaveBeenCalledTimes(1)
  mounted.model.rows[0]!.node!.version = 'new'

  impact.resolve({ targets: [{ path: '2.txt', kind: 'file' }], sources: [] })
  await flushPromises()
  expect(row_element(mounted, 'node:2').find('[data-icon="lucide:loader-circle"].animate-spin').exists()).toBe(false)
  expect(mounted.model.selected).toEqual(new Set(['node:2']))
  expect(mounted.model.execute).not.toHaveBeenCalled()
  await confirm(mounted, '空城计？', '仍然删除')
  expect(mounted.model.execute).toHaveBeenCalledExactlyOnceWith({ operation: 'delete', targets: [{ id: 2, version: 'v' }] })
})

it('toasts a failed attachment reference check and retries from the delete entry', async () => {
  const mounted = await mount()
  mounted.model.get_delete_impact.mockRejectedValueOnce(new Error('暂时不可用'))

  await action(await context_menu(mounted, 'node:2'), '删除')
  expect(toast.error).toHaveBeenCalledExactlyOnceWith('引用检查失败，请重试后再删除')
  expect(mounted.wrapper.find('[aria-label="空城计？"]').exists()).toBe(false)
  expect(mounted.model.execute).not.toHaveBeenCalled()

  await action(await context_menu(mounted, 'node:2'), '删除')
  expect(mounted.model.get_delete_impact).toHaveBeenCalledTimes(2)
  expect(mounted.wrapper.find('[aria-label="空城计？"]').exists()).toBe(true)
})

it('discards an attachment reference response after the workspace identity changes', async () => {
  const mounted = await mount()
  const impact = Promise.withResolvers<ContentDeleteImpact>()
  mounted.model.get_delete_impact.mockReturnValueOnce(impact.promise)

  await action(await context_menu(mounted, 'node:2'), '删除')
  mounted.model.uploads.identity_key = 'other:scope'
  impact.resolve({ targets: [{ path: '2.txt', kind: 'file' }], sources: [] })
  await flushPromises()
  expect(mounted.wrapper.find('[aria-label="空城计？"]').exists()).toBe(false)
  expect(toast.error).not.toHaveBeenCalled()

  await action(await context_menu(mounted, 'node:3'), '删除')
  expect(mounted.model.get_delete_impact).toHaveBeenLastCalledWith([3])
  await confirm(mounted, '空城计？', '仍然删除')
  expect(mounted.model.execute).toHaveBeenCalledExactlyOnceWith({ operation: 'delete', targets: [{ id: 3, version: 'v' }] })
})

it.each([true, false].flatMap(desired => ['file', 'folder', 'mixed'].map(kind => ({ desired, kind }))))('submits $desired privacy for changing $kind targets and excludes unchanged or busy rows', async ({ desired, kind }) => {
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
  // The server determines which consequences need confirmation.
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

it('lets the user choose files again after a preparation read failed', async () => {
  const mounted = await mount([])
  mounted.model.uploads.preparations.push({ id: 'image', path: 'photo.png', loaded: 0, size: 100, phase: 'waiting' })
  const add = mounted.wrapper.get<HTMLButtonElement>('button[aria-label="添加"]')
  await flushPromises()
  expect(add.element.disabled).toBe(true)
  mounted.model.uploads.preparations[0]!.phase = 'failed'
  await flushPromises()
  expect(add.element.disabled).toBe(false)
})

it.each([
  { purpose: 'replace', label: '替换' },
  { purpose: 'replace', image_overwrite: true, label: '图片替换' },
  { purpose: 'create', image_save_as: true, label: '图片另存' },
] as const)('shows $label through preparation, processing and failure', async ({ label, ... intent }) => {
  const preparation: UploadPreparation = { id: 'pending', path: 'new.png', size: 10, loaded: 0, phase: 'waiting', source_id: 2, ... intent }
  const session = { ... upload('pending').session!, path: 'photo.png', source_id: 3, image_status: 'processing', ... intent }
  const ordinary = { ... upload('ordinary').session!, path: 'ordinary.png', purpose: 'create' as const, image_status: 'processing' }
  const nodes = [file(2, 'old.png').node!, file(3, 'photo.png').node!]
  const mounted = await mount(project_workspace_rows(nodes, [session, ordinary], 1, new Set(), [preparation]))

  const waiting = row_element(mounted, 'preparing:pending').get(`[title="${label} 等待受理"]`)
  expect(waiting.text()).toBe(`${label} 等待受理`)
  expect(waiting.get('.text-primary').text()).toBe(label)
  const processing = row_element(mounted, 'session:pending').get(`[title="${label} 服务器处理中"]`)
  expect(processing.get('.text-primary').text()).toBe(label)
  expect(row_element(mounted, 'session:ordinary').get('[title="服务器处理中"]').text()).toBe('服务器处理中')

  mounted.model.uploads.errors.set('pending', '文件不可读取')
  await flushPromises()
  const failed = row_element(mounted, 'session:pending').get(`[title="${label} 上传失败：文件不可读取"]`)
  expect(failed.classes()).toContain('text-red-600')
  expect(failed.get('.text-primary').text()).toBe(label)
})

it('shows admission failures in preparation rows while preserving file and session errors', async () => {
  const preparations: UploadPreparation[] = [
    { id: 'missing', path: 'missing.txt', size: 10, loaded: 0, phase: 'admitting' },
    { id: 'empty', path: 'empty.txt', size: 10, loaded: 0, phase: 'admitting', error: '' },
    { id: 'blank', path: 'blank.txt', size: 10, loaded: 0, phase: 'admitting', error: ' \n ' },
    { id: 'specific', path: 'specific.txt', size: 10, loaded: 0, phase: 'failed', error: '原文件无法读取' },
  ]
  const mounted = await mount([... project_workspace_rows([], [], 1, new Set(), preparations), upload('session')])
  mounted.model.uploads.preparations = preparations
  mounted.model.uploads.admission_error = '上传受理服务暂时不可用'
  mounted.model.uploads.errors.set('session', '上传连接已中断')
  await flushPromises()

  for (const id of ['missing', 'empty', 'blank']) {
    const row = row_element(mounted, `preparing:${id}`)
    const message = '准备失败：上传受理服务暂时不可用'
    expect(row.text()).toContain(message)
    expect(row.get(`[title="${message}"]`).text()).toBe(message)
  }
  const specific = row_element(mounted, 'preparing:specific')
  expect(specific.get('[title="准备失败：原文件无法读取"]').text()).toBe('准备失败：原文件无法读取')
  expect(specific.text()).not.toContain('上传受理服务暂时不可用')
  const session = row_element(mounted, 'session:session')
  expect(session.get('[title="上传失败：上传连接已中断"]').text()).toBe('上传失败：上传连接已中断')
  expect(session.text()).not.toContain('上传受理服务暂时不可用')

  mounted.model.uploads.admission_error = ''
  await flushPromises()
  expect(row_element(mounted, 'preparing:missing').text()).toContain('正在确认上传')
  expect(row_element(mounted, 'preparing:missing').text()).not.toContain('准备失败')
  expect(specific.text()).toContain('准备失败：原文件无法读取')
  expect(session.text()).toContain('上传失败：上传连接已中断')
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

it('offers 重试 for a single failed upload', async () => {
  const mounted = await mount([upload('failed')])
  mounted.model.uploads.errors.set('failed', '上传未完成')
  await action(await context_menu(mounted, 'session:failed'), '重试')
  expect(mounted.model.uploads.resume.mock.calls).toEqual([['failed']])
})

it('offers 重试 for a batch of failed uploads', async () => {
  const rows = ['failed', 'failed-again'].map(upload)
  const mounted = await mount(rows)
  for (const row of rows) {
    mounted.model.uploads.errors.set(row.session!.id, '上传未完成')
    await row_element(mounted, row.key).trigger('click', { ctrlKey: true })
  }
  expect([... mounted.model.selected]).toEqual(rows.map(row => row.key))
  await action(await context_menu(mounted, 'session:failed'), '重试')
  expect(mounted.model.uploads.resume.mock.calls).toEqual([['failed'], ['failed-again']])
})
