<template>
  <MyDialog
    v-model:visible="visible"
    header="创建删减版"
    :pending="props.pending"
    :closable="! props.pending"
    panel-class="max-w-4xl"
  >
    <div v-if="loading" class="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
      <MyIcon name="lucide:loader-circle" class="animate-spin" />
      正在解密原图
    </div>

    <div v-else-if="load_error" class="py-10 text-center text-sm text-red-600 dark:text-red-400">
      {{ load_error }}
    </div>

    <div v-else class="space-y-3">
      <div class="overflow-hidden  rounded-sm border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800">
        <div
          ref="stage"
          class="redact-stage flex h-[60vh] overflow-auto"
          :class="{ 'redact-pan-ready': space_held, 'redact-panning': pan_state !== null }"
          @wheel="on_wheel"
          @contextmenu.prevent
          @pointerdown="on_stage_pointerdown"
          @pointermove="on_stage_pointermove"
          @pointerup="on_stage_pointerup"
          @pointercancel="on_stage_pointerup"
        >
          <!-- overflow-hidden also clips the brush preview at the edge, so a dot
             near the border can never widen the scroll area: an absolutely
             positioned box inside a scroll container contributes to its
             scrollable overflow, which would grow a scrollbar under the pointer
             and shift the whole image sideways mid-stroke. Strokes are clipped
             by the canvas the same way, so the preview stays honest. -->
          <div
            class="relative m-auto shrink-0 overflow-hidden"
            :style="{ width: `${display_width}px`, height: `${display_height}px` }"
          >
            <canvas
              ref="image_canvas"
              class="absolute inset-0 h-full w-full"
              :width="natural_size.width"
              :height="natural_size.height"
            />
            <canvas
              ref="stroke_canvas"
              class="redact-canvas absolute inset-0 h-full w-full touch-none"
              :class="{ 'redact-canvas-hidden': !! cursor_style }"
              :width="natural_size.width"
              :height="natural_size.height"
              @pointerdown="on_pointerdown"
              @pointermove="on_pointermove"
              @pointerup="on_pointerup"
              @pointercancel="on_pointerup"
              @pointerleave="on_cursor_leave"
            />
            <!-- The brush's own cross-section, so what is about to be covered is
               visible before the button goes down. -->
            <span
              v-if="cursor_style"
              class="redact-cursor pointer-events-none absolute rounded-full"
              :style="cursor_style"
              aria-hidden="true"
            />
            <!-- While the width slider is worked the pointer is on the slider,
               far from here, so the size being dialled in is previewed on the
               image itself. -->
            <Transition name="brush-preview">
              <span
                v-if="brush_preview_style"
                class="redact-cursor pointer-events-none absolute left-1/2 top-1/2 rounded-full"
                :style="brush_preview_style"
                aria-hidden="true"
              />
            </Transition>
          </div>
        </div>
      </div>

      <!-- One row: the width slider takes the space, the clear action sits at
           the far end. Undo/redo live on the keyboard only (Ctrl/Cmd+Z, +Y). -->
      <div class="flex items-center gap-4">
        <span class="flex min-w-0 flex-1 items-center gap-4 text-sm text-slate-600 dark:text-slate-300">
          <Slider
            v-model="brush_width"
            :min="1"
            :max="brush_width_max"
            :disabled="props.pending"
            class="min-w-32 flex-1"
            aria-label="画笔粗细"
            @change="on_brush_width_change"
          />
          <span class="shrink-0 w-10 text-xs tabular-nums text-slate-500 dark:text-slate-400">{{ brush_width }} px</span>
        </span>

        <Button
          aria-label="清空涂抹"
          severity="secondary"
          class="aspect-square shrink-0"
          :disabled="props.pending || ! strokes.length"
          @click="clear_strokes"
        >
          <template #icon>
            <MyIcon name="lucide:eraser" />
          </template>
        </Button>
      </div>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <Button label="取消" severity="secondary" text :disabled="props.pending" @click="visible = false" />
        <Button
          label="保存"
          :loading="props.pending"
          :disabled="props.pending || loading || !! load_error"
          @click="submit"
        >
          <template #icon>
            <MyIcon name="lucide:check" />
          </template>
        </Button>
      </div>
    </template>
  </MyDialog>
</template>

<script setup lang="ts">
import type { ContentStoryAttachment } from '@shared/types/content'
import type { RedactionStroke } from '~/utils/content/redact'
import { attachment_base_name, decrypted_attachment_name, redactable_attachment_mime } from '@shared/content-markdown'
import { decrypted_blob_url } from '~/utils/content/attachment-crypto'
import { encode_bmp, paint_redaction_stroke, paint_redaction_strokes } from '~/utils/content/redact'

interface Props {
  visible: boolean
  /** The encrypted image being redacted; null while the dialog is closed. */
  attachment: ContentStoryAttachment | null
  pending?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  pending: false,
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  'save': [file: File]
}>()

const static_url = useStaticUrl()
const { error: toast_error } = useMyToast()
const config = useRuntimeConfig().public
// A file-size cap does not bound the decoded size, and a small PNG can inflate
// into a canvas that exhausts the tab's memory.
const max_editable_dimension = config.content_redact_max_dimension
// Wheel-zoom responsiveness: the scale factor is exponential in the wheel
// delta, so a trackpad pinch and a mouse notch both feel proportional instead
// of jumping a fixed step per event.
const zoom_per_wheel_pixel = 0.0015
// A single event must never leap several steps (a fast trackpad flick arrives
// as one huge delta).
const wheel_zoom_factor_limit = 2

const visible = computed({
  get: () => props.visible,
  set: (value: boolean) => emit('update:visible', value),
})

const stage = ref<HTMLElement | null>(null)
const image_canvas = ref<HTMLCanvasElement | null>(null)
const stroke_canvas = ref<HTMLCanvasElement | null>(null)

const strokes = ref<RedactionStroke[]>([])
// Undo/redo is a snapshot list: a stroke is only committed once it ends, so
// stepping back through the drawing never has to replay segments. `strokes` is
// always a copy of the entry at `history_index`, which keeps the in-flight
// stroke's `points` pushes off the committed snapshots.
const history = ref<RedactionStroke[][]>([[]])
const history_index = ref(0)
const can_undo = computed(() => history_index.value > 0)
const can_redo = computed(() => history_index.value < history.value.length - 1)
const brush_width = ref(1)
const natural_size = ref({ width: 0, height: 0 })
const scale = ref(1)
const fit_scale = ref(1)
const loading = ref(false)
const load_error = ref('')
/** Pointer position within the image box (display px); null when it is not over it. */
const cursor_pos = ref<{ x: number, y: number } | null>(null)
/** Space held: the hand tool, as in every drawing app. */
const space_held = ref(false)
/** The in-flight pan drag; null when the viewport is not being dragged. */
const pan_state = ref<PanState | null>(null)
/** The width slider is being worked, so the brush size is previewed on the image. */
const brush_dragging = ref(false)
// Long enough to read the final size after the pointer is gone (a track click
// commits on release), short enough not to linger over the drawing.
const brush_preview_linger_ms = 250
let brush_preview_timer: ReturnType<typeof setTimeout> | null = null

let source_bitmap: ImageBitmap | null = null
let active_stroke: RedactionStroke | null = null
let active_pointer: number | null = null
/** Last pointer position in viewport coordinates, for re-deriving the preview. */
const cursor_client = { x: 0, y: 0 }

const twin_name = computed(() => props.attachment ? decrypted_attachment_name(props.attachment.file_name) : '')
const twin_base_name = computed(() => attachment_base_name(twin_name.value))
// Floored, not rounded: at the fit scale the display size is right at the
// stage's edge, and rounding could push it a pixel past it — enough for a
// scrollbar to appear and shove the image sideways.
const display_width = computed(() => Math.floor(natural_size.value.width * scale.value))
const display_height = computed(() => Math.floor(natural_size.value.height * scale.value))
// Derived from the image so one slider covers both a 400 px screenshot and a
// 6000 px scan without a second control.
const brush_width_max = computed(() => Math.max(8, Math.round(Math.min(natural_size.value.width, natural_size.value.height) * 0.5)))

/** Diameter the stroke will cover on screen: brush width in image pixels × zoom. */
const cursor_style = computed(() => {
  const position = cursor_pos.value
  // A pan gesture is not aiming a brush, so the preview steps aside.
  if (! position || props.pending || space_held.value || pan_state.value)
    return null
  const diameter = Math.max(1, brush_width.value * scale.value)
  return {
    left: `${position.x}px`,
    top: `${position.y}px`,
    width: `${diameter}px`,
    height: `${diameter}px`,
    marginLeft: `${- diameter / 2}px`,
    marginTop: `${- diameter / 2}px`,
  }
})

/**
 * The width being dialled in, drawn in the middle of the image while the width
 * changes. Centred by half its own diameter, like the cursor follower, rather
 * than by a translate: that leaves `transform` to the enter/leave animation.
 */
const brush_preview_style = computed(() => {
  if (! brush_dragging.value)
    return null
  const diameter = Math.max(1, brush_width.value * scale.value)
  return {
    width: `${diameter}px`,
    height: `${diameter}px`,
    marginLeft: `${- diameter / 2}px`,
    marginTop: `${- diameter / 2}px`,
  }
})

/**
 * Shows the width preview whenever the width actually changes, and keeps it up
 * briefly afterwards so the final size is readable.
 *
 * Driven by the value rather than by the press: the slider commits a click on
 * the track on release (its own drag start never fires for one, and the value
 * lands after the pointer is gone), so a press-driven preview rendered the
 * *previous* width and vanished again before the new one was ever visible.
 * The knob still shows its diameter while it is being dragged, because every
 * drag movement is a value change; only a press with no movement shows nothing,
 * which is when there is nothing to preview anyway.
 */
function on_brush_width_change() {
  if (props.pending)
    return
  brush_dragging.value = true
  if (brush_preview_timer)
    clearTimeout(brush_preview_timer)
  brush_preview_timer = setTimeout(hide_brush_preview, brush_preview_linger_ms)
}

function hide_brush_preview() {
  if (brush_preview_timer) {
    clearTimeout(brush_preview_timer)
    brush_preview_timer = null
  }
  brush_dragging.value = false
}

async function load_source() {
  const file = props.attachment
  if (! file?.encryption_key) {
    load_error.value = '缺少解密密钥，无法编辑该附件'
    return
  }
  loading.value = true
  load_error.value = ''
  try {
    const blob_url = await decrypted_blob_url(static_url(file.url), file.encryption_key, file.mime_type)
    const blob = await (await fetch(blob_url)).blob()
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    if (bitmap.width > max_editable_dimension || bitmap.height > max_editable_dimension) {
      bitmap.close()
      load_error.value = `图片尺寸超过 ${max_editable_dimension} px，无法在浏览器中编辑`
      return
    }
    source_bitmap = bitmap
    natural_size.value = { width: bitmap.width, height: bitmap.height }
    brush_width.value = Math.max(4, Math.round(Math.min(bitmap.width, bitmap.height) * 0.05))
  }
  catch {
    load_error.value = '原图解密失败，请稍后重试'
    return
  }
  finally {
    loading.value = false
  }
  // The canvases only exist once the loading branch is gone, and they take
  // their size from `natural_size`, so the first paint has to wait for them.
  await nextTick()
  draw_source()
  fit_to_stage()
}

/** Redraws the overlay from the stroke model (after an undo or a clear). */
function draw_strokes() {
  const canvas = stroke_canvas.value
  if (! canvas)
    return
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  const ctx = canvas.getContext('2d')
  if (ctx)
    paint_redaction_strokes(ctx, strokes.value)
}

function draw_source() {
  const canvas = image_canvas.value
  const ctx = canvas?.getContext('2d')
  if (! canvas || ! ctx || ! source_bitmap)
    return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(source_bitmap, 0, 0)
}

function fit_to_stage() {
  const box = stage.value
  const { width, height } = natural_size.value
  if (! box || ! width || ! height)
    return
  fit_scale.value = Math.min(1, box.clientWidth / width, box.clientHeight / height)
  scale.value = fit_scale.value
}

/** Zoom stops at the native size (upscaling only blurs) and never below the fit. */
function clamp_scale(value: number) {
  return Math.min(1, Math.max(fit_scale.value, value))
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
  if (! box || ! canvas || props.pending || loading.value || load_error.value)
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
  return event.button === 1 || (event.button === 0 && space_held.value)
}

function on_stage_pointerdown(event: PointerEvent) {
  const box = stage.value
  if (! box || props.pending || ! is_pan_gesture(event))
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

function on_pointerdown(event: PointerEvent) {
  // Secondary buttons belong to the browser menu, a drag already in flight
  // (a second finger) must not hijack the stroke, and a pan gesture belongs to
  // the stage — the canvas must not also start drawing under it.
  if (props.pending || event.button > 0 || active_pointer !== null || is_pan_gesture(event))
    return
  update_cursor(event)
  const canvas = stroke_canvas.value
  const ctx = canvas?.getContext('2d')
  if (! canvas || ! ctx)
    return
  event.preventDefault()
  active_pointer = event.pointerId
  canvas.setPointerCapture(event.pointerId)
  const point = to_image_point(event)
  active_stroke = { width: brush_width.value, points: [point] }
  strokes.value.push(active_stroke)
  paint_redaction_stroke(ctx, active_stroke, 0)
}

function on_pointermove(event: PointerEvent) {
  update_cursor(event)
  const stroke = active_stroke
  const ctx = stroke_canvas.value?.getContext('2d')
  if (! stroke || ! ctx || event.pointerId !== active_pointer)
    return
  event.preventDefault()
  const point = to_image_point(event)
  const previous = stroke.points[stroke.points.length - 1]!
  stroke.points.push(point)
  // Only the fresh segment is painted; a full repaint would be O(strokes) per move.
  paint_redaction_stroke(ctx, { width: stroke.width, points: [previous, point] }, 0)
}

function on_pointerup(event: PointerEvent) {
  if (event.pointerId !== active_pointer)
    return
  const canvas = stroke_canvas.value
  if (canvas?.hasPointerCapture(event.pointerId))
    canvas.releasePointerCapture(event.pointerId)
  active_pointer = null
  active_stroke = null
  commit_strokes()
}

/** Records the current drawing as the newest history entry. */
function commit_strokes() {
  const snapshot = strokes.value
  history.value = [... history.value.slice(0, history_index.value + 1), snapshot]
  history_index.value = history.value.length - 1
  strokes.value = [... snapshot]
}

/** Steps to a history entry and repaints the overlay from it. */
function goto_history(index: number) {
  history_index.value = index
  strokes.value = [... history.value[index] ?? []]
  draw_strokes()
}

function undo() {
  if (can_undo.value)
    goto_history(history_index.value - 1)
}

function redo() {
  if (can_redo.value)
    goto_history(history_index.value + 1)
}

function clear_strokes() {
  if (! strokes.value.length)
    return
  strokes.value = []
  draw_strokes()
  commit_strokes()
}

// Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y) are the drawing equivalents of
// the buttons, live only while the dialog is open. A drag in progress owns the
// history: stepping it mid-stroke would strand the live stroke's points.
function on_keydown(event: KeyboardEvent) {
  // Space is the pan modifier, so it is watched regardless of other modifiers.
  if (event.code === 'Space') {
    // An element that types or opens on Space keeps it.
    if (uses_space_key(event.target))
      return
    // The dialog's own buttons (close, save, undo...) are what holds focus, and
    // a button activates on Space *keyup*. Swallowing the keydown is what stops
    // the focused button from taking the gesture: without it, holding Space to
    // pan also clicked that button on release and closed the dialog out from
    // under the drag. Enter still activates a focused button.
    event.preventDefault()
    space_held.value = true
    return
  }
  if (! (event.ctrlKey || event.metaKey) || props.pending || active_pointer !== null)
    return
  const key = event.key.toLowerCase()
  if (key === 'z' && ! event.shiftKey) {
    event.preventDefault()
    undo()
  }
  else if ((key === 'z' && event.shiftKey) || key === 'y') {
    event.preventDefault()
    redo()
  }
}

function on_keyup(event: KeyboardEvent) {
  if (event.code === 'Space')
    space_held.value = false
}

/** Input types whose field consumes Space as a character. */
const text_input_types = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'datetime-local', 'month', 'week', 'time'])

/**
 * Whether the focused element has its own use for Space, where the hand tool
 * must not interfere. Buttons are deliberately not on this list: they are what
 * holds focus when the dialog opens, and taking their Space is the point.
 */
function uses_space_key(target: EventTarget | null) {
  const element = target as HTMLElement | null
  if (! element)
    return false
  if (element.isContentEditable)
    return true
  const tag = element.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT')
    return true
  // A range slider also lands here as an <input>, but Space does nothing to it,
  // and the width slider is the one control a user is likely to have focused —
  // requiring a click elsewhere before panning would be its own annoyance.
  return tag === 'INPUT' && text_input_types.has(((element as HTMLInputElement).type || 'text').toLowerCase())
}

/** Flattens the source and the strokes into the file the server will store. */
async function export_file() {
  const mime_type = props.attachment ? redactable_attachment_mime(props.attachment.file_name) : null
  const { width, height } = natural_size.value
  if (! mime_type || ! source_bitmap || ! width || ! height)
    throw new Error('无法导出删减版')

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (! ctx)
    throw new Error('无法导出删减版')
  // JPEG and BMP have no alpha channel, and an unpainted JPEG composited by the
  // encoder would go black, so those two flatten onto white first.
  if (mime_type === 'image/jpeg' || mime_type === 'image/bmp') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
  }
  ctx.drawImage(source_bitmap, 0, 0)
  paint_redaction_strokes(ctx, strokes.value)

  const blob = mime_type === 'image/bmp'
    ? new Blob([encode_bmp(ctx.getImageData(0, 0, width, height))], { type: mime_type })
    : await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(result => result ? resolve(result) : reject(new Error('无法导出删减版')), mime_type)
      })
  return new File([blob], twin_base_name.value, { type: mime_type })
}

async function submit() {
  if (props.pending || loading.value)
    return
  try {
    const file = await export_file()
    emit('save', file)
  }
  catch {
    toast_error('导出删减版失败')
  }
}

// Every open starts from a clean slate: a previous image's strokes must never
// be replayed onto a new one.
watch(() => props.visible, (open) => {
  if (! open) {
    stop_key_listeners()
    hide_brush_preview()
    source_bitmap?.close()
    source_bitmap = null
    strokes.value = []
    history.value = [[]]
    history_index.value = 0
    active_stroke = null
    active_pointer = null
    cursor_pos.value = null
    pan_state.value = null
    natural_size.value = { width: 0, height: 0 }
    return
  }
  start_key_listeners()
  void load_source()
}, { immediate: true })

// The listener block is client-only: setup runs on the server too (the dialog
// is always mounted so its leave transition can play), and the immediate run of
// this watcher would otherwise reach for `window` there.
function start_key_listeners() {
  if (import.meta.server)
    return
  window.addEventListener('keydown', on_keydown)
  window.addEventListener('keyup', on_keyup)
  // A keyup that lands outside the window would otherwise leave the hand tool
  // stuck on, with no way to tell it apart from a held key.
  window.addEventListener('blur', release_space)
}

function stop_key_listeners() {
  if (import.meta.server)
    return
  window.removeEventListener('keydown', on_keydown)
  window.removeEventListener('keyup', on_keyup)
  window.removeEventListener('blur', release_space)
  release_space()
}

function release_space() {
  space_held.value = false
}

onBeforeUnmount(() => {
  stop_key_listeners()
  hide_brush_preview()
})
</script>

<style scoped>
/* Hidden only while the preview stands in for it, so the pointer is never left
   without a visible cursor (a finger, a pending save, the first entry). */
.redact-canvas {
  cursor: crosshair;
}

.redact-canvas-hidden {
  cursor: none;
}

/* The stroke's cross-section: a circle of the brush's on-screen diameter,
   carrying the stroke's own black, ringed in white so it reads on dark and
   light content alike. Kept translucent so the content about to be covered
   stays visible while aiming. The ring is a box-shadow, so it adds no size the
   layout has to account for. */
.redact-cursor {
  background-color: theme('colors.slate.950 / 0.7');
  box-shadow: 0 0 0 1px theme('colors.white / 0.7');
}

/* The centred width preview emerges and dissolves instead of blinking in and
   out. It keeps its final size throughout and only fades with a slight settle,
   because the circle's diameter is the whole message — scaling it up from
   nothing would misreport the size it exists to show. */
.brush-preview-enter-active,
.brush-preview-leave-active {
  transition: opacity 150ms ease-out, transform 150ms ease-out;
}

.brush-preview-enter-from,
.brush-preview-leave-to {
  opacity: 0;
  transform: scale(0.9);
}

/* While the viewport is what a drag moves, the cursor must report the drag
   rather than the brush sitting under it — and with Space held it has to say so
   before the button goes down, which is the only hint the hand tool exists. */
.redact-pan-ready,
.redact-pan-ready .redact-canvas {
  cursor: grab;
}

.redact-panning,
.redact-panning .redact-canvas {
  cursor: grabbing;
}
</style>
