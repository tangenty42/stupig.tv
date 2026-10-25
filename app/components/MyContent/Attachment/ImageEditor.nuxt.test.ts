import type { ContentStoryAttachment } from '@shared/types/content'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import Select from 'primevue/select'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import ImageEditor from './ImageEditor.vue'

const mocks = vi.hoisted(() => ({ load: vi.fn(), confirm: vi.fn(), release: vi.fn(), exported: vi.fn() }))
mockNuxtImport('useApi', () => () => ({ content: { image_editor_source: mocks.load } }))
mockNuxtImport('useMyToast', () => () => ({ error: vi.fn() }))
mockNuxtImport('useMyConfirm', () => () => ({ confirm_require: mocks.confirm }))
// Canvas decoding/export has its own tests. Keep the real dialog, template,
// filename component and viewport while replacing only the bitmap session.
mockNuxtImport('useImageEditSession', () => (options: {
  on_ready: (size: { width: number, height: number }) => void
  on_save: (file: File) => void
}) => ({
  working: ref(false), loading: ref(false), load_error: ref(''),
  natural_size: ref({ width: 32, height: 24 }), source_bitmap: ref({ width: 32, height: 24 }),
  can_undo: ref(false), can_redo: ref(false), generation: 1,
  load_source: () => options.on_ready({ width: 32, height: 24 }),
  release_source: mocks.release, commit_action: vi.fn(), undo: vi.fn(), redo: vi.fn(),
  submit: () => {
    mocks.exported()
    options.on_save(new File(['pixels'], 'edited.png'))
  },
}))

const wrappers: { unmount: () => void }[] = []
beforeEach(() => {
  vi.clearAllMocks()
  mocks.load.mockResolvedValue({ avif_url: '/view?role=avif', original_url: '/view?role=original', original_reason: '' })
})
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))

async function open(redacted = false) {
  const wrapper = await mountSuspended(ImageEditor, {
    props: { visible: false, redacted, attachment: { id: 1, file_name: 'photo.png.good', url: '/read?version=v1' } as ContentStoryAttachment },
    global: { stubs: { MyDialog: { props: ['visible'], template: '<div v-if="visible"><slot /><slot name="footer" /></div>' }, MyIcon: true } },
  })
  wrappers.push(wrapper)
  await wrapper.setProps({ visible: true })
  await flushPromises()
  return wrapper
}

it('connects authorized loading, copy naming, confirmation and canvas export', async () => {
  const wrapper = await open()
  expect(mocks.load).toHaveBeenCalledWith(1, 'v1', false)
  wrapper.getComponent(Select).vm.$emit('update:modelValue', 'copy')
  await flushPromises()
  await wrapper.get('input[aria-label="新图片名称"]').setValue('new/name')
  expect(wrapper.get('[aria-label="固定后缀"]').text()).toBe('.avif')
  await wrapper.findAll('button').find(button => button.text() === '保存')!.trigger('click')
  expect(mocks.confirm.mock.calls[0]![1]).toBe('将另存为新图，确认保存？')
  mocks.confirm.mock.calls[0]![2]()
  expect(mocks.exported).toHaveBeenCalledOnce()
  expect(wrapper.emitted('save')?.at(- 1)).toEqual([expect.any(File), 'copy', 'new_name.avif', 'avif'])
})

it('keeps redacted saving directed to the original attachment', async () => {
  const wrapper = await open(true)
  expect(mocks.load).toHaveBeenCalledWith(1, 'v1', true)
  expect(wrapper.findComponent(Select).exists()).toBe(false)
  expect(wrapper.get('input').element.disabled).toBe(true)
  await wrapper.findAll('button').find(button => button.text() === '保存')!.trigger('click')
  mocks.confirm.mock.calls[0]![2]()
  expect(wrapper.emitted('save')?.at(- 1)).toEqual([expect.any(File), 'redacted', 'photo.png.good', 'avif'])
})

it('does not export after the dialog closes while confirmation is open', async () => {
  const wrapper = await open()
  await wrapper.findAll('button').find(button => button.text() === '保存')!.trigger('click')
  await wrapper.setProps({ visible: false })
  mocks.confirm.mock.calls[0]![2]()
  expect(mocks.exported).not.toHaveBeenCalled()
  expect(wrapper.emitted('save')).toBeUndefined()
  expect(mocks.release).toHaveBeenCalled()
})
