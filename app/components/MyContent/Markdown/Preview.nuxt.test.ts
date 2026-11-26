import type { ContentStoryAttachment } from '@shared/types/content'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import Preview from './Preview.vue'

const mocks = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }))

// The authenticated API client pulls the MQTT transport config, which the
// component test environment does not provide; the download boundary stays mocked.
mockNuxtImport('useApi', () => () => ({ content: { sign_attachment_download: vi.fn() } }))
mockNuxtImport('useMyToast', () => () => mocks)

const wrappers: { unmount: () => void, setProps: (props: Record<string, unknown>) => Promise<void> }[] = []
afterEach(() => {
  vi.clearAllMocks()
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  document.body.innerHTML = ''
})

const attachments: ContentStoryAttachment[] = [{
  id: 3, file_name: 'a.png', mime_type: 'image/png', file_size: 10, version: 'v1', url: '/a.png', is_image: true,
}]

async function mount_preview(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(Preview, {
    attachTo: document.body,
    props: { markdown: '![](att://a.png)', attachments, ... props },
    global: { stubs: {
      MyIcon: { props: ['name'], template: '<span :data-icon="name" />' },
      MyImagePreview: { props: ['visible', 'images', 'initialIndex'], template: '<div data-lightbox :data-visible="String(visible)" :data-images="(images ?? []).join(\',\')" />' },
    } },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

it('closes and clears a full-image lightbox when switching the preview audience', async () => {
  const wrapper = await mount_preview()
  const image = wrapper.get('img[data-preview-index]')
  await image.trigger('click')
  await flushPromises()
  const lightbox = wrapper.get('[data-lightbox]')
  expect(lightbox.attributes('data-visible')).toBe('true')
  expect(lightbox.attributes('data-images')).not.toBe('')

  // The watcher must close and clear even before the new v-html subtree is patched,
  // so a lingering private image cannot survive the public-view switch.
  await wrapper.setProps({ publicView: true })
  await flushPromises()
  expect(lightbox.attributes('data-visible')).toBe('false')
  expect(lightbox.attributes('data-images')).toBe('')
})

it('explains when a folder card has no attachment-list destination in preview', async () => {
  const wrapper = await mount_preview({ markdown: '[](att://docs.good)', folders: ['docs.good'], canReadPrivate: true })
  const folder = wrapper.get('[data-folder-card="docs.good"]')
  expect(folder.attributes('role')).toBe('button')
  await folder.trigger('click')
  expect(mocks.info).toHaveBeenCalledWith('预览中无法打开附件列表~')
  expect(wrapper.emitted('folder-open')).toBeUndefined()
})

it('hides private folder cards unless the current preview audience can read them', async () => {
  const wrapper = await mount_preview({ markdown: '[](att://docs.good)', folders: ['docs.good'], folderOpenable: true })
  const denied = '.content-placeholder-denied'
  const card = '[data-folder-card="docs.good"]'
  expect(wrapper.get(denied).text()).toBe('你无权查看此处的机密附件')
  expect(wrapper.find(card).exists()).toBe(false)
  await wrapper.setProps({ canReadPrivate: true })
  await wrapper.get(card).trigger('click')
  expect(wrapper.emitted('folder-open')).toEqual([['docs.good']])

  await wrapper.setProps({ publicView: true })
  expect(wrapper.get(denied).text()).toBe('你无权查看此处的机密附件')
  expect(wrapper.find(card).exists()).toBe(false)
  await wrapper.setProps({ publicView: false })
  expect(wrapper.get(card).get('.file-card-size').text()).toBe('0 项')
})

it('opens a folder card when the host provides the attachment list', async () => {
  const wrapper = await mount_preview({ markdown: '[](att://docs)', folders: ['docs', 'docs/child', 'docs/child/grandchild'], folderOpenable: true })
  const folder = wrapper.get('[data-folder-card="docs"]')
  expect(folder.get('.file-card-size').text()).toBe('1 项')
  await folder.trigger('click')
  expect(wrapper.emitted('folder-open')).toEqual([['docs']])
  expect(mocks.info).not.toHaveBeenCalled()
})

it('replaces a private attachment card and blocks matching pasted links after access is revoked', async () => {
  const url = '/api/links/attachments/9?version=old'
  const absolute = new URL(`${url}#t=3`, window.location.href).href
  const wrapper = await mount_preview({
    markdown: `[](att://audio.mp3.good)\n\n[旧地址](${url}) [完整地址](${absolute})`,
    canReadPrivate: true,
    attachments: [{
      id: 9, file_name: 'audio.mp3.good', mime_type: 'audio/mpeg', file_size: 10, version: 'v1',
      url, is_image: false, is_private: true,
    }],
  })
  expect(wrapper.get('a[data-attachment-url]').attributes('href')).toBe(url)
  await wrapper.setProps({ canReadPrivate: false })
  await flushPromises()
  expect(wrapper.find('a[data-attachment-url]').exists()).toBe(false)
  expect(wrapper.get('.content-placeholder-denied').text()).toBe('你无权查看此处的机密附件')

  const link = wrapper.get(`a[href="${url}"]`)
  const click = new MouseEvent('click', { bubbles: true, cancelable: true })
  const middle_click = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
  expect(link.element.dispatchEvent(click)).toBe(false)
  expect(wrapper.get(`a[href="${absolute}"]`).element.dispatchEvent(middle_click)).toBe(false)
  expect(mocks.info.mock.calls).toEqual([['无权打开此机密附件！'], ['无权打开此机密附件！']])
})

it('keeps the lightbox closed for a plain body without images', async () => {
  const wrapper = await mount_preview({ markdown: '没有图片的正文' })
  expect(wrapper.find('img[data-preview-index]').exists()).toBe(false)
  expect(wrapper.find('[data-lightbox]').exists()).toBe(false)
})
