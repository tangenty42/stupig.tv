import type { ContentStoryAttachment } from '@shared/types/content'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import Preview from './Preview.vue'

// The authenticated API client pulls the MQTT transport config, which the
// component test environment does not provide; the download boundary stays mocked.
mockNuxtImport('useApi', () => () => ({ content: { sign_attachment_download: vi.fn() } }))
mockNuxtImport('useMyToast', () => () => ({ error: vi.fn() }))

const wrappers: { unmount: () => void, setProps: (props: Record<string, unknown>) => Promise<void> }[] = []
afterEach(() => {
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

it('keeps the lightbox closed for a plain body without images', async () => {
  const wrapper = await mount_preview({ markdown: '没有图片的正文' })
  expect(wrapper.find('img[data-preview-index]').exists()).toBe(false)
  expect(wrapper.find('[data-lightbox]').exists()).toBe(false)
})
