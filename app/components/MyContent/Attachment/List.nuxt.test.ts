import type { MyContentAttachmentRow } from '~/features/content/attachments/list-model'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { DOMWrapper, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import List from './List.vue'

const wrappers: { unmount: () => void }[] = []
const dialog_selector = '[role="dialog"][aria-label="未能添加附件"]'
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['文件', '文件夹'] as const)('recovers from a blocked %s picker into its original target', async (kind) => {
  const wrapper = await mount_list(() => {})
  const input = wrapper.get<HTMLInputElement>(`[aria-label="选择上传${kind}"]`)
  const show = vi.fn().mockImplementationOnce(() => {
    throw new DOMException('Blocked', 'NotAllowedError')
  })
  Object.defineProperty(input.element, 'showPicker', { value: show })
  const picker = wrapper.vm as unknown as { pick_files: (target: string) => void, pick_folder: (target: string) => void }
  if (kind === '文件')
    picker.pick_files('相册')
  else
    picker.pick_folder('相册')
  await flushPromises()
  const body = new DOMWrapper(document.body)
  const dialog = body.get(dialog_selector)
  expect(dialog.text()).toContain(`无法打开${kind}选择窗口`)
  const retry = dialog.get('button[aria-label="重新选择"]')
  expect(retry.find('[data-icon="lucide:folder-open"]').exists()).toBe(true)
  expect(show).toHaveBeenCalledOnce()
  expect(wrapper.emitted('files-picked')).toBeUndefined()

  await retry.trigger('click')
  expect(show).toHaveBeenCalledTimes(2)
  expect(body.find(dialog_selector).exists()).toBe(false)
  const file = new File(['text'], 'note.txt')
  if (kind === '文件夹')
    Object.defineProperty(file, 'webkitRelativePath', { value: '照片/note.txt' })
  Object.defineProperty(input.element, 'files', { value: [file] })
  await input.trigger('change')
  const file_name = kind === '文件夹' ? '相册/照片/note.txt' : '相册/note.txt'
  expect(wrapper.emitted('files-picked')).toEqual([[[expect.objectContaining({ file, file_name })]]])
})

it('returns quietly on native cancel and reports an empty change separately', async () => {
  const wrapper = await mount_list(() => {})
  const body = new DOMWrapper(document.body)
  const input = wrapper.get<HTMLInputElement>('[aria-label="选择上传文件"]')
  Object.defineProperty(input.element, 'showPicker', { value: undefined })
  const click = vi.spyOn(input.element, 'click').mockImplementation(() => {})
  const picker = wrapper.vm as unknown as { pick_files: (target: string) => void }

  picker.pick_files('旧目录')
  expect(click).toHaveBeenCalledOnce()
  await input.trigger('cancel')
  expect(body.find(dialog_selector).exists()).toBe(false)
  expect(wrapper.emitted('files-picked')).toBeUndefined()

  picker.pick_files('新目录')
  expect(click).toHaveBeenCalledTimes(2)
  await input.trigger('change')
  const dialog = body.get(dialog_selector)
  expect(dialog.text()).toContain('将文件拖到附件列表')
  expect(dialog.find('button[aria-label="取消"]').exists()).toBe(false)
  await dialog.get('button[data-pc-group-section="headericon"]').trigger('click')
  expect(body.find(dialog_selector).exists()).toBe(false)
  expect(wrapper.emitted('files-picked')).toBeUndefined()

  const file = new File(['text'], 'note.txt')
  picker.pick_files('更换目录')
  Object.defineProperty(input.element, 'files', { value: [file] })
  await input.trigger('change')
  expect(wrapper.emitted('files-picked')).toEqual([[[expect.objectContaining({ file, file_name: '更换目录/note.txt' })]]])
})

const rows: MyContentAttachmentRow[] = [
  { key: 'node:2', depth: 0, source: { key: 'node:2', parent_id: 1, name: 'a.txt', path: 'a.txt', depth: 0, node: { id: 2, parent_id: 1, name: 'a.txt', path: 'a.txt', kind: 'file', version: 'v' } }, upload: null,
    data: { kind: 'stored', id: 2, file_name: 'a.txt', mime_type: 'text/plain', file_size: 1, version: 'v', url: '/a.txt', is_image: false },
    state: { selected: false, selection_edges: 'both', pending: false, move_pending: false, draggable: true } },
]

async function mount_list(on_marquee_select: (keys: string[], additive: boolean, phase: string) => void) {
  const wrapper = await mountSuspended(List, {
    attachTo: document.body,
    props: { rows, menu_items: () => [], upload_busy: false, onMarqueeSelect: on_marquee_select },
    global: { stubs: { MyIcon: { props: ['name'], template: '<span :data-icon="name" />' } } },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

it('releases the marquee listeners when unmounted mid-drag', async () => {
  const events: unknown[][] = []
  const wrapper = await mount_list((... args: unknown[]) => events.push(args))
  await wrapper.get('.file-list-root').trigger('pointerdown', { button: 0, isPrimary: true, pointerId: 7, clientX: 10, clientY: 10 })
  // The background pointerdown opens a marquee session and emits its start.
  expect(events).toEqual([[[], false, 'start']])

  wrapper.unmount()
  wrappers.pop()
  window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: 40, clientY: 40 }))
  window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7 }))
  window.dispatchEvent(new Event('blur'))
  // Unmount ends the session (its 'end' emit) and later pointer events are ignored.
  expect(events).toEqual([[[], false, 'start'], [[], false, 'end']])
})
