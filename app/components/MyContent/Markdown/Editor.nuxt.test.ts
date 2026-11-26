import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { DOMWrapper, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { reactive, ref } from 'vue'
import { set_content_attachment_drag_data, set_content_folder_drag_data } from '~/features/content/attachments/drag-transfer'

import Editor from './Editor.vue'

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  position_at_coords: vi.fn(),
  picks: vi.fn(),
  info: vi.fn(),
}))
mockNuxtImport('useMyToast', () => () => ({ info: mocks.info }))
// CodeMirror, its view-state persistence and the browser file-entry adapters
// are the boundaries; the drop wiring under test is the real SFC.
vi.mock('~/features/content/markdown/editor', () => ({
  useStoryEditor: () => ({
    editor_ready: ref(true),
    issues: ref([]),
    search: reactive({ open: false }),
    jump_to_line: vi.fn(),
    insert_at_position: mocks.insert,
    track_upload_insertion: (position: number) => (markdown: string) => mocks.insert(markdown, position),
    track_attachment_insertion: (position: number) => (items: readonly string[]) => mocks.insert(items, position),
    apply_reference_changes: vi.fn(),
    validate: vi.fn(),
    capture_position: () => null,
    restore_position: vi.fn(),
    position_at_coords: mocks.position_at_coords,
  }),
}))
vi.mock('~/features/content/markdown/view-state', () => ({ useStoryEditorViewState: vi.fn() }))
vi.mock('~/features/content/uploads/browser-picks', () => ({ attachment_picks_from_data_transfer: (... args: unknown[]) => mocks.picks(... args) }))

const wrappers: { unmount: () => void, setProps: (props: Record<string, unknown>) => Promise<void> }[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

async function mount_editor(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(Editor, {
    attachTo: document.body,
    props,
    global: { stubs: { MyIcon: { props: ['name'], template: '<span :data-icon="name" />' }, MyContentMarkdownPreview: { props: ['markdown', 'publicView'], template: '<div class="preview-stub" :data-public="String(publicView)" />' }, MyContentMarkdownEditorSearchPanel: true } },
  })
  wrappers.push(wrapper)
  return wrapper
}

/** Minimal DataTransfer stand-in; the drop path only reads these members. */
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

async function drop(wrapper: Awaited<ReturnType<typeof mount_editor>>, transfer: unknown) {
  await wrapper.get('.editor-text-pane').trigger('drop', { dataTransfer: transfer })
  await flushPromises()
}

/** The mode buttons and their aria-pressed state, in toolbar order. */
async function mode_buttons() {
  const body = new DOMWrapper(document.body)
  await flushPromises()
  return body.findAll('[aria-label="编辑器模式"] button')
    .map(button => ({ pressed: button.attributes('aria-pressed'), click: () => button.trigger('click') }))
}
async function fullscreen_button() {
  const body = new DOMWrapper(document.body)
  const button = body.findAll('button').find(button => ['全屏编辑', '退出全屏'].includes(button.attributes('aria-label') ?? ''))
  expect(button).toBeDefined()
  return button!
}

it('shares the preview audience across inline and fullscreen while keeping edit outside the fullscreen switch', async () => {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
  const matches = vi.spyOn(preference, 'matches', 'get').mockReturnValue(true)
  const match_media = vi.spyOn(window, 'matchMedia').mockReturnValue(preference)
  onTestFinished(() => {
    match_media.mockRestore()
    matches.mockRestore()
  })
  const wrapper = await mount_editor()
  const mode = () => (wrapper.vm as unknown as { editor_mode: 'edit' | 'preview' }).editor_mode
  const audience = () => document.querySelector('.preview-stub')?.getAttribute('data-public')

  let buttons = await mode_buttons()
  expect(buttons.map(button => button.pressed)).toEqual(['true', 'false', 'false'])
  expect(mode()).toBe('edit')
  expect(audience()).toBe('false')

  await buttons[2]!.click()
  expect(mode()).toBe('preview')
  expect(audience()).toBe('true')

  await (await fullscreen_button()).trigger('click')
  buttons = await mode_buttons()
  expect(buttons.map(button => button.pressed)).toEqual(['false', 'true'])
  expect(audience()).toBe('true')

  await buttons[0]!.click()
  expect(audience()).toBe('false')
  await (await fullscreen_button()).trigger('click')
  expect(mode()).toBe('preview')
  expect(audience()).toBe('false')

  const edit_buttons = await mode_buttons()
  await edit_buttons[0]!.click()
  expect(mode()).toBe('edit')

  await (await fullscreen_button()).trigger('click')
  expect(audience()).toBe('false')
  // In fullscreen the mode switch only changes the audience; the edit column
  // stays mounted behind it.
  const audience_buttons = await mode_buttons()
  await audience_buttons[1]!.click()
  expect(mode()).toBe('edit')
  expect(audience()).toBe('true')
  await (await fullscreen_button()).trigger('click')
  expect(mode()).toBe('edit')
  expect(audience()).toBe('true')
})

it('moves the same mounted editor into and out of fullscreen during the view transition', async () => {
  let update: () => Promise<void>
  let finish: () => void
  const start = vi.fn((callback: () => Promise<void>) => {
    update = callback
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    return { ready: Promise.resolve(), finished, skipTransition: vi.fn() }
  })
  const descriptor = Object.getOwnPropertyDescriptor(document, 'startViewTransition')
  Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start })
  onTestFinished(() => {
    if (descriptor)
      Object.defineProperty(document, 'startViewTransition', descriptor)
    else
      Reflect.deleteProperty(document, 'startViewTransition')
  })
  const wrapper = await mount_editor()
  const text_pane = wrapper.get('.editor-text-pane').element

  await (await fullscreen_button()).trigger('click')
  expect(start).toHaveBeenCalledOnce()
  expect(document.querySelector('.editor-fullscreen')).toBeNull()
  await update!()
  expect(document.querySelector('.editor-fullscreen .editor-text-pane')).toBe(text_pane)
  finish!()
  await flushPromises()

  await (await fullscreen_button()).trigger('click')
  expect(start).toHaveBeenCalledTimes(2)
  expect(document.querySelector('.editor-fullscreen .editor-text-pane')).toBe(text_pane)
  await update!()
  expect(document.querySelector('.editor-fullscreen')).toBeNull()
  expect(wrapper.get('.editor-text-pane').element).toBe(text_pane)
  finish!()
  await flushPromises()
})

it('inserts a dragged file immediately at the pointer position', async () => {
  mocks.picks.mockResolvedValue([])
  mocks.position_at_coords.mockReturnValue(12)
  const wrapper = await mount_editor()

  const attachment = fake_data_transfer()
  set_content_attachment_drag_data({ dataTransfer: attachment } as unknown as DragEvent, { file_name: 'a.png', is_image: true, url: '/a.png' })
  await drop(wrapper, attachment)
  expect(mocks.insert).toHaveBeenCalledExactlyOnceWith(['![](att://a.png)'], 12)

  expect(new DOMWrapper(document.body).find('[role="dialog"][aria-label="选择文件夹展开方式"]').exists()).toBe(false)
  expect(mocks.picks).not.toHaveBeenCalled()
})

it('expands all selected folders once at the captured drop position and reports folders without images', async () => {
  mocks.position_at_coords.mockReturnValue(12)
  const files = ['cards/1.png', 'cards/note.txt', 'cards/sub/2.png', 'note.txt'].map(file_name => ({
    file_name, is_image: file_name.endsWith('.png'), mime_type: null, file_size: 1, url: null, version: 'v',
  }))
  const wrapper = await mount_editor({ attachments: files, folders: ['cards', 'cards/sub', 'empty'] })
  const transfer = fake_data_transfer()
  set_content_folder_drag_data({ dataTransfer: transfer } as unknown as DragEvent, 'cards', ['cards', 'empty', 'note.txt'])
  await drop(wrapper, transfer)
  expect(mocks.insert).not.toHaveBeenCalled()
  const dialog = new DOMWrapper(document.body).get('[role="dialog"][aria-label="选择文件夹展开方式"]')
  mocks.position_at_coords.mockReturnValue(99)
  await dialog.get('button[aria-label="展开直属图片"]').trigger('click')
  expect(mocks.insert).toHaveBeenCalledExactlyOnceWith(['![](att://cards/1.png)', '[](att://note.txt)'], 12)
  expect(mocks.info).toHaveBeenCalledExactlyOnceWith('没有直属图片：empty')
})

it('emits dropped files for a file drop instead of inserting a reference', async () => {
  mocks.picks.mockResolvedValue([{ file: new File(['x'], 'x.txt'), file_name: 'x.txt' }])
  mocks.position_at_coords.mockReturnValue(3)
  const wrapper = await mount_editor()
  await drop(wrapper, fake_data_transfer())
  expect(mocks.insert).not.toHaveBeenCalled()
  expect(wrapper.emitted('files-dropped')).toEqual([[[{ file: expect.any(File), file_name: 'x.txt' }], 3]])
})

it('rejects a drop that finishes reading files after the editor turns read-only', async () => {
  let finish!: (picks: { file_name: string }[]) => void
  mocks.picks.mockImplementation(() => new Promise((resolve) => {
    finish = resolve as typeof finish
  }))
  const wrapper = await mount_editor()
  await wrapper.get('.editor-text-pane').trigger('drop', { dataTransfer: fake_data_transfer() })
  await wrapper.setProps({ readonly: true })
  finish([{ file_name: 'a.txt' }])
  await flushPromises()
  expect(wrapper.emitted('files-dropped')).toBeUndefined()
  expect(mocks.insert).not.toHaveBeenCalled()
})
