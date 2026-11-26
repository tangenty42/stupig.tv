import type Viewer from 'viewerjs'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import MyImagePreview from './MyImagePreview.vue'

interface TestViewer {
  canvas: HTMLElement
  options: Viewer.Options
  view: (index: number) => HTMLImageElement
  finish_view: (image: HTMLImageElement) => void
  finish_hide: () => void
}

const boundary = vi.hoisted(() => ({ viewer: null as TestViewer | null, cached: false }))
vi.mock('viewerjs', () => ({
  default: class {
    readonly canvas = document.createElement('div')

    constructor(private element: HTMLElement, readonly options: Viewer.Options) {
      this.canvas.className = 'viewer-canvas'
      document.body.append(this.canvas)
      boundary.viewer = this
    }

    view(index: number) {
      const originalImage = this.element.querySelectorAll('img')[index]!
      const image = document.createElement('img')
      image.src = originalImage.dataset.src!
      image.dataset.index = String(index)
      let loaded = boundary.cached
      Object.defineProperties(image, {
        complete: { get: () => loaded },
        currentSrc: { get: () => image.src },
        naturalWidth: { get: () => loaded ? 120 : 0 },
      })
      this.options.view?.(new CustomEvent('view', { detail: { image, index, originalImage, originalEvent: null } }))
      this.canvas.replaceChildren(image)
      this.canvas.classList.toggle('viewer-loading', ! boundary.cached)
      if (boundary.cached) {
        this.finish_view(image)
      }
      else {
        image.addEventListener('load', () => {
          loaded = true
        }, { once: true })
      }
      return image
    }

    finish_view(image: HTMLImageElement) {
      const index = Number(image.dataset.index)
      const originalImage = this.element.querySelectorAll('img')[index]!
      this.canvas.classList.remove('viewer-loading')
      // Viewer owns the image's inline dimensions and later zoom transitions.
      image.style.cssText = 'width:120px;height:80px;'
      this.options.viewed?.(new CustomEvent('viewed', { detail: { image, index, originalImage, originalEvent: null } }))
    }

    hide() {
      this.options.hide?.(new CustomEvent('hide', { detail: { originalEvent: null } }))
    }

    finish_hide() {
      this.canvas.replaceChildren()
      this.options.hidden?.(new CustomEvent('hidden', { detail: { originalEvent: null } }))
    }

    destroy() {
      this.canvas.remove()
    }
  },
}))
mockNuxtImport('useMyToast', () => () => ({ error: vi.fn() }))

const mounted: { unmount: () => void }[] = []
afterEach(() => {
  mounted.splice(0).forEach(wrapper => wrapper.unmount())
  boundary.viewer = null
  boundary.cached = false
  vi.restoreAllMocks()
})

async function open() {
  const wrapper = await mountSuspended(MyImagePreview, {
    props: { images: ['/one.png', '/two.png'], visible: true },
    global: { stubs: { MyIcon: true } },
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, viewer: boundary.viewer!, canvas: boundary.viewer!.canvas }
}

function visible_status(canvas: HTMLElement) {
  return canvas.querySelector('[role="status"][aria-hidden="false"]')?.textContent ?? null
}

it('crossfades the shared spinner to failure without removing either layer', async () => {
  const { canvas } = await open()
  const image = canvas.querySelector('img')!
  const spinner = canvas.querySelector('.image-loading-mask')!
  const failure = canvas.querySelector('.viewer-image-unavailable')!
  expect(visible_status(canvas)).toBe('图片加载中')
  expect(canvas.dataset.imageState).toBe('loading')
  expect(canvas.getAttribute('aria-busy')).toBe('true')
  expect(canvas.style.getPropertyValue('--content-lqip')).toBe('')
  expect(failure.getAttribute('aria-hidden')).toBe('true')

  image.dispatchEvent(new Event('error'))
  expect(canvas.querySelector('.image-loading-mask')).toBe(spinner)
  expect(canvas.querySelector('.viewer-image-unavailable')).toBe(failure)
  expect(spinner.getAttribute('aria-hidden')).toBe('true')
  expect(visible_status(canvas)).toBe('图片加载失败')
  expect(canvas.dataset.imageState).toBe('error')
  expect(canvas.hasAttribute('aria-busy')).toBe(false)
  expect(image.hidden).toBe(false)
})

it('keeps the spinner until the current image has been fitted and decoded', async () => {
  const { viewer, canvas } = await open()
  expect(viewer.options.transition).toEqual({ view: false })
  const previous = canvas.querySelector('img')!
  const old_spinner = canvas.querySelector('.image-loading-mask')!
  const next = viewer.view(1)
  const decoded = Promise.withResolvers<void>()
  vi.spyOn(next, 'decode').mockReturnValue(decoded.promise)
  await flushPromises()
  expect(old_spinner.isConnected).toBe(false)
  previous.dispatchEvent(new Event('error'))
  expect(visible_status(canvas)).toBe('图片加载中')
  expect(next.hidden).toBe(false)

  next.dispatchEvent(new Event('load'))
  expect(visible_status(canvas)).toBe('图片加载中')
  expect(next.classList.contains('viewer-image-pending')).toBe(true)
  viewer.finish_view(next)
  expect(visible_status(canvas)).toBe('图片加载中')
  decoded.resolve()
  await flushPromises()
  expect(visible_status(canvas)).toBeNull()
  expect(canvas.dataset.imageState).toBe('loaded')
  expect(canvas.querySelector('.image-loading-mask')?.getAttribute('aria-hidden')).toBe('true')
  expect(canvas.querySelector('.viewer-image-unavailable')?.getAttribute('aria-hidden')).toBe('true')
  expect(next.classList.contains('viewer-image-pending')).toBe(false)
  expect(next.classList.contains('viewer-image-state')).toBe(true)
  expect(next.style.cssText).toContain('width: 120px')
  expect(next.style.opacity).toBe('')
})

it('waits for the replacement request when Viewer switches to a fallback on the same element', async () => {
  const { viewer, canvas } = await open()
  const image = viewer.view(0)
  image.addEventListener('error', () => {
    image.src = '/backup.png'
  }, { once: true })
  await flushPromises()
  image.dispatchEvent(new Event('error'))
  expect(visible_status(canvas)).toBe('图片加载中')

  image.dispatchEvent(new Event('load'))
  viewer.finish_view(image)
  await flushPromises()
  expect(visible_status(canvas)).toBeNull()
  expect(canvas.dataset.imageState).toBe('loaded')
  expect(image.hidden).toBe(false)
})

it('removes the old failure on close and starts a fresh view after the hide transition', async () => {
  const { wrapper, viewer, canvas } = await open()
  const previous = canvas.querySelector('img')!
  previous.dispatchEvent(new Event('error'))
  expect(canvas.querySelector('.viewer-image-unavailable')).not.toBeNull()

  await wrapper.setProps({ visible: false })
  await flushPromises()
  expect(canvas.querySelector('[role="status"]')).toBeNull()
  await wrapper.setProps({ visible: true })
  await flushPromises()
  expect(canvas.querySelector('img')).toBe(previous)

  viewer.finish_hide()
  await flushPromises()
  const current = canvas.querySelector('img')!
  expect(current).not.toBe(previous)
  expect(visible_status(canvas)).toBe('图片加载中')
  current.dispatchEvent(new Event('error'))
  expect(visible_status(canvas)).toBe('图片加载失败')
})

it('does not insert a spinner for an already decoded image', async () => {
  boundary.cached = true
  const { canvas } = await open()
  expect(canvas.querySelector('img')?.classList.contains('viewer-image-pending')).toBe(false)
  expect(canvas.querySelector('[role="status"]')).toBeNull()
  expect(canvas.dataset.imageState).toBe('loaded')
})

it('disables Viewer transitions through its API when reduced motion is requested', async () => {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
  vi.spyOn(preference, 'matches', 'get').mockReturnValue(true)
  vi.spyOn(window, 'matchMedia').mockReturnValue(preference)
  const { viewer, wrapper, canvas } = await open()
  expect(viewer.options.transition).toBe(false)
  const image = canvas.querySelector('img')!
  await wrapper.setProps({ visible: false })
  await flushPromises()
  expect(canvas.querySelector('[role="status"]')).toBeNull()
  image.dispatchEvent(new Event('error'))
  expect(canvas.querySelector('[role="status"]')).toBeNull()
})
