import { mountSuspended } from '@nuxt/test-utils/runtime'
import { DOMWrapper, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { reactive, ref } from 'vue'
import { set_content_attachment_drag_data, set_content_folder_drag_data } from '../internal/attachment-drag'

import Editor from './Editor.vue'

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  position_at_coords: vi.fn(),
  picks: vi.fn(),
}))
// CodeMirror, its view-state persistence and the browser file-entry adapters
// are the boundaries; the drop wiring under test is the real SFC.
vi.mock('./internal/editor', () => ({
  useStoryEditor: () => ({
    editor_ready: ref(true),
    issues: ref([]),
    search: reactive({ open: false }),
    jump_to_line: vi.fn(),
    insert_at_position: mocks.insert,
    apply_reference_changes: vi.fn(),
    validate: vi.fn(),
    capture_position: () => null,
    restore_position: vi.fn(),
    position_at_coords: mocks.position_at_coords,
  }),
}))
vi.mock('./internal/view-state', () => ({ useStoryEditorViewState: vi.fn() }))
vi.mock('../internal/upload-picks', () => ({ attachment_picks_from_data_transfer: (... args: unknown[]) => mocks.picks(... args) }))

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
  return body
    .findAll('button')
    .filter(button => ['编辑', '天子上朝', '微服私访'].includes(button.text().trim()))
    .map(button => ({ label: button.text().trim(), pressed: button.attributes('aria-pressed'), click: () => button.trigger('click') }))
}
async function fullscreen_button() {
  const body = new DOMWrapper(document.body)
  const button = body.findAll('button').find(button => ['全屏编辑', '退出全屏'].includes(button.attributes('aria-label') ?? ''))
  expect(button).toBeDefined()
  return button!
}

it('shares the preview audience across inline and fullscreen while keeping edit outside the fullscreen switch', async () => {
  const wrapper = await mount_editor()
  const mode = () => (wrapper.vm as unknown as { editor_mode: 'edit' | 'preview' }).editor_mode
  const audience = () => document.querySelector('.preview-stub')?.getAttribute('data-public')

  let buttons = await mode_buttons()
  expect(buttons.map(button => button.label)).toEqual(['编辑', '天子上朝', '微服私访'])
  expect(mode()).toBe('edit')
  expect(audience()).toBe('false')

  await buttons[2]!.click()
  expect(mode()).toBe('preview')
  expect(audience()).toBe('true')

  await (await fullscreen_button()).trigger('click')
  buttons = await mode_buttons()
  expect(buttons.map(button => button.label)).toEqual(['天子上朝', '微服私访'])
  expect(buttons[1]!.pressed).toBe('true')
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

it('inserts attachment and folder drags at the pointer position through the real drop handler', async () => {
  mocks.picks.mockResolvedValue([])
  mocks.position_at_coords.mockReturnValue(12)
  const wrapper = await mount_editor()

  const attachment = fake_data_transfer()
  set_content_attachment_drag_data({ dataTransfer: attachment } as unknown as DragEvent, { file_name: 'a.png', is_image: true, url: '/a.png' })
  await drop(wrapper, attachment)
  expect(mocks.insert).toHaveBeenCalledExactlyOnceWith('![](att://a.png)', 12)

  const folder = fake_data_transfer()
  set_content_folder_drag_data({ dataTransfer: folder } as unknown as DragEvent, 'cards')
  await drop(wrapper, folder)
  expect(mocks.insert).toHaveBeenLastCalledWith('[](att://cards)', 12)
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
