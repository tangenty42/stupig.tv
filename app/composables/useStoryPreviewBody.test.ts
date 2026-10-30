import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { effectScope, nextTick, shallowRef, watch } from 'vue'
import { useStoryPreviewBody } from './useStoryPreviewBody'

// Only DOM resources are substituted. The owner and all enhancement helpers
// run unchanged; geometry / visible interaction is verified in the browser.
class ElementBoundary extends EventTarget {
  dataset: Record<string, string> = {}
  classList = { add: vi.fn(), remove: vi.fn() }
  style = { setProperty: vi.fn() }
  children: ElementBoundary[] = []
  scrollLeft = 0
  scrollWidth = 1000
  clientWidth = 400
  clientHeight = 200
  offsetLeft = 0
  naturalWidth = 100
  naturalHeight = 200
  complete = false
  parentElement: ElementBoundary | null = null
  querySelectorAll = vi.fn((_selector: string): ElementBoundary[] => [])
  querySelector = vi.fn((_selector: string): ElementBoundary | null => null)
  closest = vi.fn((_selector: string): ElementBoundary | null => null)
  getAttribute = vi.fn(() => 'test-image')
  setAttribute = vi.fn()
  removeAttribute = vi.fn()
  toggleAttribute = vi.fn()
  scrollTo = vi.fn()
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (callback) {
      if (! this.listeners.has(type))
        this.listeners.set(type, new Set())
      this.listeners.get(type)!.add(callback)
    }
    super.addEventListener(type, callback, options)
  }

  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (callback)
      this.listeners.get(type)?.delete(callback)
    super.removeEventListener(type, callback, options)
  }

  listener_count() {
    return [... this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0)
  }
}

class ObserverBoundary {
  static instances: ObserverBoundary[] = []
  targets = new Set<unknown>()
  constructor(readonly callback: ResizeObserverCallback) {
    ObserverBoundary.instances.push(this)
  }

  observe(target: unknown) { this.targets.add(target) }
  disconnect() { this.targets.clear() }
}

const fixtures: { unmount: () => void }[] = []
let window_target: ElementBoundary

beforeEach(() => {
  vi.useFakeTimers()
  ObserverBoundary.instances = []
  window_target = new ElementBoundary()
  for (const [name, value] of Object.entries({ watch, window: window_target, ResizeObserver: ObserverBoundary,
    getComputedStyle: () => ({ getPropertyValue: () => '48px' }),
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 16), cancelAnimationFrame: clearTimeout,
  })) vi.stubGlobal(name, value)
})

afterEach(() => {
  fixtures.splice(0).forEach(fixture => fixture.unmount())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function body_fixture() {
  const root = new ElementBoundary()
  const carousel = new ElementBoundary()
  const shell = new ElementBoundary()
  const prev = new ElementBoundary()
  const next = new ElementBoundary()
  const image = new ElementBoundary()
  const frame = new ElementBoundary()
  image.parentElement = frame
  carousel.children = [image]
  carousel.closest.mockReturnValue(shell)
  carousel.querySelectorAll.mockReturnValue([image])
  shell.querySelector.mockImplementation(selector => selector === '.carousel-prev' ? prev : next)
  root.querySelectorAll.mockImplementation((selector) => {
    if (selector === '.image-carousel')
      return [carousel]
    if (selector === '.img-frame > img' || selector === '.img-frame[data-lqip] > img')
      return [image]
    return []
  })
  return { root, carousel, shell, prev, next, image, frame,
    listener_count: () => [root, carousel, prev, next, image].reduce((count, target) => count + target.listener_count(), 0) }
}

function setup(patch?: (body: HTMLElement, html: string) => void) {
  const mounts: (() => void)[] = []
  const unmounts: (() => void)[] = []
  vi.stubGlobal('onMounted', (fn: () => void) => mounts.push(fn))
  vi.stubGlobal('onBeforeUnmount', (fn: () => void) => unmounts.push(fn))
  const scope = effectScope()
  const fixture = body_fixture()
  const body = shallowRef<HTMLElement | null>(fixture.root as unknown as HTMLElement)
  const html = shallowRef('initial')
  scope.run(() => useStoryPreviewBody(body, () => html.value, patch))
  let disposed = false
  const owner = { body, html, fixture, mount: () => mounts.forEach(fn => fn()), unmount() {
    if (disposed)
      return
    disposed = true
    unmounts.forEach(fn => fn())
    scope.stop()
  } }
  fixtures.push(owner)
  return owner
}

function active_observers() {
  return ObserverBoundary.instances.filter(observer => observer.targets.size).length
}

it('owns each observer, listener and scheduled carousel effect from mount through unmount', () => {
  const owner = setup()
  expect(active_observers()).toBe(0)
  owner.mount()
  expect(active_observers()).toBe(3)
  expect(owner.fixture.listener_count()).toBe(11)
  expect(window_target.listener_count()).toBe(1)
  expect(vi.getTimerCount()).toBe(2)
  owner.unmount()
  expect(active_observers()).toBe(0)
  expect(owner.fixture.listener_count()).toBe(0)
  expect(window_target.listener_count()).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(owner.fixture.shell.dataset.wired).toBeUndefined()
})

it('coalesces rapid render changes, releases old content and rewires the same body exactly once', async () => {
  const owner = setup()
  owner.mount()
  owner.html.value = 'edit one'
  owner.html.value = 'edit two'
  await nextTick()
  expect(ObserverBoundary.instances).toHaveLength(6)
  expect(active_observers()).toBe(3)
  expect(owner.fixture.listener_count()).toBe(11)
  expect(window_target.listener_count()).toBe(1)
  expect(vi.getTimerCount()).toBe(2)
  // An unchanged HTML string must not reinitialize the current v-html subtree.
  owner.html.value = 'edit two'
  await nextTick()
  expect(ObserverBoundary.instances).toHaveLength(6)
})

it('patches the live body before reacquiring its image and layout effects', async () => {
  const observations: { body: HTMLElement, html: string, observers: number }[] = []
  const owner = setup((body, html) => observations.push({ body, html, observers: active_observers() }))
  owner.mount()
  owner.html.value = 'typed'
  await nextTick()
  expect(observations).toEqual([
    { body: owner.body.value, html: 'initial', observers: 0 },
    { body: owner.body.value, html: 'typed', observers: 0 },
  ])
  expect(active_observers()).toBe(3)
  expect(owner.fixture.listener_count()).toBe(11)
})

it('releases the v-if body when empty and attaches to a new body when content returns', async () => {
  const owner = setup()
  owner.mount()
  owner.body.value = null
  owner.html.value = ''
  await nextTick()
  expect(active_observers()).toBe(0)
  expect(owner.fixture.listener_count()).toBe(0)
  const replacement = body_fixture()
  owner.body.value = replacement.root as unknown as HTMLElement
  owner.html.value = 'returned'
  await nextTick()
  expect(active_observers()).toBe(3)
  expect(replacement.listener_count()).toBe(11)
  owner.unmount()
  expect(replacement.listener_count()).toBe(0)
  expect(active_observers()).toBe(0)
})

it('cannot reacquire resources from a queued post-render watcher after unmount', async () => {
  const owner = setup()
  owner.mount()
  owner.html.value = 'queued'
  owner.unmount()
  await nextTick()
  expect(ObserverBoundary.instances).toHaveLength(3)
  expect(active_observers()).toBe(0)
  expect(owner.fixture.listener_count()).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('prevents detached images and late resize deliveries from changing retired DOM', () => {
  const owner = setup()
  owner.mount()
  const { image, frame, next } = owner.fixture
  const [carousel_observer, crop_observer, heading_observer] = ObserverBoundary.instances
  owner.unmount()
  const before = { ... next.dataset }
  const measurements = owner.fixture.root.classList.add.mock.calls.length
  image.dispatchEvent(new Event('load'))
  image.dispatchEvent(new Event('error'))
  carousel_observer!.callback([], {} as ResizeObserver)
  crop_observer!.callback([{ target: image }] as unknown as ResizeObserverEntry[], {} as ResizeObserver)
  heading_observer!.callback([], {} as ResizeObserver)
  expect(frame.toggleAttribute).not.toHaveBeenCalled()
  expect(frame.dataset).toEqual({})
  expect(next.dataset).toEqual(before)
  expect(owner.fixture.root.classList.add).toHaveBeenCalledTimes(measurements)
})
