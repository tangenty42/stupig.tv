const loaded_iframes = new WeakSet<HTMLIFrameElement>()
const loaded_image_requests = new WeakMap<HTMLImageElement, string>()

function image_request_key(image: HTMLImageElement) {
  return JSON.stringify([image.getAttribute('src'), image.getAttribute('srcset'), image.src, image.currentSrc])
}

function css_time_ms(value: string) {
  const time = value.trim()
  return Number.parseFloat(time) * (time.endsWith('ms') ? 1 : 1000)
}

export type ImageLoadState = 'loading' | 'loaded' | 'error'

/** `complete` is also true for an empty img; only classify an actual request. */
export function image_load_state(image: HTMLImageElement): ImageLoadState {
  const source = image.getAttribute('src')?.trim()
  const sources = image.getAttribute('srcset')?.trim()
  const selected = image.currentSrc
  if (! source && ! sources && ! selected)
    return 'loading'
  if (! image.complete)
    return 'loading'
  // Reassigning src may temporarily leave the previous request's cached image.
  // Responsive candidates legitimately differ from the fallback src.
  if (source && ! sources && selected && image.src && selected !== image.src)
    return 'loading'
  return image.naturalWidth > 0 ? 'loaded' : 'error'
}

function set_image_state(frame: HTMLElement, state: ImageLoadState) {
  delete frame.dataset.imageLoaded
  delete frame.dataset.imageError
  delete frame.dataset.imageReady
  if (state === 'loading') {
    frame.setAttribute('aria-busy', 'true')
  }
  else {
    frame.dataset[state === 'loaded' ? 'imageLoaded' : 'imageError'] = ''
    frame.removeAttribute('aria-busy')
  }
}

/** A representation switch must not reuse the previous image's settled state. */
export function reset_image_placeholder(image: HTMLImageElement) {
  const frame = image.parentElement
  if (! frame)
    return
  loaded_image_requests.delete(image)
  set_image_state(frame, 'loading')
}

/** DOM-owned loading state, including raw formats without an LQIP. */
export function observe_image_placeholders(root: HTMLElement) {
  const cleanups: (() => void)[] = []
  const images = root.querySelectorAll<HTMLImageElement>('.img-frame > img')
  // A cached image can finish in the same render as its placeholder is inserted.
  // Resolve the loading styles once so those images also get a before-state.
  const cached = [... images].find(image => image_load_state(image) === 'loaded'
    && (image.parentElement?.dataset.imageLoaded === undefined || loaded_image_requests.get(image) !== image_request_key(image)))
  if (cached)
    void cached.offsetWidth
  images.forEach((image) => {
    const frame = image.parentElement!
    let active = true
    let resize: Animation | undefined
    let stop_breathing: (() => void) | undefined
    let waiting_request: string | undefined
    let decoding: { request: string } | undefined
    function cancel_breathing() {
      stop_breathing?.()
      stop_breathing = undefined
      waiting_request = undefined
    }
    const update = (state: ImageLoadState) => {
      if (! active || image.parentElement !== frame)
        return
      // Extend the visual crossfade to the frame when its intrinsic size was unknown.
      const from = typeof frame.animate === 'function' ? frame.getBoundingClientRect() : null
      resize?.cancel()
      resize = undefined
      set_image_state(frame, state)
      if (state === 'loaded')
        loaded_image_requests.set(image, image_request_key(image))
      else
        loaded_image_requests.delete(image)
      if (! from?.width || ! from.height)
        return
      const style = getComputedStyle(frame)
      const duration = css_time_ms(style.getPropertyValue('--image-state-duration'))
      if (! (duration > 0))
        return
      const to = frame.getBoundingClientRect()
      const sizes = (box: DOMRect) => ({ width: `${box.width}px`, height: `${box.height}px` })
      if (from.width !== to.width || from.height !== to.height)
        resize = frame.animate([sizes(from), sizes(to)], { duration, easing: style.getPropertyValue('--image-state-easing').trim() || 'ease' })
    }
    function wait_for_breathing(layer: HTMLElement, request: string) {
      const style = getComputedStyle(layer, '::before')
      const index = style.animationName.split(',').findIndex(name => name.trim() === 'image-placeholder-breathe')
      if (index < 0)
        return false
      const durations = style.animationDuration.split(',')
      const duration = css_time_ms(durations[index % durations.length]!)
      const play_states = style.animationPlayState.split(',')
      if (! (duration > 0) || play_states[index % play_states.length]?.trim() === 'paused')
        return false
      waiting_request = request
      const finish = () => {
        cancel_breathing()
        if (image_request_key(image) === request && image_load_state(image) === 'loaded')
          update('loaded')
      }
      const ended = (event: AnimationEvent) => {
        if (event.target === layer && event.pseudoElement === '::before' && event.animationName === 'image-placeholder-breathe')
          finish()
      }
      layer.addEventListener('animationiteration', ended)
      layer.addEventListener('animationcancel', ended)
      // Iteration events can be suppressed while hidden or when styles change.
      // Never hold a decoded image for longer than one breathing cycle.
      const timeout = setTimeout(finish, duration + 100)
      stop_breathing = () => {
        clearTimeout(timeout)
        layer.removeEventListener('animationiteration', ended)
        layer.removeEventListener('animationcancel', ended)
      }
      return true
    }
    function reveal_when_ready(layer: HTMLElement | null, request: string) {
      if (layer) {
        // Set up the clear image underneath the still-opaque LQIP before the fade.
        frame.dataset.imageReady = ''
        if (wait_for_breathing(layer, request))
          return
      }
      update('loaded')
    }
    const initial_state = image_load_state(image)
    const already_loaded = frame.dataset.imageLoaded !== undefined && initial_state === 'loaded' && loaded_image_requests.get(image) === image_request_key(image)
    if (! already_loaded)
      reset_image_placeholder(image)
    const loaded = () => {
      const state = image_load_state(image)
      if (state !== 'loaded') {
        decoding = undefined
        cancel_breathing()
        update(state)
        return
      }
      const request = image_request_key(image)
      if (decoding?.request === request || waiting_request === request)
        return
      cancel_breathing()
      decoding = undefined
      if (frame.dataset.imageLoaded !== undefined && loaded_image_requests.get(image) !== request)
        reset_image_placeholder(image)
      delete frame.dataset.imageReady
      const layer = frame.querySelector<HTMLElement>(':scope > .image-lqip')
      if (! layer || typeof image.decode !== 'function') {
        reveal_when_ready(layer, request)
        return
      }
      // The load event can arrive before the image has pixels ready to paint.
      const pending = { request }
      decoding = pending
      const finish_decode = () => {
        if (! active || decoding !== pending || image.parentElement !== frame)
          return
        decoding = undefined
        if (image_request_key(image) !== request)
          return
        const state = image_load_state(image)
        if (state === 'loaded')
          reveal_when_ready(layer, request)
        else if (state === 'error')
          update('error')
      }
      // Decode can reject on a source change. Use the live request and native
      // state to decide whether to display an error.
      void image.decode().then(finish_decode, finish_decode)
    }
    const failed = () => {
      decoding = undefined
      cancel_breathing()
      update('error')
    }
    image.addEventListener('load', loaded)
    image.addEventListener('error', failed)
    if (! already_loaded) {
      if (initial_state === 'loaded')
        loaded()
      else
        set_image_state(frame, initial_state)
    }
    cleanups.push(() => {
      active = false
      cancel_breathing()
      resize?.cancel()
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
