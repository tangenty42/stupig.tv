import type { MyContentAttachmentRow } from '~/features/content/attachments/list-model'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import Card from './Card.vue'

const wrappers: { unmount: () => void }[] = []
afterEach(() => {
  vi.useRealTimers()
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const row: MyContentAttachmentRow = {
  key: 'node:2', depth: 0,
  source: { key: 'node:2', parent_id: 1, name: 'a.txt', path: 'a.txt', depth: 0, node: { id: 2, parent_id: 1, name: 'a.txt', path: 'a.txt', kind: 'file', version: 'v' } },
  upload: null,
  data: { kind: 'stored', id: 2, file_name: 'a.txt', mime_type: 'text/plain', file_size: 1, version: 'v', url: '/a.txt', is_image: false },
  state: { selected: false, selection_edges: 'both', pending: false, move_pending: false, draggable: true },
}
const menu_items = [{ label: '下载', icon_name: 'lucide:download', command: vi.fn() }]

async function mount_card() {
  const wrapper = await mountSuspended(Card, {
    attachTo: document.body,
    props: { row, menu_items },
    global: { stubs: { MyIcon: { props: ['name'], template: '<span :data-icon="name" />' } } },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

const touch = { length: 1, item: () => ({ identifier: 1, clientX: 10, clientY: 10, pageX: 10, pageY: 10 }) }

it('opens the context menu from a sustained long press', async () => {
  vi.useFakeTimers()
  const wrapper = await mount_card()
  await wrapper.get('.file-row').trigger('touchstart', { touches: touch })
  expect(document.querySelector('.p-contextmenu')).toBeNull()
  vi.advanceTimersByTime(600)
  await flushPromises()
  expect(document.querySelector('.p-contextmenu')).not.toBeNull()
})

it('cancels the pending long press when unmounted before it fires', async () => {
  vi.useFakeTimers()
  const wrapper = await mount_card()
  await wrapper.get('.file-row').trigger('touchstart', { touches: touch })
  wrapper.unmount()
  wrappers.pop()
  vi.advanceTimersByTime(600)
  await flushPromises()
  expect(document.querySelector('.p-contextmenu')).toBeNull()
  // The menu-broadcast listener is gone too: another row's menu open is ignored.
  document.dispatchEvent(new Event('stupig-file-menu-open'))
  expect(document.querySelector('.p-contextmenu')).toBeNull()
})
