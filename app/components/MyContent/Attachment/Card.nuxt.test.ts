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

async function mount_card(card_row = row) {
  const wrapper = await mountSuspended(Card, {
    attachTo: document.body,
    props: { row: card_row, menu_items },
    global: { stubs: { MyIcon: { props: ['name'], template: '<span :data-icon="name" />' } } },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

const touch = { length: 1, item: () => ({ identifier: 1, clientX: 10, clientY: 10, pageX: 10, pageY: 10 }) }
const pending_row: MyContentAttachmentRow = {
  ... row,
  source: { key: 'session:1', parent_id: 1, name: 'a.txt', path: 'a.txt', depth: 0 },
  data: { kind: 'upload', file_name: 'a.txt', mime_type: 'text/plain', file_size: 100 },
  upload: { status: 'uploading', progress: 40, file_size: 100, message: null, label: '上传中' },
}

it.each([false, true])('renders useful failure text and tooltips with or without a message (preparation=%s)', async (preparation) => {
  const failed_row: MyContentAttachmentRow = {
    ... pending_row,
    source: { ... pending_row.source, ... (preparation ? { preparation: { id: 'failed', path: 'a.txt', loaded: 0, size: 100, phase: 'failed' as const } } : {}) },
    upload: { ... pending_row.upload!, status: 'error', message: null },
  }
  const wrapper = await mount_card(failed_row)
  const label = preparation ? '准备失败' : '上传失败'
  for (const message of [null, '', ' \n ', '文件不可读取']) {
    await wrapper.setProps({ row: { ... failed_row, upload: { ... failed_row.upload!, message } } })
    const expected = message?.trim() ? `${label}：${message}` : label
    const failure = wrapper.get('.text-red-600')
    expect(failure.text()).toBe(expected)
    expect(failure.attributes('title')).toBe(expected)
  }
})

it('distinguishes pending rows and restores the selected background when selected', async () => {
  const wrapper = await mount_card(pending_row)
  expect(wrapper.get('.file-row').classes()).toContain('file-row-pending')
  expect(wrapper.get('.file-row').classes()).not.toContain('file-row-selected')

  await wrapper.setProps({ row: { ... pending_row, state: { ... pending_row.state, selected: true } } })
  expect(wrapper.get('.file-row').classes()).toContain('file-row-pending')
  expect(wrapper.get('.file-row').classes()).toContain('file-row-selected')
})

it('marks an uncertain command result without keeping the pending spinner', async () => {
  const wrapper = await mount_card({ ... row, state: { ... row.state, result_pending: true } })
  expect(wrapper.get('.file-row').text()).toContain('结果待确认')
  expect(wrapper.find('.animate-spin').exists()).toBe(false)
})

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
