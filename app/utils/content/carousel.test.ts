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

function mount(width = 1000, src = `/carousel-unit-${serial ++}.png`) {
  document.body.innerHTML = `<div class="carousel-shell" style="--carousel-fade-width:48px"><button class="carousel-prev"></button><div class="image-carousel"><span><img src="${src}"></span><span></span></div><button class="carousel-next"></button></div>`
  const carousel = document.querySelector<HTMLElement>('.image-carousel')!
  Object.defineProperty(carousel.querySelector('img'), 'complete', { value: false, configurable: true })
  let left = 0
  Object.defineProperties(carousel, {
    scrollWidth: { value: width, configurable: true },
    clientWidth: { value: 400, configurable: true },
    scrollLeft: { get: () => left, set: value => left = Math.max(0, Math.min(value, carousel.scrollWidth - carousel.clientWidth)) },
  })
  Object.defineProperty(carousel.children[1], 'offsetLeft', { value: 412 })
  cleanup = setup_carousels(document.body)
  return carousel
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
