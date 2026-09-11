// Sticky heading layout for a rendered story body: JS nests sections by
// heading level so a pinned chapter title survives its subsections and is
// pushed away only by the next same-or-higher-level heading. All functions
// are idempotent — re-measuring on resize or re-render is safe.

/**
    Wrap the flat rendered blocks into NESTED sections: a heading opens a
   section inside the nearest lower-level heading's section (h2 under h1,
   ...).
 */
export function wrap_heading_sections(body: HTMLElement) {
  const open: { level: number, section: HTMLElement }[] = []
  for (const child of [... body.children]) {
    const match = /^H([1-6])$/.exec(child.tagName)
    if (! match) {
      open.at(- 1)?.section.append(child)
      continue
    }
    const level = Number(match[1])
    while (open.length && open.at(- 1)!.level >= level) {
      open.pop()
    }
    const section = document.createElement('section')
    section.className = 'story-section'
    const parent = open.at(- 1)?.section
    if (parent) {
      parent.append(section)
    }
    else {
      child.before(section)
    }
    section.append(child)
    open.push({ level, section })
  }
}

/**
    A pinned heading starts exiting when its section's bottom edge reaches it,
   but collapsed margins put that edge ahead of the next heading's box, so the
   exit visibly starts too early. The sticky constraint uses the section's
   CONTENT box (padding doesn't move it) against the heading's bottom MARGIN
   edge, so extend the flow with a spacer: swallow the leading collapsed
   margin, add the gap plus the heading's bottom margin as height, and pull
   the layout back with an equal negative section margin. The incoming
   heading then physically pushes the pinned one away. Deepest sections
   first: once a leaf's edge is extended, ancestors sharing the boundary
   measure a negative gap and skip.
 */
export function compensate_section_push(body: HTMLElement) {
  // Both offsetTop and getBoundingClientRect report a pinned sticky
  // heading's displaced visual position, which explodes the gap whenever
  // this runs while scrolled deep (observer refire, editor re-render,
  // restored scroll, sync refetch). Suspend sticky for the measurement;
  // the synchronous block never paints the intermediate state.
  body.classList.add('measuring')
  try {
    const sections = [... body.querySelectorAll<HTMLElement>('.story-section')].reverse()
    for (const section of sections) {
      let boundary: Element | null = null
      for (let el: Element | null = section; el && el !== body; el = el.parentElement) {
        if (el.nextElementSibling) {
          boundary = el.nextElementSibling
          break
        }
      }
      const heading = section.firstElementChild
      const next_heading = boundary?.firstElementChild
      if (! (heading instanceof HTMLElement)
        || ! (next_heading instanceof HTMLElement)
        || ! /^H[1-6]$/.test(next_heading.tagName)) {
        continue
      }
      const gap = next_heading.offsetTop - (section.offsetTop + section.offsetHeight)
      if (gap <= 1) {
        continue
      }
      const heading_mb = Number.parseFloat(getComputedStyle(heading).marginBottom) || 0
      const next_mt = Number.parseFloat(getComputedStyle(next_heading).marginTop) || 0
      const before = section.offsetTop + section.offsetHeight
      const spacer = document.createElement('div')
      section.append(spacer)
      spacer.style.marginTop = `${before - spacer.offsetTop}px`
      spacer.style.height = `${gap + heading_mb}px`
      section.style.marginBottom = `${- (heading_mb + next_mt)}px`
    }
  }
  finally {
    body.classList.remove('measuring')
  }
}

/**
    Stack pinned headings by their ancestor sections' measured heading
   heights: h2 docks below the pinned h1, h3 below h1+h2, ... Measured (not
   fixed rem) so wrapped multi-line titles still stack right; rerun on
   resize.
 */
export function layout_heading_offsets(body: HTMLElement) {
  for (const heading of body.querySelectorAll<HTMLElement>('.story-section > :is(h1, h2, h3, h4, h5, h6)')) {
    let offset = 0
    // Only our own .story-section wrappers count as nesting ancestors; the
    // page also wraps the preview in plain <section> elements.
    let ancestor_section = heading.parentElement?.parentElement
    while (ancestor_section?.classList.contains('story-section')) {
      const ancestor = ancestor_section.firstElementChild
      if (ancestor instanceof HTMLElement) {
        offset += ancestor.offsetHeight
      }
      ancestor_section = ancestor_section.parentElement
    }
    heading.style.top = offset ? `calc(var(--app-header-height, 0px) + ${offset}px)` : ''
  }
}

/**
    Re-run the measured compensation and dock offsets whenever the body gains
   real size (a v-show-hidden preview reports all-zero rects at mount, so the
   measurements would silently skip). Returns a cleanup that disconnects the
   observer.
 */
export function observe_heading_layout(body: HTMLElement) {
  const observer = new ResizeObserver(() => {
    compensate_section_push(body)
    layout_heading_offsets(body)
  })
  observer.observe(body)
  return () => observer.disconnect()
}
