const loaded_iframes = new WeakSet<HTMLIFrameElement>()

/** A representation switch must not reuse the previous image's settled state. */
export function reset_image_placeholder(image: HTMLImageElement) {
  const frame = image.parentElement
  if (! frame)
    return
  delete frame.dataset.imageLoaded
  delete frame.dataset.imageError
  frame.setAttribute('aria-busy', 'true')
}

/** DOM-owned loading state, including raw formats without an LQIP. */
export function observe_image_placeholders(root: HTMLElement) {
  const cleanups: (() => void)[] = []
  root.querySelectorAll<HTMLImageElement>('.img-frame > img').forEach((image) => {
    const frame = image.parentElement!
    reset_image_placeholder(image)
    const loaded = () => {
      if (image.naturalWidth > 0) {
        frame.dataset.imageLoaded = ''
        delete frame.dataset.imageError
        frame.removeAttribute('aria-busy')
      }
    }
    const failed = () => {
      delete frame.dataset.imageLoaded
      frame.dataset.imageError = ''
      frame.removeAttribute('aria-busy')
    }
    image.addEventListener('load', loaded)
    image.addEventListener('error', failed)
    if (image.complete)
      image.naturalWidth > 0 ? loaded() : failed()
    cleanups.push(() => {
      image.removeEventListener('load', loaded)
      image.removeEventListener('error', failed)
    })
  })
  root.querySelectorAll<HTMLElement>('.img-frame.iframe-frame').forEach((frame) => {
    const iframe = frame.querySelector<HTMLIFrameElement>(':scope > iframe')
    if (! iframe) {
      frame.dataset.imageError = ''
      frame.removeAttribute('aria-busy')
      return
    }
    const loaded = () => {
      loaded_iframes.add(iframe)
      frame.dataset.imageLoaded = ''
      delete frame.dataset.imageError
      frame.removeAttribute('aria-busy')
    }
    delete frame.dataset.imageLoaded
    delete frame.dataset.imageError
    frame.setAttribute('aria-busy', 'true')
    iframe.addEventListener('load', loaded)
    if (loaded_iframes.has(iframe)) {
      loaded()
    }
    else {
      // A cross-origin player may finish before hydration attaches the load
      // listener. Once its document is inaccessible, navigation has committed.
      try {
        if (iframe.contentWindow && ! iframe.contentDocument)
          loaded()
      }
      catch {
        loaded()
      }
    }
    cleanups.push(() => iframe.removeEventListener('load', loaded))
  })
  return () => cleanups.forEach(cleanup => cleanup())
}
