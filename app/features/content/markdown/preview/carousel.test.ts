// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setup_carousels } from './carousel'

let resize: () => void
let reduced = false
let cleanup: (() => void) | undefined
let serial = 0

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
  reduced = false
  vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: reduced }) as MediaQueryList)
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 10))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
})

afterEach(() => {
  cleanup?.()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function measure(carousel: HTMLElement, width = 1000, next_offset = 412) {
  const image = carousel.querySelector('img')
  if (image)
    Object.defineProperty(image, 'complete', { value: false, configurable: true })
  let left = 0
  Object.defineProperties(carousel, {
    scrollWidth: { value: width, configurable: true },
    clientWidth: { value: 400, configurable: true },
    scrollLeft: { get: () => left, set: value => left = Math.max(0, Math.min(value, carousel.scrollWidth - carousel.clientWidth)) },
  })
  Object.defineProperty(carousel.children[1], 'offsetLeft', { value: next_offset })
}

function mount(width = 1000, src = `/carousel-unit-${serial ++}.png`, body = `<img src="${src}">`) {
  document.body.innerHTML = `<div class="carousel-shell" style="--carousel-fade-width:48px"><button class="carousel-prev"></button><div class="image-carousel"><span>${body}</span><span></span></div><button class="carousel-next"></button></div>`
  const carousel = document.querySelector<HTMLElement>('.image-carousel')!
  measure(carousel, width)
  cleanup = setup_carousels(document.body)
  return carousel
}

function mount_nested(identity: string) {
  const controls = (body: string) => `<div class="carousel-shell" style="--carousel-fade-width:48px"><button class="carousel-prev"></button><div class="image-carousel">${body}</div><button class="carousel-next"></button></div>`
  document.body.innerHTML = controls(`<div class="carousel-content-item">${controls(`<span><img src="/${identity}.png"></span><span>inner text</span>`)}</div><div class="carousel-content-item">outer text</div>`)
  const [outer, inner] = [... document.querySelectorAll<HTMLElement>('.image-carousel')]
  measure(outer!, 1000, 612)
  measure(inner!)
  const button = (carousel: HTMLElement) => carousel.parentElement!.querySelector<HTMLButtonElement>(':scope > .carousel-next')!
  cleanup = setup_carousels(document.body)
  return { outer: outer!, inner: inner!, outer_next: button(outer!), inner_next: button(inner!) }
}

it.each(['restore', 'hidden', 'wheel', 'next'])('retains a clamped snapshot until media settles, with takeover=%s', (manual) => {
  const src = `/carousel-restore-${manual}.png`
  const previous = mount(1000, src)
  previous.scrollLeft = 600
  previous.dispatchEvent(new Event('scroll'))
  cleanup!()
  const carousel = mount(400, src)
  expect(carousel.scrollLeft).toBe(0)
  if (manual === 'hidden') {
    Object.defineProperty(carousel, 'clientWidth', { value: 0 })
    Object.defineProperty(carousel.querySelector('img'), 'complete', { value: true })
    resize()
    Object.defineProperty(carousel, 'clientWidth', { value: 400 })
  }
  vi.advanceTimersByTime(100)
  if (manual === 'wheel')
    carousel.dispatchEvent(new Event('wheel'))
  if (manual === 'next')
    document.querySelector<HTMLButtonElement>('.carousel-next')!.click()
  Object.defineProperty(carousel, 'scrollWidth', { value: 1000 })
  resize()
  expect(carousel.scrollLeft).toBe(['restore', 'hidden'].includes(manual) ? 600 : 0)
  if (['restore', 'hidden'].includes(manual)) {
    expect(carousel.style.getPropertyValue('--carousel-fade-l')).toBe('48px')
    expect(carousel.style.getPropertyValue('--carousel-fade-r')).toBe('0px')
  }
})

it.each(['iframe', 'file', 'folder', 'denied'])('restores %s-only strips independently of other strips without images', (kind) => {
  const content = (identity: string) => kind === 'iframe'
    ? `<iframe srcdoc="fixture" src="/${identity}"></iframe>`
    : kind === 'file'
      ? `<a href="/${identity}">file</a>`
      : kind === 'folder' ? `<span data-folder-card="${identity}">folder</span>` : `<span>${identity}</span>`
  const key = `independent-${kind}-${serial ++}`
  const original = mount(1000, '', content(key))
  original.scrollLeft = 420
  original.dispatchEvent(new Event('scroll'))
  cleanup!()
  const other = mount(1000, '', content(`${key}-other`))
  expect(other.scrollLeft).toBe(0)
  other.scrollLeft = 150
  other.dispatchEvent(new Event('scroll'))
  cleanup!()
  const restored = mount(1000, '', content(key))
  expect(restored.scrollLeft).toBe(420)
  expect(document.querySelector('.carousel-next')?.getAttribute('data-hint')).toBeNull()
})

it('distinguishes ordinary Markdown beside shared media and ignores runtime overlays when restoring', () => {
  const key = `mixed-markdown-${serial ++}`
  const content = (text: string) => `<img src="/${key}.png"><code>${text}</code>`
  const original = mount(1000, '', content('original text'))
  original.scrollLeft = 420
  original.dispatchEvent(new Event('scroll'))
  cleanup!()
  const other = mount(1000, '', content('different text'))
  expect(other.scrollLeft).toBe(0)
  other.scrollLeft = 150
  other.dispatchEvent(new Event('scroll'))
  cleanup!()
  const restored = mount(1000, '', `${content('original text')}<span class="long-img-cover">runtime crop text</span><span class="image-loading-mask">runtime loading text</span><span class="image-lqip"></span>`)
  expect(restored.scrollLeft).toBe(420)
})

it('releases old content snapshots while retaining recently used scroll positions', () => {
  const key = `snapshot-history-${serial ++}`
  const content = (identity: string) => `<code>${key}-${identity}</code>`
  const oldest = mount(1000, '', content('oldest'))
  oldest.scrollLeft = 240
  oldest.dispatchEvent(new Event('scroll'))
  cleanup!()
  const recent = mount(1000, '', content('recent'))
  recent.scrollLeft = 420
  recent.dispatchEvent(new Event('scroll'))
  cleanup!()
  for (let index = 0; index < 40; index ++) {
    mount(1000, '', content(String(index)))
    cleanup!()
    if (index % 10 === 0) {
      expect(mount(1000, '', content('recent')).scrollLeft).toBe(420)
      cleanup!()
    }
  }
  expect(mount(1000, '', content('oldest')).scrollLeft).toBe(0)
  cleanup!()
  expect(mount(1000, '', content('recent')).scrollLeft).toBe(420)
})

it('binds each nested shell to its own buttons', () => {
  reduced = true
  const { outer, inner, outer_next, inner_next } = mount_nested(`nested-buttons-${serial ++}`)
  const outer_scroll = vi.spyOn(outer, 'scrollTo')
  const inner_scroll = vi.spyOn(inner, 'scrollTo')
  inner_next.click()
  expect(inner_scroll).toHaveBeenCalledExactlyOnceWith({ left: 364, behavior: 'auto' })
  expect(outer_scroll).not.toHaveBeenCalled()
  outer_next.click()
  expect(outer_scroll).toHaveBeenCalledExactlyOnceWith({ left: 564, behavior: 'auto' })
  expect(inner_scroll).toHaveBeenCalledTimes(1)
})

it('restores outer and inner strips independently even when their only media destination is the same', () => {
  const identity = `nested-restore-${serial ++}`
  const original = mount_nested(identity)
  original.inner.dispatchEvent(new Event('scroll', { bubbles: true }))
  expect(original.outer_next.dataset.hint).toBe('true')
  expect(original.inner_next.dataset.hint).toBeUndefined()
  original.outer.scrollLeft = 510
  original.outer.dispatchEvent(new Event('scroll'))
  original.inner.scrollLeft = 120
  original.inner.dispatchEvent(new Event('scroll', { bubbles: true }))
  cleanup!()
  const restored = mount_nested(identity)
  expect(restored.outer.scrollLeft).toBe(510)
  expect(restored.inner.scrollLeft).toBe(120)
})

it.each(['wheel', 'pointerdown'])('keeps the outer scroll animation running after nested %s input', (type) => {
  vi.stubGlobal('CSS', { supports: () => false })
  const { outer, inner, outer_next, inner_next } = mount_nested(`nested-input-${type}-${serial ++}`)
  outer_next.click()
  inner_next.click()
  vi.advanceTimersByTime(100)
  const inner_left = inner.scrollLeft
  const target = type === 'wheel' ? inner.firstElementChild! : inner_next
  target.dispatchEvent(new Event(type, { bubbles: true }))
  vi.advanceTimersByTime(300)
  expect(outer.scrollLeft).toBe(564)
  expect(inner.scrollLeft).toBe(type === 'wheel' ? inner_left : 364)
})

it('skips authored spacing markers when navigating ordinary Markdown items', () => {
  reduced = true
  const carousel = mount(1000, '', '<code>ordinary item</code>')
  const space = document.createElement('span')
  space.className = 'carousel-space'
  Object.defineProperty(space, 'offsetLeft', { value: 100 })
  carousel.insertBefore(space, carousel.children[1]!)
  const scroll = vi.spyOn(carousel, 'scrollTo')
  document.querySelector<HTMLButtonElement>('.carousel-next')!.click()
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ left: 364, behavior: 'auto' })
})

it('advances when the first text item ends before the fade width', () => {
  reduced = true
  document.body.innerHTML = '<div class="carousel-shell" style="--carousel-fade-width:48px"><button class="carousel-prev"></button><div class="image-carousel"><span>短字</span><span>第二项</span><span>第三项</span></div><button class="carousel-next"></button></div>'
  const carousel = document.querySelector<HTMLElement>('.image-carousel')!
  measure(carousel, 840, 40)
  Object.defineProperty(carousel.children[2], 'offsetLeft', { value: 150 })
  cleanup = setup_carousels(document.body)
  const scroll = vi.spyOn(carousel, 'scrollTo')

  document.querySelector<HTMLButtonElement>('.carousel-next')!.click()

  expect(scroll).toHaveBeenCalledExactlyOnceWith({ left: 102, behavior: 'auto' })
})

it('updates fades after resize without restarting them on repeated observations and cancels on unmount', () => {
  const carousel = mount()
  const right = () => Number.parseFloat(carousel.style.getPropertyValue('--carousel-fade-r'))
  expect(right()).toBe(48)
  Object.defineProperty(carousel, 'scrollWidth', { value: 400 })
  resize()
  vi.advanceTimersByTime(150)
  expect(right()).toBeGreaterThan(0)
  expect(right()).toBeLessThan(48)
  resize()
  vi.advanceTimersByTime(150)
  expect(right()).toBe(0)
  Object.defineProperty(carousel, 'scrollWidth', { value: 1000 })
  resize()
  cleanup!()
  vi.advanceTimersByTime(400)
  expect(right()).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('smoothly scrolls without native support, yields to manual input and releases the fallback on unmount', () => {
  vi.stubGlobal('CSS', { supports: () => false })
  const carousel = mount()
  const next = document.querySelector<HTMLButtonElement>('.carousel-next')!
  next.click()
  vi.advanceTimersByTime(100)
  expect(carousel.scrollLeft).toBeGreaterThan(0)
  expect(carousel.scrollLeft).toBeLessThan(364)
  carousel.dispatchEvent(new Event('wheel'))
  const interrupted = carousel.scrollLeft
  vi.advanceTimersByTime(400)
  expect(carousel.scrollLeft).toBe(interrupted)
  next.click()
  vi.advanceTimersByTime(300)
  expect(carousel.scrollLeft).toBe(364)
  next.click()
  cleanup!()
  vi.advanceTimersByTime(400)
  expect(carousel.scrollLeft).toBe(364)
  expect(vi.getTimerCount()).toBe(0)
})

it('uses immediate fades and scrolling for reduced motion', () => {
  reduced = true
  const carousel = mount()
  const scroll = vi.spyOn(carousel, 'scrollTo')
  document.querySelector<HTMLButtonElement>('.carousel-next')!.click()
  expect(scroll).toHaveBeenCalledWith({ left: 364, behavior: 'auto' })
  carousel.scrollLeft = 600
  carousel.dispatchEvent(new Event('scroll'))
  expect(carousel.style.getPropertyValue('--carousel-fade-l')).toBe('48px')
  expect(carousel.style.getPropertyValue('--carousel-fade-r')).toBe('0px')
})
