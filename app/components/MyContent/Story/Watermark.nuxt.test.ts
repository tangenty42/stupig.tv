import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import Watermark from './Watermark.vue'

mockNuxtImport('useStaticUrl', () => () => (path: string) => `/${path}`)

const layer = '.story-watermark-image'
const mounted: { unmount: () => void }[] = []

afterEach(() => {
  mounted.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
})

async function mount_watermark(labels: string[]) {
  const wrapper = await mountSuspended(Watermark, { props: { labels } })
  mounted.push(wrapper)
  return wrapper
}

function finish_image(image: HTMLImageElement, loaded: boolean) {
  Object.defineProperties(image, {
    complete: { value: true },
    currentSrc: { get: () => image.src },
    naturalWidth: { value: loaded ? 120 : 0 },
  })
  image.dispatchEvent(new Event(loaded ? 'load' : 'error'))
}

it('has no watermark layer for unrated, pending, or failed images', async () => {
  const wrapper = await mount_watermark(['标签', '#置顶'])
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.find(layer).exists()).toBe(false)

  await wrapper.setProps({ labels: ['#夯'] })
  const request = wrapper.get('img')
  expect(request.attributes('src')).toBe('/imgs/ratings/1.svg')
  expect(wrapper.find(layer).exists()).toBe(false)
  finish_image(request.element, false)
  await flushPromises()
  expect(wrapper.find(layer).exists()).toBe(false)
})

it('reveals only the current rating image and removes the old layer on a rating change', async () => {
  const wrapper = await mount_watermark(['#夯'])
  const previous = wrapper.get('img').element
  await wrapper.setProps({ labels: ['#NPC'] })
  const current = wrapper.get('img')
  expect(current.attributes('src')).toBe('/imgs/ratings/4.svg')
  finish_image(previous, true)
  await flushPromises()
  expect(wrapper.find(layer).exists()).toBe(false)

  finish_image(current.element, true)
  await flushPromises()
  expect(wrapper.get(layer).attributes('style')).toContain('/imgs/ratings/4.svg')

  await wrapper.setProps({ labels: ['#顶级'] })
  expect(wrapper.get('img').attributes('src')).toBe('/imgs/ratings/2.svg')
  expect(wrapper.find(layer).exists()).toBe(false)
})

it('reveals an already cached rating image without waiting for another load event', async () => {
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(120)
  const wrapper = await mount_watermark(['#人上人'])
  await flushPromises()
  expect(wrapper.get(layer).attributes('style')).toContain('/imgs/ratings/3.svg')
})
