export interface ScrollToOptions {
  offset?: number
  behavior?: ScrollBehavior
}

export function scroll_to(element: HTMLElement | null | undefined, options: ScrollToOptions = {}) {
  if (! element) {
    return
  }

  const header = document.querySelector('header')
  const header_height = header?.offsetHeight ?? 0
  const offset = options.offset ?? 16
  const top = element.getBoundingClientRect().top + window.scrollY - header_height - offset

  window.scrollTo({ top, behavior: options.behavior ?? 'smooth' })
}
