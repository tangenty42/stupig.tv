import { afterEach, expect, it, vi } from 'vitest'
import { image_load_state, observe_image_placeholders, reset_image_placeholder } from './image-placeholders'

function image_boundary(complete = false, naturalWidth = 0, lqip = false) {
  const attributes = new Map<string, string>()
  const source_attributes = new Map([['src', '/image'], ['width', '120'], ['height', '80']])
  const frame = { dataset: {} as Record<string, string>, setAttribute: (key: string, value: string) => attributes.set(key, value), removeAttribute: (key: string) => attributes.delete(key), querySelector: vi.fn<() => HTMLElement | null>(() => null) }
  const image = Object.assign(new EventTarget(), { complete, naturalWidth, parentElement: frame, src: 'https://fixture.test/image', currentSrc: 'https://fixture.test/image',
    getAttribute: (name: string) => source_attributes.get(name) ?? null })
  if (lqip)
    frame.dataset.lqip = ''
  const root = { querySelectorAll: (selector: string) => selector === '.img-frame > img' || (lqip && selector === '.img-frame[data-lqip] > img') ? [image] : [] }
  return { image, frame, attributes, source_attributes, root: root as unknown as HTMLElement }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function breathing_boundary(complete = false) {
  vi.useFakeTimers()
  const boundary = image_boundary(complete, complete ? 120 : 0, true)
  const layer = new EventTarget()
  boundary.frame.querySelector.mockReturnValue(layer as unknown as HTMLElement)
  const style = { animationName: 'image-placeholder-breathe', animationDuration: '2.2s', animationPlayState: 'running' }
  vi.stubGlobal('getComputedStyle', vi.fn(() => style))
  function finish(type = 'animationiteration', animationName = 'image-placeholder-breathe', pseudoElement = '::before') {
    layer.dispatchEvent(Object.assign(new Event(type), { animationName, pseudoElement }))
  }
  function load() {
    boundary.image.complete = true
    boundary.image.naturalWidth = 120
    boundary.image.dispatchEvent(new Event('load'))
  }
  return { ... boundary, layer, style, finish, load }
}

it('finishes the current LQIP breathing cycle before revealing, including a layer added after observation', () => {
  const { root, frame, attributes, layer, load, finish } = breathing_boundary()
  frame.querySelector.mockReturnValue(null)
  const cleanup = observe_image_placeholders(root)
  frame.querySelector.mockReturnValue(layer as unknown as HTMLElement)
  load()
  load()
  expect(frame.dataset.imageLoaded).toBeUndefined()
  expect(attributes.get('aria-busy')).toBe('true')
  expect(vi.getTimerCount()).toBe(1)
  finish('animationiteration', 'another-animation')
  finish('animationiteration', 'image-placeholder-breathe', '')
  expect(frame.dataset.imageLoaded).toBeUndefined()
  finish()
  expect(frame.dataset.imageLoaded).toBe('')
  expect(attributes.has('aria-busy')).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  cleanup()
})

it('cancels the pending reveal immediately on image failure', () => {
  const { root, frame, image, load, finish } = breathing_boundary()
  const cleanup = observe_image_placeholders(root)
  load()
  image.dispatchEvent(new Event('error'))
  expect(frame.dataset.imageError).toBe('')
  expect(vi.getTimerCount()).toBe(0)
  finish()
  vi.advanceTimersByTime(2400)
  expect(frame.dataset.imageLoaded).toBeUndefined()
  expect(frame.dataset.imageError).toBe('')
  cleanup()
})

it('reveals immediately if the active breathing animation is cancelled', () => {
  const { root, frame, style, load, finish } = breathing_boundary()
  const cleanup = observe_image_placeholders(root)
  load()
  style.animationName = 'none'
  finish('animationcancel')
  expect(frame.dataset.imageLoaded).toBe('')
  expect(vi.getTimerCount()).toBe(0)
  cleanup()
})

it('waits for a cached image too, with a one-cycle fallback when iteration is not delivered', () => {
  const { root, frame } = breathing_boundary(true)
  const cleanup = observe_image_placeholders(root)
  expect(frame.dataset.imageLoaded).toBeUndefined()
  vi.advanceTimersByTime(2200)
  expect(frame.dataset.imageLoaded).toBeUndefined()
  vi.advanceTimersByTime(100)
  expect(frame.dataset.imageLoaded).toBe('')
  expect(vi.getTimerCount()).toBe(0)
  cleanup()
})

it.each([false, true])('decodes a loaded LQIP image before revealing, with cached=%s', async (cached) => {
  const { root, frame, image, attributes, load, finish } = breathing_boundary(cached)
  const decoded = Promise.withResolvers<void>()
  const decode = vi.fn(() => decoded.promise)
  Object.assign(image, { decode })
  const cleanup = observe_image_placeholders(root)
  load()
  load()
  expect(decode).toHaveBeenCalledOnce()
  finish()
  vi.advanceTimersByTime(2400)
  expect(attributes.get('aria-busy')).toBe('true')
  expect(frame.dataset.imageReady).toBeUndefined()
  expect(frame.dataset.imageLoaded).toBeUndefined()

  decoded.resolve()
  await decoded.promise
  expect(frame.dataset.imageReady).toBe('')
  expect(frame.dataset.imageLoaded).toBeUndefined()
  expect(attributes.get('aria-busy')).toBe('true')

  finish()
  expect(frame.dataset.imageReady).toBeUndefined()
  expect(frame.dataset.imageLoaded).toBe('')
  expect(attributes.has('aria-busy')).toBe(false)
  cleanup()
})

it.each(['cleanup', 'failure', 'source'] as const)('discards a pending decode after %s', async (change) => {
  const { root, frame, image, source_attributes, load, finish } = breathing_boundary()
  const decoded = Promise.withResolvers<void>()
  Object.assign(image, { decode: () => decoded.promise })
  const cleanup = observe_image_placeholders(root)
  load()
  if (change === 'cleanup') {
    cleanup()
  }
  else if (change === 'failure') {
    image.dispatchEvent(new Event('error'))
  }
  else {
    source_attributes.set('src', '/next')
    image.src = image.currentSrc = 'https://fixture.test/next'
  }
  decoded.resolve()
  await decoded.promise
  finish()
  expect(frame.dataset.imageReady).toBeUndefined()
  expect(frame.dataset.imageLoaded).toBeUndefined()
  expect(frame.dataset.imageError).toBe(change === 'failure' ? '' : undefined)
  cleanup()
})

it('uses native image status if decoding rejects for a completed request', async () => {
  const { root, frame, image, load, finish } = breathing_boundary()
  const decoded = Promise.withResolvers<void>()
  Object.assign(image, { decode: () => decoded.promise })
  const cleanup = observe_image_placeholders(root)
  load()
  decoded.reject(new DOMException('Decode failed', 'EncodingError'))
  await decoded.promise.catch(() => {})
  expect(frame.dataset.imageError).toBeUndefined()
  finish()
  expect(frame.dataset.imageLoaded).toBe('')
  cleanup()
})

it('preserves an already revealed image across DOM observation rebindings', () => {
  const { root, frame, load, finish } = breathing_boundary()
  let cleanup = observe_image_placeholders(root)
  load()
  finish()
  cleanup()
  cleanup = observe_image_placeholders(root)
  expect(frame.dataset.imageLoaded).toBe('')
  expect(vi.getTimerCount()).toBe(0)
  cleanup()
})

it.each(['element', 'source'] as const)('does not reuse the previous loaded frame marker after replacing the %s', (replacement) => {
  const { root, frame, image, source_attributes, finish } = breathing_boundary(true)
  let cleanup = observe_image_placeholders(root)
  finish()
  cleanup()
  let next_root = root
  if (replacement === 'element') {
    const next = image_boundary(true, 120).image
    next.parentElement = frame
    next_root = { querySelectorAll: (selector: string) => selector === '.img-frame > img' ? [next] : [] } as unknown as HTMLElement
  }
  else {
    source_attributes.set('src', '/next')
    image.src = image.currentSrc = 'https://fixture.test/next'
  }
  cleanup = observe_image_placeholders(next_root)
  expect(frame.dataset.imageLoaded).toBeUndefined()
  expect(vi.getTimerCount()).toBe(1)
  finish()
  expect(frame.dataset.imageLoaded).toBe('')
  cleanup()
})

it.each(['cleanup', 'source'] as const)('does not reveal a stale request after %s changes', (change) => {
  const { root, frame, image, source_attributes, load, finish } = breathing_boundary()
  const cleanup = observe_image_placeholders(root)
  load()
  if (change === 'cleanup') {
    cleanup()
  }
  else {
    source_attributes.set('src', '/next')
    image.src = image.currentSrc = 'https://fixture.test/next'
  }
  finish()
  vi.advanceTimersByTime(2400)
  expect(frame.dataset.imageLoaded).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
  cleanup()
})

it.each(['reduced', 'paused', 'zero-duration'] as const)('reveals immediately when breathing is %s', (state) => {
  const { root, frame, style, load } = breathing_boundary()
  if (state === 'reduced')
    style.animationName = 'none'
  else if (state === 'paused')
    style.animationPlayState = 'paused'
  else
    style.animationDuration = '0ms'
  const cleanup = observe_image_placeholders(root)
  load()
  expect(frame.dataset.imageLoaded).toBe('')
  expect(vi.getTimerCount()).toBe(0)
  cleanup()
})

it.each([false, true])('tracks loading, error, representation changes and cleanup with LQIP=%s', (lqip) => {
  const { image, frame, attributes, source_attributes, root } = image_boundary(false, 0, lqip)
  frame.dataset.imageLoaded = ''
  frame.dataset.imageError = ''
  const cleanup = observe_image_placeholders(root)
  expect(attributes.get('aria-busy')).toBe('true')
  expect(frame.dataset.imageLoaded).toBeUndefined()
  expect(frame.dataset.imageError).toBeUndefined()
  image.complete = true
  image.naturalWidth = 120
  image.dispatchEvent(new Event('load'))
  expect(frame.dataset.imageLoaded).toBe('')
  expect(frame.dataset.imageError).toBeUndefined()
  expect(attributes.has('aria-busy')).toBe(false)
  reset_image_placeholder(image as unknown as HTMLImageElement)
  expect(frame.dataset.imageLoaded).toBeUndefined()
  expect(attributes.get('aria-busy')).toBe('true')
  image.dispatchEvent(new Event('error'))
  expect(frame.dataset.imageLoaded).toBeUndefined()
  expect(frame.dataset.imageError).toBe('')
  expect(attributes.has('aria-busy')).toBe(false)
  cleanup()
  image.dispatchEvent(new Event('load'))
  expect(frame.dataset.imageLoaded).toBeUndefined()
  expect(frame.dataset.imageError).toBe('')
  expect(frame.dataset.lqip).toBe(lqip ? '' : undefined)
  expect(source_attributes.get('width')).toBe('120')
  expect(source_attributes.get('height')).toBe('80')
})

it.each([null, ''])('does not treat an empty complete image with src=%s as a failed request', (src) => {
  const { image, frame, attributes, source_attributes, root } = image_boundary(true, 0)
  source_attributes.delete('src')
  if (src !== null)
    source_attributes.set('src', src)
  image.src = ''
  image.currentSrc = ''
  expect(image_load_state(image as unknown as HTMLImageElement)).toBe('loading')
  const cleanup = observe_image_placeholders(root)
  expect(frame.dataset.imageError).toBeUndefined()
  expect(frame.dataset.imageLoaded).toBeUndefined()
  expect(attributes.get('aria-busy')).toBe('true')
  cleanup()
})

it('ignores the previous cached source after reassignment and accepts a responsive candidate', () => {
  const { image, frame, attributes, source_attributes, root } = image_boundary(true, 120)
  source_attributes.set('src', '/next')
  image.src = 'https://fixture.test/next'
  const cleanup = observe_image_placeholders(root)
  expect(frame.dataset.imageLoaded).toBeUndefined()
  expect(frame.dataset.imageError).toBeUndefined()
  expect(attributes.get('aria-busy')).toBe('true')
  image.currentSrc = image.src
  image.dispatchEvent(new Event('load'))
  expect(frame.dataset.imageLoaded).toBe('')
  source_attributes.set('srcset', '/large 2x')
  image.currentSrc = 'https://fixture.test/large'
  expect(image_load_state(image as unknown as HTMLImageElement)).toBe('loaded')
  cleanup()
})

it('settles a completed zero-width load as failed and ignores callbacks after release', () => {
  const { image, frame, attributes, root } = image_boundary(false, 0)
  const listeners = vi.spyOn(image, 'addEventListener')
  const cleanup = observe_image_placeholders(root)
  image.complete = true
  image.dispatchEvent(new Event('load'))
  expect(frame.dataset.imageError).toBe('')
  expect(frame.dataset.imageLoaded).toBeUndefined()
  expect(attributes.has('aria-busy')).toBe(false)
  cleanup()
  image.naturalWidth = 120
  for (const [, listener] of listeners.mock.calls) {
    if (typeof listener === 'function')
      listener.call(image, new Event('load'))
  }
  expect(frame.dataset.imageError).toBe('')
  expect(frame.dataset.imageLoaded).toBeUndefined()
})

it.each([0, 120])('settles already-complete images before hydration with natural width %s', (width) => {
  const { frame, attributes, root } = image_boundary(true, width)
  const cleanup = observe_image_placeholders(root)
  expect(frame.dataset[width ? 'imageLoaded' : 'imageError']).toBe('')
  expect(attributes.has('aria-busy')).toBe(false)
  cleanup()
})

it('tracks iframe loading across preview rebindings and resets for a new player', () => {
  const attributes = new Map<string, string>()
  let iframe = Object.assign(new EventTarget(), { contentWindow: null, contentDocument: null })
  const frame = { dataset: {} as Record<string, string>, setAttribute: (key: string, value: string) => attributes.set(key, value), removeAttribute: (key: string) => attributes.delete(key), querySelector: () => iframe }
  const root = { querySelectorAll: (selector: string) => selector === '.img-frame.iframe-frame' ? [frame] : [] } as unknown as HTMLElement
  let cleanup = observe_image_placeholders(root)
  expect(attributes.get('aria-busy')).toBe('true')
  iframe.dispatchEvent(new Event('load'))
  expect(frame.dataset.imageLoaded).toBe('')
  expect(attributes.has('aria-busy')).toBe(false)
  cleanup()
  cleanup = observe_image_placeholders(root)
  expect(frame.dataset.imageLoaded).toBe('')
  cleanup()
  iframe = Object.assign(new EventTarget(), { contentWindow: null, contentDocument: null })
  cleanup = observe_image_placeholders(root)
  expect(frame.dataset.imageLoaded).toBeUndefined()
  expect(attributes.get('aria-busy')).toBe('true')
  cleanup()
})

it('settles a cross-origin iframe that loaded before observation', () => {
  const iframe = Object.assign(new EventTarget(), { contentWindow: {}, contentDocument: null })
  const frame = { dataset: {} as Record<string, string>, setAttribute: () => {}, removeAttribute: () => {}, querySelector: () => iframe }
  const root = { querySelectorAll: (selector: string) => selector === '.img-frame.iframe-frame' ? [frame] : [] } as unknown as HTMLElement
  const cleanup = observe_image_placeholders(root)
  expect(frame.dataset.imageLoaded).toBe('')
  cleanup()
})
