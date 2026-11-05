import type { MyContentAttachmentRow } from '~/features/content/attachments/list-model'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import List from './List.vue'

const wrappers: { unmount: () => void }[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  document.body.innerHTML = ''
  vi.restoreAllMocks()
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
