import type { ImageSize } from '~/utils/content/image-edit'

interface ImageEditorViewportOptions {
  stage: Ref<HTMLElement | null>
  stroke_canvas: Ref<HTMLCanvasElement | null>
  natural_size: Ref<ImageSize>
  busy: () => boolean
  loading: () => boolean
  load_error: () => string
  tool: () => 'move' | 'brush' | 'crop'
}

/** Viewport coordinates, zoom anchors and pan capture belong to this dialog. */
export function useImageEditorViewport(options: ImageEditorViewportOptions) {
  const { stage, stroke_canvas, natural_size } = options
  const scale = ref(1)
  const fit_scale = ref(1)
  const pan_state = ref<PanState | null>(null)
  const cursor_pos = ref<{ x: number, y: number } | null>(null)
  const space_held = ref(false)
  const cursor_client = { x: 0, y: 0 }
  const display_width = computed(() => Math.floor(natural_size.value.width * scale.value))
  const display_height = computed(() => Math.floor(natural_size.value.height * scale.value))
  const zoom_per_wheel_pixel = 0.0015
  const wheel_zoom_factor_limit = 2

  function fit_to_stage() {
    const box = stage.value
    const { width, height } = natural_size.value
    if (! box || ! width || ! height)
      return
    fit_scale.value = Math.min(box.clientWidth / width, box.clientHeight / height)
    scale.value = fit_scale.value
  }

  /** Magnify small images for editing; this changes the viewport, not export pixels. */
  function clamp_scale(value: number) {
    return Math.min(Math.max(16, fit_scale.value), Math.max(Math.min(1, fit_scale.value) / 4, value))
  }

  /**
   * Wheel deltas arrive in pixels, lines or pages depending on the device and
   * browser; everything here works in pixels so one sensitivity fits them all.
   */
  function wheel_delta_pixels(event: WheelEvent) {
    if (event.deltaMode === 1)
      return event.deltaY * 16
    if (event.deltaMode === 2)
      return event.deltaY * 100
    return event.deltaY
  }

  /**
   * Scrolling pans (natively — the stage is a scroll container, so momentum and
   * the browser's own axis handling come for free); Ctrl/Cmd + scroll zooms,
   * which is also what a trackpad pinch reports.
   *
   * The zoom is anchored at the pointer: the image point under the cursor is
   * measured before the scale changes and scrolled back under it afterwards, so
   * the spot being worked on stays put instead of drifting away, which is the
   * whole reason to zoom in.
   */
  async function on_wheel(event: WheelEvent) {
    if (! (event.ctrlKey || event.metaKey))
      return
    const box = stage.value
    const canvas = stroke_canvas.value
    if (! box || ! canvas || options.busy() || options.loading() || options.load_error())
      return
    // Also stops the browser's own page zoom, which is bound to the same gesture.
    event.preventDefault()
    const stage_rect = box.getBoundingClientRect()
    const canvas_rect = canvas.getBoundingClientRect()
    if (! canvas_rect.width || ! canvas_rect.height)
      return
    const fraction_x = (event.clientX - canvas_rect.left) / canvas_rect.width
    const fraction_y = (event.clientY - canvas_rect.top) / canvas_rect.height
    const raw_factor = Math.exp(- wheel_delta_pixels(event) * zoom_per_wheel_pixel)
    const factor = Math.min(wheel_zoom_factor_limit, Math.max(1 / wheel_zoom_factor_limit, raw_factor))
    const next = clamp_scale(scale.value * factor)
    if (next === scale.value)
      return
    scale.value = next
    // The scroll range only reflects the new size once it is in the DOM.
    await nextTick()
    // Assigned absolutely rather than nudged by a measured delta: once the image
    // overflows the stage the box sits at the content origin, so the offset that
    // puts the anchored point back under the pointer is a direct computation. A
    // before/after rect diff read a stale rect when wheel events arrived faster
    // than the DOM updated, and every correction then compounded the error —
    // which is what threw the brush preview around. Out-of-range values are
    // clamped by the browser, so a still-fitting image just stays centred.
    box.scrollLeft = fraction_x * display_width.value - (event.clientX - stage_rect.left)
    box.scrollTop = fraction_y * display_height.value - (event.clientY - stage_rect.top)
    refresh_cursor()
  }

  /**
   * Panning: the stage is the scroll container, so a drag just moves its scroll
   * offset — no transform, and it composes with the scrollbars, the wheel and
   * touch scrolling the browser already provides.
   */
  interface PanState {
    pointer_id: number
    client_x: number
    client_y: number
    scroll_left: number
    scroll_top: number
  }

  /**
   * The two gestures every drawing app shares: hold Space and drag, or drag with
   * the middle button. Space is what a stylus user falls back on; the middle
   * button is what a mouse user does.
   */
  function is_pan_gesture(event: PointerEvent) {
    return event.button === 1 || (event.button === 0 && (space_held.value || options.tool() === 'move'
      || (event.pointerType !== 'touch' && Boolean(event.ctrlKey || event.metaKey))))
  }

  function on_stage_pointerdown(event: PointerEvent) {
    const box = stage.value
    if (! box || options.busy() || ! is_pan_gesture(event))
      return
    event.preventDefault()
    // The brush preview belongs to the image, not to the viewport: hide it while
    // the viewport is what is moving.
    cursor_pos.value = null
    pan_state.value = {
      pointer_id: event.pointerId,
      client_x: event.clientX,
      client_y: event.clientY,
      scroll_left: box.scrollLeft,
      scroll_top: box.scrollTop,
    }
    // Capturing retargets the rest of the gesture here, so the canvas under the
    // pointer cannot start a stroke mid-pan.
    box.setPointerCapture(event.pointerId)
  }

  function on_stage_pointermove(event: PointerEvent) {
    const pan = pan_state.value
    const box = stage.value
    if (! pan || ! box || event.pointerId !== pan.pointer_id)
      return
    event.preventDefault()
    box.scrollLeft = pan.scroll_left - (event.clientX - pan.client_x)
    box.scrollTop = pan.scroll_top - (event.clientY - pan.client_y)
  }

  function on_stage_pointerup(event: PointerEvent) {
    const pan = pan_state.value
    if (! pan || event.pointerId !== pan.pointer_id)
      return
    const box = stage.value
    if (box?.hasPointerCapture(event.pointerId))
      box.releasePointerCapture(event.pointerId)
    pan_state.value = null
  }

  /** Pointer position in image pixels, so strokes survive any zoom. */
  function to_image_point(event: PointerEvent) {
    const canvas = stroke_canvas.value
    if (! canvas)
      return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: (event.clientX - rect.left) / rect.width * canvas.width,
      y: (event.clientY - rect.top) / rect.height * canvas.height,
    }
  }

  /**
   * The brush preview follows the pointer, sized to what the stroke would cover
   * on screen (image pixels × the current zoom). Shown for a mouse or a stylus
   * only: a finger has no hover, and there it would just flash over the drawing.
   */
  function update_cursor(event: PointerEvent) {
    if (event.pointerType === 'touch') {
      cursor_pos.value = null
      return
    }
    cursor_client.x = event.clientX
    cursor_client.y = event.clientY
    refresh_cursor()
  }

  /**
   * Re-derives the preview's offset from the last pointer position. Needed after
   * a zoom: the pointer has not moved, but the image under it has, and the wheel
   * fires no pointermove of its own — without this the dot stays at its old
   * offset and appears to jump away from the cursor.
   */
  function refresh_cursor() {
    const rect = stroke_canvas.value?.getBoundingClientRect()
    if (! rect)
      return
    cursor_pos.value = { x: cursor_client.x - rect.left, y: cursor_client.y - rect.top }
  }

  function on_cursor_leave() {
    cursor_pos.value = null
  }

  function reset() {
    const pan = pan_state.value
    if (pan && stage.value?.hasPointerCapture(pan.pointer_id))
      stage.value.releasePointerCapture(pan.pointer_id)
    pan_state.value = null
    cursor_pos.value = null
    space_held.value = false
  }
  return { scale, fit_scale, pan_state, cursor_pos, space_held, display_width, display_height, fit_to_stage, clamp_scale,
    on_wheel, on_stage_pointerdown, on_stage_pointermove, on_stage_pointerup,
    is_pan_gesture, to_image_point, update_cursor, on_cursor_leave, reset }
}
