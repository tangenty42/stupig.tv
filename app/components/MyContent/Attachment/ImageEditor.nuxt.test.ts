import type { ContentStoryAttachment } from '@shared/types/content'
import type { Ref } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { DOMWrapper, flushPromises } from '@vue/test-utils'
import Button from 'primevue/button'
import Select from 'primevue/select'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import ImageEditor from './ImageEditor.vue'

interface SessionState {
  working: Ref<boolean>
  exporting: Ref<boolean>
  loading: Ref<boolean>
  load_error: Ref<string>
  source_bitmap: Ref<{ width: number, height: number } | null>
  can_undo: Ref<boolean>
}

const mocks = vi.hoisted(() => ({ load: vi.fn(), confirm: vi.fn(), release: vi.fn(), exported: vi.fn(), undo: vi.fn(), session: null as SessionState | null }))
vi.mock('~/features/content/image-editor/session', async () => {
  const { ref } = await import('vue')
  return {
    useImageEditSession: (options: {
      on_ready: (size: { width: number, height: number }) => void
      on_save: (file: File) => void
    }) => {
      const state: SessionState = { working: ref(false), exporting: ref(false), loading: ref(false), load_error: ref(''), source_bitmap: ref({ width: 32, height: 24 }), can_undo: ref(false) }
      mocks.session = state
      return {
        ... state,
        natural_size: ref({ width: 32, height: 24 }),
        can_redo: ref(false), generation: 1,
        load_source: () => options.on_ready({ width: 32, height: 24 }),
        release_source: mocks.release, commit_action: vi.fn(), undo: mocks.undo, redo: vi.fn(),
        submit: () => {
          mocks.exported()
          options.on_save(new File(['pixels'], 'edited.png'))
        },
      }
    },
  }
})
mockNuxtImport('useApi', () => () => ({ content: { image_editor_source: mocks.load } }))
mockNuxtImport('useMyToast', () => () => ({ error: vi.fn() }))
mockNuxtImport('useMyConfirm', () => () => ({ confirm_require: mocks.confirm }))
// Canvas decoding/export has its own tests. Keep the real dialog, template,
// filename component and viewport while replacing only the bitmap session.

const wrappers: { unmount: () => void }[] = []
beforeEach(() => {
  vi.clearAllMocks()
  mocks.session = null
  mocks.load.mockResolvedValue({ display_url: '/view?role=display', original_url: '/view?role=original', original_reason: '' })
})
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))

async function open(stub_dialog = true) {
  const wrapper = await mountSuspended(ImageEditor, {
    attachTo: document.body,
    props: { visible: false, attachment: { id: 1, file_name: 'photo.png.good', url: '/read?version=v1' } as ContentStoryAttachment },
    global: { stubs: {
      MyDialog: stub_dialog ? { props: ['visible'], template: '<div v-if="visible"><slot /><slot name="footer" /></div>' } : false,
      MyIcon: true,
      transition: false,
    } },
  })
  wrappers.push(wrapper)
  await wrapper.setProps({ visible: true })
  await flushPromises()
  return wrapper
}

function save_button(wrapper: Awaited<ReturnType<typeof open>>) {
  return wrapper.findAllComponents(Button).find(button => button.props('label') === '保存')!
}

function listen_for_story_save() {
  const save = vi.fn()
  window.addEventListener('keydown', save)
  onTestFinished(() => window.removeEventListener('keydown', save))
  return save
}

function press_save(target: EventTarget, modifier: 'Ctrl' | 'Cmd' = 'Ctrl') {
  const event = new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: modifier === 'Ctrl', metaKey: modifier === 'Cmd', bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

it('shows each supported gesture hint as its own outlined badge', async () => {
  const wrapper = await open()
  const hints = wrapper.get('[aria-label="图片编辑手势"]').findAll('li > .badge-info-outlined')
  expect(hints.map(hint => hint.text())).toEqual(['Ctrl／⌘ + 滚轮缩放', 'Ctrl／⌘ 或空格 + 拖动平移', '双指缩放／平移'])
})

it('connects authorized loading, copy naming, confirmation and canvas export', async () => {
  const wrapper = await open()
  expect(mocks.load).toHaveBeenCalledWith(1, 'v1')
  wrapper.getComponent(Select).vm.$emit('update:modelValue', 'copy')
  await flushPromises()
  await wrapper.get('input[aria-label="新图片名称"]').setValue('')
  expect((save_button(wrapper).element as HTMLButtonElement).disabled).toBe(true)
  await save_button(wrapper).trigger('click')
  expect(mocks.confirm).not.toHaveBeenCalled()
  await wrapper.get('input[aria-label="新图片名称"]').setValue('new/name')
  expect((save_button(wrapper).element as HTMLButtonElement).disabled).toBe(false)
  expect(wrapper.get('[aria-label="固定后缀"]').text()).toBe('.webp')
  await wrapper.findAll('button').find(button => button.text() === '保存')!.trigger('click')
  expect(mocks.confirm).toHaveBeenCalledOnce()
  expect(mocks.confirm.mock.calls[0]![1]).toContain('另存')
  expect(mocks.exported).not.toHaveBeenCalled()
  mocks.confirm.mock.calls[0]![2]()
  expect(mocks.exported).toHaveBeenCalledOnce()
  expect(wrapper.emitted('save')?.at(- 1)).toEqual([expect.any(File), 'copy', 'new_name.webp', 'display'])
})

it('crossfades the loading state into the workspace and enables saving once ready', async () => {
  let finish!: (source: { display_url: string, original_url: string, original_reason: string }) => void
  mocks.load.mockReturnValueOnce(new Promise((resolve) => {
    finish = resolve
  }))
  const wrapper = await open()
  const spinner = wrapper.get('[role="status"]')
  expect(spinner.text()).toContain('正在加载图片')
  expect(wrapper.find('.image-editor-workspace').exists()).toBe(false)
  expect((save_button(wrapper).element as HTMLButtonElement).disabled).toBe(true)
  expect(save_button(wrapper).props('loading')).toBe(false)
  await save_button(wrapper).trigger('click')
  expect(mocks.confirm).not.toHaveBeenCalled()
  finish({ display_url: '/view?role=display', original_url: '/view?role=original', original_reason: '' })
  await flushPromises()
  expect(spinner.classes()).toContain('site-page-leave-active')
  const workspace = wrapper.get('.image-editor-workspace')
  expect(workspace.classes()).toContain('site-page-enter-active')
  expect(workspace.findAll('canvas')).toHaveLength(2)
  expect((save_button(wrapper).element as HTMLButtonElement).disabled).toBe(false)
  await vi.waitFor(() => expect(wrapper.find('[role="status"]').exists()).toBe(false))
})

it('keeps saving disabled after source loading fails', async () => {
  mocks.load.mockRejectedValueOnce(new Error('图片源加载失败'))
  const wrapper = await open()
  expect(wrapper.text()).toContain('图片源加载失败')
  expect((save_button(wrapper).element as HTMLButtonElement).disabled).toBe(true)
  expect(save_button(wrapper).props('loading')).toBe(false)
  await save_button(wrapper).trigger('click')
  expect(mocks.confirm).not.toHaveBeenCalled()
  expect(mocks.exported).not.toHaveBeenCalled()
})

it('shows the save spinner only while exporting and restores saving afterwards', async () => {
  const wrapper = await open()
  const select = wrapper.getComponent(Select)
  select.vm.$emit('update:modelValue', 'copy')
  await flushPromises()
  const name = wrapper.get('input[aria-label="新图片名称"]').element as HTMLInputElement
  expect(name.disabled).toBe(false)
  const session = mocks.session!
  session.working.value = true
  await flushPromises()
  expect((save_button(wrapper).element as HTMLButtonElement).disabled).toBe(true)
  expect(save_button(wrapper).props('loading')).toBe(false)

  session.exporting.value = true
  await flushPromises()
  expect((save_button(wrapper).element as HTMLButtonElement).disabled).toBe(true)
  expect(save_button(wrapper).props('loading')).toBe(true)
  expect(save_button(wrapper).classes()).toContain('p-button-loading')
  expect(select.props('disabled')).toBe(true)
  expect(name.disabled).toBe(true)
  select.vm.$emit('update:modelValue', 'redacted')
  await flushPromises()
  expect(select.props('modelValue')).toBe('copy')

  session.exporting.value = false
  session.working.value = false
  await flushPromises()
  expect((save_button(wrapper).element as HTMLButtonElement).disabled).toBe(false)
  expect(save_button(wrapper).props('loading')).toBe(false)
  expect(name.disabled).toBe(false)
})

it('does not export if the bitmap disappears while confirmation is open', async () => {
  const wrapper = await open()
  await save_button(wrapper).trigger('click')
  expect(mocks.confirm).toHaveBeenCalledOnce()
  mocks.session!.source_bitmap.value = null
  await flushPromises()
  expect((save_button(wrapper).element as HTMLButtonElement).disabled).toBe(true)
  mocks.confirm.mock.calls[0]![2]()
  expect(mocks.exported).not.toHaveBeenCalled()
  expect(wrapper.emitted('save')).toBeUndefined()
})

it('saves 作为删减版 under the source name without `.good`', async () => {
  const wrapper = await open()
  wrapper.getComponent(Select).vm.$emit('update:modelValue', 'redacted')
  await flushPromises()
  expect(wrapper.get('input').element.disabled).toBe(true)
  await wrapper.findAll('button').find(button => button.text() === '保存')!.trigger('click')
  mocks.confirm.mock.calls[0]![2]()
  expect(wrapper.emitted('save')?.at(- 1)).toEqual([expect.any(File), 'redacted', 'photo.png', 'display'])
})

it('closes from the dialog header and discards a waiting confirmation', async () => {
  const wrapper = await open(false)
  const dialog = new DOMWrapper(document.body).get('[role="dialog"]')
  expect(dialog.findAll('.p-dialog-footer button').map(button => button.text())).toEqual(['保存'])
  await dialog.get('button[aria-label="保存"]').trigger('click')
  expect(mocks.confirm).toHaveBeenCalledOnce()
  await dialog.get('.p-dialog-header button').trigger('click')
  expect(wrapper.emitted('update:visible')).toEqual([[false]])
  mocks.release.mockClear()
  await wrapper.setProps({ visible: false })
  mocks.confirm.mock.calls[0]![2]()
  expect(mocks.exported).not.toHaveBeenCalled()
  expect(wrapper.emitted('save')).toBeUndefined()
  expect(mocks.release).toHaveBeenCalled()
})

it.each(['Ctrl', 'Cmd'] as const)('uses %s+S from the filename field for image confirmation and releases it after closing', async (modifier) => {
  const story_save = listen_for_story_save()
  const wrapper = await open()
  wrapper.getComponent(Select).vm.$emit('update:modelValue', 'copy')
  await flushPromises()
  const name = wrapper.get('input[aria-label="新图片名称"]')
  await name.setValue('keyboard_copy')
  let confirmation_target: EventTarget | null = null
  mocks.confirm.mockImplementationOnce((event: Event) => {
    confirmation_target = event.currentTarget
  })
  const event = press_save(name.element, modifier)
  expect(event.defaultPrevented).toBe(true)
  expect(story_save).not.toHaveBeenCalled()
  expect(mocks.confirm).toHaveBeenCalledOnce()
  expect(mocks.confirm.mock.calls[0]![1]).toContain('另存')
  expect(confirmation_target).toBe(save_button(wrapper).element)
  expect(mocks.exported).not.toHaveBeenCalled()
  mocks.confirm.mock.calls[0]![2]()
  expect(mocks.exported).toHaveBeenCalledOnce()
  expect(wrapper.emitted('save')?.at(- 1)).toEqual([expect.any(File), 'copy', 'keyboard_copy.webp', 'display'])

  await wrapper.setProps({ visible: false })
  const closed_event = press_save(document.body, modifier)
  expect(closed_event.defaultPrevented).toBe(false)
  expect(story_save).toHaveBeenCalledExactlyOnceWith(closed_event)
  expect(mocks.confirm).toHaveBeenCalledOnce()
})

it.each(['loading', 'failed'] as const)('keeps the save shortcut inside the visible editor when its source is %s', async (phase) => {
  const story_save = listen_for_story_save()
  if (phase === 'loading')
    mocks.load.mockReturnValueOnce(new Promise(() => {}))
  else
    mocks.load.mockRejectedValueOnce(new Error('图片源加载失败'))
  await open()
  const event = press_save(document.body)
  expect(event.defaultPrevented).toBe(true)
  expect(story_save).not.toHaveBeenCalled()
  expect(mocks.confirm).not.toHaveBeenCalled()
  expect(mocks.exported).not.toHaveBeenCalled()
})

it('consumes the save shortcut while editing is busy or the copy name is blank and allows it after recovery', async () => {
  const story_save = listen_for_story_save()
  const wrapper = await open()
  mocks.session!.working.value = true
  await flushPromises()
  expect(press_save(document.body).defaultPrevented).toBe(true)
  expect(mocks.confirm).not.toHaveBeenCalled()

  mocks.session!.working.value = false
  wrapper.getComponent(Select).vm.$emit('update:modelValue', 'copy')
  await flushPromises()
  const name = wrapper.get('input[aria-label="新图片名称"]')
  await name.setValue('')
  expect(press_save(name.element).defaultPrevented).toBe(true)
  expect(mocks.confirm).not.toHaveBeenCalled()
  expect(mocks.exported).not.toHaveBeenCalled()
  expect(story_save).not.toHaveBeenCalled()

  await name.setValue('recovered')
  expect(press_save(name.element).defaultPrevented).toBe(true)
  expect(mocks.confirm).toHaveBeenCalledOnce()
  expect(story_save).not.toHaveBeenCalled()
})

it.each(['pointerup', 'pointercancel', 'lostpointercapture'] as const)('blocks save and undo during a crop drag and restores both after %s', async (end) => {
  const wrapper = await open()
  mocks.session!.can_undo.value = true
  await wrapper.findAllComponents(Button).find(button => button.props('label') === '重置')!.trigger('click')
  const canvas = wrapper.get<HTMLCanvasElement>('canvas[aria-label="图片编辑画布"]')
  const bounds = vi.spyOn(canvas.element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 32, 24))
  onTestFinished(() => bounds.mockRestore())
  const frame = wrapper.get<HTMLElement>('.redact-crop-frame')
  const handle = frame.get<HTMLElement>('span[style*="se-resize"]')
  await handle.trigger('pointerdown', { pointerId: 17, pointerType: 'mouse', button: 0, clientX: 32, clientY: 24 })
  await handle.trigger('pointermove', { pointerId: 17, pointerType: 'mouse', clientX: 16, clientY: 12 })
  expect(frame.element.style.width).toBe('16px')
  expect(frame.element.style.height).toBe('12px')

  expect(press_save(handle.element).defaultPrevented).toBe(true)
  handle.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }))
  expect(mocks.confirm).not.toHaveBeenCalled()
  expect(mocks.exported).not.toHaveBeenCalled()
  expect(mocks.undo).not.toHaveBeenCalled()

  handle.element.dispatchEvent(new PointerEvent(end, { pointerId: 17, pointerType: 'mouse', bubbles: true }))
  await flushPromises()
  expect(press_save(handle.element).defaultPrevented).toBe(true)
  expect(mocks.confirm).toHaveBeenCalledOnce()
  handle.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }))
  expect(mocks.undo).toHaveBeenCalledOnce()
})
