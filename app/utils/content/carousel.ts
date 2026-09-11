// Image carousel post-render wiring for a rendered story body. Each carousel
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

// v-html re-renders replace the whole story body on every edit; without a
// snapshot each keystroke would reset scroll position, nav visibility, and
// the dismissed first-scroll hint, flickering the buttons. Keyed by content
// so entries match the same carousel across re-renders.
const carousel_snapshots = new Map<string, CarouselSnapshot>()

// innerHTML drifts after setup (cropped-image markers), so key by the image
// src list which is fixed at render time.
function carousel_key(carousel: HTMLElement) {
  return [... carousel.querySelectorAll('img')].map(image => image.getAttribute('src')).join()
}

function update_carousel_navs(carousel: HTMLElement) {
  const shell = carousel.closest('.carousel-shell')
  const prev = shell?.querySelector<HTMLElement>('.carousel-prev')
  const next = shell?.querySelector<HTMLElement>('.carousel-next')
  if (! prev || ! next) {
    return
  }
  const max_left = carousel.scrollWidth - carousel.clientWidth
  const prev_on = carousel.scrollLeft > 1
  const next_on = carousel.scrollLeft < max_left - 1
  prev.dataset.on = String(prev_on)
  next.dataset.on = String(next_on)
  carousel_snapshots.set(carousel_key(carousel), {
    left: carousel.scrollLeft,
    prev: prev_on,
    next: next_on,
    hint: next.dataset.hint === 'true',
  })
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
  shell.dataset.wired = 'true'
  const update = () => update_carousel_navs(carousel)
  // Scroll to the start of the next/previous image rather than a raw
  // viewport step, so an image always lands at the strip's leading edge.
  // The landing target shifts back by the edge-fade width so the image
  // clears the faded zone instead of arriving underneath it, and the
  // search pivots on that same fade edge (active only once scrolled).
  const scroll_to_image = (direction: number) => {
    const max_left = carousel.scrollWidth - carousel.clientWidth
    const fade = carousel_fade_width(shell)
    const pivot = carousel.scrollLeft + (carousel.scrollLeft > 1 ? fade : 0)
    const offsets = [... carousel.children].map(child =>
      (child as HTMLElement).offsetLeft - carousel.offsetLeft)
    const target = direction > 0
      ? offsets.find(offset => offset > pivot + 1)
      : [... offsets].reverse().find(offset => offset < pivot - 1)
    const left = target === undefined
      ? (direction > 0 ? max_left : 0)
      : Math.max(target - fade, 0)
    carousel.scrollTo({ left: Math.min(left, max_left), behavior: 'smooth' })
  }
  const prev_button = shell.querySelector<HTMLElement>('.carousel-prev')
  const next_button = shell.querySelector<HTMLElement>('.carousel-next')
  prev_button?.addEventListener('click', () => scroll_to_image(- 1))
  next_button?.addEventListener('click', () => scroll_to_image(1))
  // First-scroll nudge: the next button shows a "右边还有" label until the
  // carousel is scrolled once, then data-hint is dropped for good.
  const snapshot = carousel_snapshots.get(carousel_key(carousel))
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
  carousel.addEventListener('scroll', () => {
    if (next_button?.dataset.hint) {
      delete next_button.dataset.hint
    }
    update()
  }, { passive: true })
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
  requestAnimationFrame(() => shell.classList.remove('carousel-no-fx'))
  setTimeout(() => shell.classList.remove('carousel-no-fx'), 100)
}

/** Wire every carousel in the body (unwired shells only). */
export function setup_carousels(body: HTMLElement) {
  body.querySelectorAll<HTMLElement>('.image-carousel').forEach(setup_carousel)
}
