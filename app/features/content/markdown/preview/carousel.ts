import { carousel_motion } from './carousel-motion'

// Carousel post-render wiring for a rendered story body. Each carousel
// gets its own scroll listener plus direct button clicks — no event
// delegation and no `disabled` toggling, so a button can never get stuck
// inert; visibility is driven purely by a data attribute recomputed from the
// live scroll position. Setup is idempotent per shell (data-wired).

interface CarouselSnapshot {
  left: number
  prev: boolean
  next: boolean
  hint: boolean
}

// Preview patches and remounts can replace a carousel; without a
// snapshot each keystroke would reset scroll position, nav visibility, and
// the dismissed first-scroll hint, flickering the buttons. Keyed by content
// so entries match the same carousel across re-renders. Bound retention as
// editing ordinary text produces new content keys.
const carousel_snapshots = new Map<string, CarouselSnapshot>()
const carousel_snapshot_limit = 32

// Include ordinary Markdown alongside media, but omit runtime-only overlays
// and controls. A nested shell is one content node, distinct from its own strip.
function carousel_content_identity(node: Node): unknown {
  if (node.nodeType === 3)
    return ['text', node.nodeValue]
  if (node.nodeType !== 1)
    return null
  const element = node as Element
  if (['carousel-nav', 'carousel-space', 'carousel-end-anchor', 'image-loading-mask', 'image-lqip', 'long-img-cover'].some(name => element.classList.contains(name))
    || element.hasAttribute('data-story-heading-spacer')) {
    return null
  }
  if (element.classList.contains('carousel-shell')) {
    const nested = element.querySelector(':scope > .image-carousel')
    return ['carousel', nested ? Array.from(nested.childNodes, carousel_content_identity).filter(value => value !== null) : []]
  }
  const attributes = ['src', 'href', 'data-folder-card', 'alt', 'title', 'type']
    .flatMap(name => element.hasAttribute(name) ? [[name, element.getAttribute(name)]] : [])
  return [element.tagName, attributes, Array.from(element.childNodes, carousel_content_identity).filter(value => value !== null)]
}

function carousel_key(carousel: HTMLElement) {
  return JSON.stringify(carousel_content_identity(carousel))
}

function update_carousel_navs(carousel: HTMLElement, prev: HTMLElement, next: HTMLElement, key: string, restore_left = 0) {
  const max_left = carousel.scrollWidth - carousel.clientWidth
  const prev_on = carousel.scrollLeft > 1
  const next_on = carousel.scrollLeft < max_left - 1
  prev.dataset.on = String(prev_on)
  next.dataset.on = String(next_on)
  carousel_snapshots.delete(key)
  carousel_snapshots.set(key, {
    left: restore_left || carousel.scrollLeft,
    prev: prev_on,
    next: next_on,
    hint: next.dataset.hint === 'true',
  })
  if (carousel_snapshots.size > carousel_snapshot_limit)
    carousel_snapshots.delete(carousel_snapshots.keys().next().value!)
  return { prev: prev_on, next: next_on }
}

// The fade width lives in CSS (--carousel-fade-width on .carousel-shell);
// resolve it to px here so nav jumps share that single source.
function carousel_fade_width(shell: HTMLElement) {
  const raw = getComputedStyle(shell).getPropertyValue('--carousel-fade-width').trim()
  if (raw.endsWith('rem')) {
    return Number.parseFloat(raw) * Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  }
  return Number.parseFloat(raw) || 0
}

function setup_carousel(carousel: HTMLElement) {
  const shell = carousel.closest<HTMLElement>('.carousel-shell')
  if (! shell || shell.dataset.wired) {
    return
  }
  const prev_button = shell.querySelector<HTMLElement>(':scope > .carousel-prev')
  const next_button = shell.querySelector<HTMLElement>(':scope > .carousel-next')
  if (! prev_button || ! next_button)
    return
  shell.dataset.wired = 'true'
  let active = true
  let initialized = false
  const key = carousel_key(carousel)
  const snapshot = carousel_snapshots.get(key)
  let restore_left = snapshot?.left ?? 0
  let frame: number | undefined
  const release_fx = () => {
    if (! restore_left)
      shell.classList.remove('carousel-no-fx')
  }
  const reduced_motion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const fades = carousel_motion([0, 0], ([left, right]) => {
    carousel.style.setProperty('--carousel-fade-l', `${left}px`)
    carousel.style.setProperty('--carousel-fade-r', `${right}px`)
  })
  let stop_scroll: (() => void) | undefined
  const update = () => {
    if (! active)
      return
    const restoring = restore_left > 0
    if (restoring) {
      // Old engines may clamp scrollLeft before the images regain intrinsic
      // dimensions. Keep the desired offset until layout can restore it or
      // every image has settled; never overwrite it with that temporary zero.
      carousel.scrollLeft = restore_left
      if (Math.abs(carousel.scrollLeft - restore_left) < 1
        || (carousel.clientWidth > 0 && [... carousel.querySelectorAll('img')].every(image => image.complete))) {
        restore_left = 0
      }
      if (! restore_left && initialized) {
        if (frame !== undefined)
          cancelAnimationFrame(frame)
        frame = requestAnimationFrame(release_fx)
      }
    }
    const navs = update_carousel_navs(carousel, prev_button, next_button, key, restore_left)
    const width = carousel_fade_width(shell)
    fades.set([navs.prev ? width : 0, navs.next ? width : 0], restoring || ! initialized || reduced_motion())
    initialized = true
  }
  // Align a target item just past the edge fade. Search past that offset
  // even at the start: a short first item can put its neighbor inside the
  // fade width, where trying to align that neighbor would not scroll.
  const scroll_to_item = (direction: number) => {
    restore_left = 0
    release_fx()
    const max_left = carousel.scrollWidth - carousel.clientWidth
    const fade = carousel_fade_width(shell)
    const pivot = carousel.scrollLeft + fade
    const offsets = [... carousel.children]
      .filter(child => ! child.classList.contains('carousel-space'))
      .map(child => (child as HTMLElement).offsetLeft - carousel.offsetLeft)
    const target = direction > 0
      ? offsets.find(offset => offset > pivot + 1)
      : [... offsets].reverse().find(offset => offset < pivot - 1)
    const left = target === undefined
      ? (direction > 0 ? max_left : 0)
      : Math.max(target - fade, 0)
    stop_scroll?.()
    const destination = Math.min(left, max_left)
    // Safari 13.1 has Element.scrollTo but no smooth scrolling. Animate the
    // same geometry through the public DOM API when native support is absent.
    if (reduced_motion() || CSS.supports('scroll-behavior', 'smooth')) {
      carousel.scrollTo({ left: destination, behavior: reduced_motion() ? 'auto' : 'smooth' })
    }
    else {
      const motion = carousel_motion([carousel.scrollLeft], ([value]) => carousel.scrollLeft = value!)
      stop_scroll = motion.stop
      motion.set([destination])
    }
  }
  const on_prev = () => scroll_to_item(- 1)
  const on_next = () => scroll_to_item(1)
  prev_button?.addEventListener('click', on_prev)
  next_button?.addEventListener('click', on_next)
  // First-scroll nudge: the next button shows a "右边还有" label until the
  // carousel is scrolled once, then data-hint is dropped for good.
  if (snapshot) {
    carousel.scrollLeft = snapshot.left
    if (prev_button) {
      prev_button.dataset.on = String(snapshot.prev)
    }
    if (next_button) {
      next_button.dataset.on = String(snapshot.next)
    }
  }
  if (next_button && snapshot?.hint !== false) {
    next_button.dataset.hint = 'true'
  }
  const on_scroll = (event: Event) => {
    if (event.target !== carousel)
      return
    if (! restore_left && next_button?.dataset.hint) {
      delete next_button.dataset.hint
    }
    update()
  }
  carousel.addEventListener('scroll', on_scroll, { passive: true })
  // Manual input takes over from the smooth-scroll fallback immediately.
  const interrupt_scroll = (event: Event) => {
    const target = event.target as Element | null
    const owner = target?.closest?.('.carousel-shell')
    if (owner && owner !== shell)
      return
    stop_scroll?.()
    restore_left = 0
    release_fx()
  }
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
    carousel.addEventListener(event, interrupt_scroll, { passive: true })
  // At setup the images are usually still loading, so the strip has no
  // overflow yet and no scroll event fires when its scrollWidth grows as
  // they load. Recompute whenever the strip or its items resize, and when
  // an image finishes loading (loads grow scrollWidth without resizing
  // any observed box; load doesn't bubble, so listen in capture).
  const observer = new ResizeObserver(update)
  observer.observe(carousel)
  for (const item of carousel.children) {
    observer.observe(item)
  }
  carousel.addEventListener('load', update, true)
  // Heading measurement above forces a style recalc before this setup runs,
  // so without suppression the restored data-on would animate in on every
  // editor re-render.
  shell.classList.add('carousel-no-fx')
  update()
  // rAF covers the visible case; the timeout frees hidden tabs where rAF
  // never fires.
  frame = requestAnimationFrame(release_fx)
  const timer = setTimeout(release_fx, 100)
  return () => {
    if (! active)
      return
    active = false
    fades.stop()
    stop_scroll?.()
    observer.disconnect()
    prev_button?.removeEventListener('click', on_prev)
    next_button?.removeEventListener('click', on_next)
    carousel.removeEventListener('scroll', on_scroll)
    carousel.removeEventListener('load', update, true)
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
      carousel.removeEventListener(event, interrupt_scroll)
    if (frame !== undefined)
      cancelAnimationFrame(frame)
    clearTimeout(timer)
    shell.classList.remove('carousel-no-fx')
    delete shell.dataset.wired
  }
}

/** Wire unwired shells and return the disposer for exactly those resources. */
export function setup_carousels(body: HTMLElement) {
  const cleanups = [... body.querySelectorAll<HTMLElement>('.image-carousel')].map(setup_carousel)
  return () => cleanups.forEach(cleanup => cleanup?.())
}
