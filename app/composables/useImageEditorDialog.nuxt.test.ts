import type { ContentStoryAttachment } from '@shared/types/content'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive } from 'vue'
import { useImageEditorDialog } from './useImageEditorDialog'

const wrappers: { unmount: () => void }[] = []
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))

async function open(redacted = false) {
  const props = reactive({ visible: false, pending: false, redacted,
    attachment: { id: 1, file_name: 'docs/photo.png.good', url: '/read?version=v1' } as ContentStoryAttachment })
  const load = vi.fn().mockResolvedValue({ avif_url: '/view?role=avif', original_url: '/view?role=original', original_reason: '' })
  const save = vi.fn()
  const confirm = vi.fn()
  let dialog!: ReturnType<typeof useImageEditorDialog>
  const wrapper = await mountSuspended(defineComponent({
    setup() {
      dialog = useImageEditorDialog(props, { load, save, confirm })
      return () => h('div', dialog.source_error.value)
    },
  }))
  wrappers.push(wrapper)
  props.visible = true
  await flushPromises()
  return { props, load, save, confirm, dialog, wrapper }
}

it('loads the authorized source and emits a copy name with its fixed AVIF suffix', async () => {
  const { dialog, load, save } = await open()
  expect(load).toHaveBeenCalledWith(1, 'v1', false)
  dialog.mode.value = 'copy'
  await flushPromises()
  dialog.display_name.value = '改名.v2'
  const file = new File(['pixels'], 'edited.png')
  dialog.save(file)
  expect(save).toHaveBeenCalledWith(file, 'copy', '改名.v2.avif', 'avif')
  dialog.display_name.value = ' '
  dialog.save(file)
  expect(save).toHaveBeenCalledOnce()
})

it.each([false, true])('resets pixels without changing the save destination (redacted: %s)', async (redacted) => {
  const { dialog, confirm, save } = await open(redacted)
  dialog.base_ready.value = true
  dialog.request_reset(new Event('click'))
  expect(save).not.toHaveBeenCalled()
  confirm.mock.calls[0]![2]()
  expect(dialog.source_url.value).toContain('/view?role=original&editor_reset=')
  dialog.save(new File(['pixels'], 'edited.png'))
  expect(save).toHaveBeenLastCalledWith(expect.any(File), redacted ? 'redacted' : 'overwrite', 'docs/photo.png.good', 'original')
})

it.each(['closed', 'pending', 'changed', 'unmounted'])('ignores stale confirmation after %s', async (change) => {
  const { dialog, props, confirm, wrapper } = await open()
  dialog.base_ready.value = true
  dialog.request_reset(new Event('click'))
  const accept = confirm.mock.calls[0]![2]
  if (change === 'closed')
    props.visible = false
  if (change === 'pending')
    props.pending = true
  if (change === 'changed')
    props.attachment = { ... props.attachment, id: 2 }
  if (change === 'unmounted')
    wrapper.unmount()
  await flushPromises()
  accept()
  expect(dialog.input_basis.value).toBe('avif')
})

it('discards a source response from a previous attachment', async () => {
  const { dialog, props, load } = await open()
  let finish!: (value: unknown) => void
  load.mockImplementationOnce(() => new Promise(resolve => finish = resolve))
  props.attachment = { ... props.attachment, id: 2 }
  await flushPromises()
  props.attachment = { ... props.attachment, id: 3 }
  await flushPromises()
  finish({ avif_url: '/stale', original_url: null, original_reason: '' })
  await flushPromises()
  expect(dialog.source_url.value).toBe('/view?role=avif')
})
