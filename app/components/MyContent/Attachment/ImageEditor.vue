<template>
  <MyDialog
    v-model:visible="visible"
    :header="redacted ? '编辑删减版' : '编辑'"
    fullscreen
  >
    <div v-if="source_loading || loading" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 py-12 text-lg text-slate-500 dark:text-slate-400" role="status">
      <MyIcon name="lucide:loader-circle" class="animate-spin text-5xl" />
      <span>正在加载图片</span>
    </div>

    <div v-else-if="load_error" class="py-10 text-center text-sm text-red-600 dark:text-red-400">
      {{ load_error }}
    </div>

    <div v-else class="image-editor-workspace flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-200 px-3 py-2 dark:border-slate-700" role="toolbar" aria-label="图片编辑工具">
        <Button class="aspect-square" aria-label="向左旋转" title="向左旋转" severity="secondary" text @click="rotate(- 1)">
          <template #icon>
            <MyIcon name="lucide:rotate-ccw" />
          </template>
        </Button>
        <Button class="aspect-square" aria-label="向右旋转" title="向右旋转" severity="secondary" text @click="rotate(1)">
          <template #icon>
            <MyIcon name="lucide:rotate-cw" />
          </template>
        </Button>
        <Button class="aspect-square" aria-label="撤销" title="撤销" severity="secondary" text :disabled="! can_undo" @click="undo">
          <template #icon>
            <MyIcon name="lucide:undo-2" />
          </template>
        </Button>
        <Button class="aspect-square" aria-label="重做" title="重做" severity="secondary" text :disabled="! can_redo" @click="redo">
          <template #icon>
            <MyIcon name="lucide:redo-2" />
          </template>
        </Button>
        <Button size="small" label="适应窗口" severity="secondary" text @click="viewport.fit_to_stage()" />
        <Button size="small" label="原始比例" severity="secondary" text @click="scale = 1" />
        <span class="w-16 shrink-0 text-center text-xs tabular-nums text-slate-500" aria-label="当前缩放比例">{{ Math.round(scale * 100) }} %</span>
        <div class="ml-auto shrink-0">
          <Button label="回退原图" size="small" @click="! processing && request_reset($event)">
            <template #icon>
              <MyIcon name="lucide:step-back" />
            </template>
          </Button>
        </div>
      </div>
      <p class="hidden shrink-0 px-4 py-2 text-xs text-slate-500 sm:block">
        Ctrl + 滚轮缩放 · Ctrl / ⌘ 或空格 + 拖动平移 · 双指缩放／平移
      </p>
      <div
        class="min-h-0 flex-1 overflow-hidden bg-slate-100 touch-none dark:bg-slate-800"
        @pointerdown.capture="touch_start"
        @pointermove.capture="touch_move"
        @pointerup.capture="touch_end"
        @pointercancel.capture="touch_end"
      >
        <div
          ref="stage"
          class="redact-stage flex h-full overflow-auto touch-none"
          :class="{ 'redact-pan-ready': space_held || pan_modifier, 'redact-panning': pan_state !== null, 'redact-crop-moving': crop_drag?.handle === 'move' }"
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
              role="img"
              aria-label="图片编辑画布"
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
            <div class="redact-crop-frame pointer-events-none absolute border border-white touch-none" :style="crop_style" @pointermove="crop_move" @pointerup="crop_end" @pointercancel="crop_end">
              <span class="pointer-events-auto absolute inset-x-0 top-0 h-2 cursor-grab" @pointerdown="crop_start($event, 'move')" />
              <span class="pointer-events-auto absolute inset-x-0 bottom-0 h-2 cursor-grab" @pointerdown="crop_start($event, 'move')" />
              <span class="pointer-events-auto absolute inset-y-0 left-0 w-2 cursor-grab" @pointerdown="crop_start($event, 'move')" />
              <span class="pointer-events-auto absolute inset-y-0 right-0 w-2 cursor-grab" @pointerdown="crop_start($event, 'move')" />
              <span v-for="handle in crop_handles" :key="handle" class="pointer-events-auto absolute h-8 w-8 -translate-x-1/2 -translate-y-1/2 touch-none" :style="{ left: handle.includes('w') ? '0%' : handle.includes('e') ? '100%' : '50%', top: handle.includes('n') ? '0%' : handle.includes('s') ? '100%' : '50%', cursor: `${handle}-resize` }" @pointerdown="crop_start($event, handle)">
                <span class="redact-crop-handle absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 border border-white" />
              </span>
            </div>
            <!-- The brush's own cross-section, so what is about to be covered is
               visible before the button goes down. -->
            <span
              v-if="cursor_style"
              class="redact-cursor pointer-events-none absolute rounded-full"
              :class="{ 'redact-eraser': erasing }"
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
                :class="{ 'redact-eraser': erasing }"
                :style="brush_preview_style"
                aria-hidden="true"
              />
            </Transition>
          </div>
        </div>
      </div>

      <!-- Label each tool group so short action names retain their context. -->
      <div class="flex shrink-0 items-center gap-1 overflow-x-auto px-4 py-2" role="group" aria-label="裁剪">
        <span class="mr-2 shrink-0 text-xs text-slate-500">裁剪</span>
        <Button size="small" :label="crop_locked ? '比例已锁定' : '自由比例'" severity="secondary" text :aria-pressed="crop_locked" @click="crop_locked = ! crop_locked" />
        <Button size="small" label="重置" severity="secondary" text @click="cancel_crop" />
        <Button size="small" label="应用" class="ml-auto" @click="apply_crop">
          <template #icon>
            <MyIcon name="lucide:crop" />
          </template>
        </Button>
      </div>
      <div class="flex shrink-0 items-center gap-4 px-4 pb-3">
        <span class="shrink-0 text-xs text-slate-500">画笔</span>
        <span class="flex min-w-0 flex-1 items-center gap-4 text-sm text-slate-600 dark:text-slate-300">
          <Slider
            v-model="brush_width"
            :min="1"
            :max="brush_width_max"
            class="min-w-32 flex-1"
            aria-label="画笔粗细"
            @change="on_brush_width_change"
          />
        </span>

        <Button
          :aria-label="erasing ? '切换为画笔' : '切换为橡皮擦'"
          :title="erasing ? '切换为画笔' : '切换为橡皮擦'"
          :aria-pressed="erasing"
          severity="secondary"
          class="aspect-square shrink-0"
          @click="erasing = ! erasing"
        >
          <template #icon>
            <MyIcon :name="erasing ? 'lucide:paintbrush' : 'lucide:eraser'" />
          </template>
        </Button>
      </div>
    </div>

    <template #footer>
      <div class="flex w-full flex-col gap-3 sm:flex-row sm:items-end">
        <div class="min-w-0 flex-1 max-h-[25dvh] overflow-y-auto">
          <div class="space-y-2 text-sm">
            <p v-if="source_error" class="text-sm text-red-600">
              {{ source_error }}
            </p>
            <div class="flex flex-wrap items-center gap-3">
              <span v-if="redacted" class="text-slate-500">将发布删减版，保存后可公开读取</span>
              <Select v-else v-model="mode" size="small" input-id="image-save-mode" aria-label="保存模式" :options="modes" option-label="label" option-value="value" />
            </div>
            <div class="w-full max-w-sm">
              <MyFileNameInput v-model="display_name" :disabled="mode !== 'copy'" :suffix="mode === 'copy' ? '.avif' : original_name.locked" aria-label="新图片名称" />
            </div>
          </div>
        </div>
        <div class="flex shrink-0 justify-end gap-2">
          <Button size="small" label="取消" severity="secondary" text @click="visible = false" />
          <Button
            label="保存"
            @click="submit"
          >
            <template #icon>
              <MyIcon name="lucide:check" />
            </template>
          </Button>
        </div>
      </div>
    </template>
  </MyDialog>
</template>

<script setup lang="ts">
import type { ImageSaveMode } from '@shared/content-upload'
import type { ContentStoryAttachment } from '@shared/types/content'
import type { RedactionStroke } from '~/utils/content/redact'
import { split_attachment_editable_name } from '@shared/content-markdown'
import { settings } from '@shared/settings'
import { normalize_editor_crop, suggested_image_name } from '~/utils/content/image-edit'
import { paint_redaction_stroke } from '~/utils/content/redact'

interface Props {
  visible: boolean
  attachment: ContentStoryAttachment | null
  redacted?: boolean
  pending?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  pending: false,
  redacted: false,
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  'save': [file: File, mode: ImageSaveMode, name: string, basis: 'avif' | 'original']
}>()

const { error: toast_error } = useMyToast()
const { confirm_require } = useMyConfirm()
const { content } = useApi()
const mode = ref<ImageSaveMode>(props.redacted ? 'redacted' : 'overwrite')
const input_basis = ref<'avif' | 'original'>('avif')
const base_ready = ref(false)
const output_name = ref('')
const original_name = computed(() => split_attachment_editable_name(props.attachment?.file_name ?? ''))
const display_name = computed({
  get: () => mode.value !== 'copy' ? original_name.value.editable : output_name.value,
  set: (value: string) => {
    if (mode.value === 'copy')
      output_name.value = value
  },
})
const save_name = computed(() => mode.value !== 'copy' ? props.attachment?.file_name ?? '' : `${output_name.value}.avif`)
const save_confirmation = computed(() => mode.value === 'overwrite'
  ? `将覆盖原图，确认保存？`
  : mode.value === 'copy'
    ? `将另存为新图，确认保存？`
    : `将另存为删减版，确认保存？`)
const source_url = ref<string | null>(null)
const source_error = ref('')
const source_loading = ref(false)
const original_url = ref<string | null>(null)
const original_reason = ref('正在检查原图')
let generation = 0
const modes = [{ label: '另存为', value: 'copy' }, { label: '覆盖', value: 'overwrite' }]
let name_mode: ImageSaveMode = 'copy'
watch(mode, () => {
  if (mode.value !== 'overwrite' && mode.value !== name_mode)
    reset_output_name()
})
watch(() => [props.visible, props.attachment, props.redacted] as const, async ([open, attachment]) => {
  const epoch = ++ generation
  mode.value = props.redacted ? 'redacted' : 'overwrite'
  input_basis.value = 'avif'
  base_ready.value = false
  source_url.value = original_url.value = null
  source_error.value = ''
  source_loading.value = false
  original_reason.value = '正在检查原图'
  reset_output_name()
  if (! open || ! attachment?.id || ! attachment.url)
    return
  source_loading.value = true
  try {
    const version = new URL(attachment.url, window.location.origin).searchParams.get('version')!
    const source = await content.image_editor_source(attachment.id, version, props.redacted)
    if (epoch !== generation)
      return
    source_url.value = source.avif_url
    original_url.value = source.original_url
    original_reason.value = source.original_reason
  }
  catch (error) {
    if (epoch === generation) {
      source_error.value = error instanceof Error ? error.message : '无法读取图片'
      original_reason.value = source_error.value
    }
  }
  finally {
    if (epoch === generation)
      source_loading.value = false
  }
}, { immediate: true })
function reset_output_name() {
  name_mode = mode.value
  const suggested = suggested_image_name(props.attachment?.file_name ?? 'image', mode.value === 'redacted' ? 'redacted' : 'copy')
  output_name.value = split_attachment_editable_name(suggested).editable
}
function save(file: File) {
  if (mode.value !== 'overwrite' && ! output_name.value.trim())
    return
  emit('save', file, mode.value, save_name.value, input_basis.value)
}
function request_reset(event: Event) {
  if (! base_ready.value || ! original_url.value || props.pending)
    return
  const epoch = generation
  confirm_require(event, '将丢弃未保存的编辑及操作记录，确认回退？', () => {
    if (! props.visible || generation !== epoch || props.pending)
      return
    reset_source()
  }, { acceptLabel: '确认回退' })
}
function reset_source() {
  if (! base_ready.value || ! original_url.value)
    return
  source_url.value = `${original_url.value}&editor_reset=${++ generation}`
  input_basis.value = 'original'
}
const save_disabled = computed(() => ! source_url.value || (mode.value !== 'overwrite' && ! output_name.value.trim()))

const limits = settings.app.content.imageEditor
const active_pointer = ref<number | null>(null)
let touch_blocked = false
const crop_rect = ref({ x: 0, y: 0, width: 1, height: 1 })
const crop_locked = ref(false)
const crop_drag = shallowRef<{ id: number, handle: string, x: number, y: number, rect: typeof crop_rect.value } | null>(null)
const pan_modifier = ref(false)
const crop_handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const visible = computed({
  get: () => props.visible,
  set: (value: boolean) => emit('update:visible', value),
})

const stage = ref<HTMLElement | null>(null)
const image_canvas = ref<HTMLCanvasElement | null>(null)
const stroke_canvas = ref<HTMLCanvasElement | null>(null)

const brush_width = ref(1)
const erasing = ref(false)
/** The width slider is being worked, so the brush size is previewed on the image. */
const brush_dragging = ref(false)
// Long enough to read the final size after the pointer is gone (a track click
// commits on release), short enough not to linger over the drawing.
const brush_preview_linger_ms = 250
let brush_preview_timer: ReturnType<typeof setTimeout> | null = null

let active_stroke: RedactionStroke | null = null
// The owners share readiness/gesture guards; neither invokes these callbacks
// until the dialog watcher below runs, after both owners have been initialized.
let image_session: ReturnType<typeof useImageEditSession>
let viewport: ReturnType<typeof useImageEditorViewport>
const processing = computed(() => props.pending || image_session.working.value)
// Gestures guard commands internally without changing control availability or dialog geometry.
const busy = computed(() => processing.value || active_pointer.value !== null || viewport.pan_state.value !== null)
image_session = useImageEditSession({
  image_canvas, stroke_canvas,
  source_url: () => source_url.value, file_name: () => 'edited.png', output_mime: () => 'image/png',
  busy: () => busy.value, cropping: () => false,
  refit: () => viewport.fit_to_stage(),
  reset_tools() {
    cancel_crop()
    const pointer = active_pointer.value
    if (pointer !== null && stroke_canvas.value?.hasPointerCapture(pointer))
      stroke_canvas.value.releasePointerCapture(pointer)
    active_stroke = null
    active_pointer.value = null
    viewport.reset()
  },
  on_ready(bitmap) {
    base_ready.value = true
    brush_width.value = Math.max(4, Math.round(Math.min(bitmap.width, bitmap.height) * 0.05))
  },
  on_save: save, on_error: toast_error,
})
const { working, loading, load_error, natural_size, source_bitmap, can_undo, can_redo,
  load_source, release_source, commit_action, undo, redo, submit: export_submit } = image_session
viewport = useImageEditorViewport({
  stage, stroke_canvas, natural_size, busy: () => busy.value,
  loading: () => loading.value, load_error: () => load_error.value, tool: () => 'brush',
})
const { scale, pan_state, cursor_pos, space_held, display_width, display_height,
  on_wheel, on_stage_pointerdown, on_stage_pointermove, on_stage_pointerup,
  is_pan_gesture, to_image_point, update_cursor, on_cursor_leave } = viewport

const crop_ready = computed(() => natural_size.value.width > 0)
const crop_style = computed(() => ({ left: `${crop_rect.value.x * scale.value}px`, top: `${crop_rect.value.y * scale.value}px`, width: `${crop_rect.value.width * scale.value}px`, height: `${crop_rect.value.height * scale.value}px` }))

// Derived from the image so one slider covers both a 400 px screenshot and a
// 6000 px scan without a second control.
const brush_width_max = computed(() => Math.max(8, Math.round(Math.min(natural_size.value.width, natural_size.value.height) * 0.5)))

/** Diameter the stroke will cover on screen: brush width in image pixels × zoom. */
const cursor_style = computed(() => {
  const position = cursor_pos.value
  // A pan gesture is not aiming a brush, so the preview steps aside.
  if (! position || props.pending || working.value || space_held.value || pan_state.value || pan_modifier.value || crop_drag.value)
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

function submit(event: Event) {
  if (busy.value || save_disabled.value || loading.value || load_error.value || ! source_bitmap.value)
    return
  const generation = image_session.generation
  const message = save_confirmation.value
  const accept = () => {
    if (visible.value && generation === image_session.generation && message === save_confirmation.value
      && ! busy.value && ! save_disabled.value) {
      void export_submit(normalize_editor_crop(crop_rect.value, natural_size.value))
    }
  }
  if (message)
    confirm_require(event, message, accept, { acceptLabel: '确认保存' })
  else
    accept()
}
function rotate(direction: 1 | - 1) {
  if (! busy.value)
    void commit_action({ kind: 'rotate', direction })
}
function cancel_crop() {
  crop_drag.value = null
  crop_rect.value = { x: 0, y: 0, ... natural_size.value }
}
// Repaint replaces the size object even when its dimensions are unchanged.
// Watch each scalar so cancelling a live stroke during pinch preserves the crop.
watch([() => natural_size.value.width, () => natural_size.value.height], cancel_crop)
async function apply_crop() {
  if (busy.value || ! crop_ready.value)
    return
  const rect = normalize_editor_crop(crop_rect.value, natural_size.value)
  await commit_action({ kind: 'crop', rect })
  cancel_crop()
}
function crop_start(event: PointerEvent, handle: string) {
  if (busy.value || is_pan_gesture(event) || touch_blocked)
    return
  event.preventDefault()
  event.stopPropagation()
  const point = to_image_point(event)
  crop_drag.value = { id: event.pointerId, handle, ... point, rect: { ... crop_rect.value } }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function crop_move(event: PointerEvent) {
  const drag = crop_drag.value
  if (! drag || drag.id !== event.pointerId)
    return
  const point = to_image_point(event)
  const dx = point.x - drag.x
  const dy = point.y - drag.y
  const r = drag.rect
  const size = natural_size.value
  if (drag.handle === 'move') {
    crop_rect.value = { ... r, x: Math.max(0, Math.min(size.width - r.width, r.x + dx)), y: Math.max(0, Math.min(size.height - r.height, r.y + dy)) }
    return
  }
  const west = drag.handle.includes('w')
  const north = drag.handle.includes('n')
  let w = Math.max(1, Math.min(west ? r.x + r.width : size.width - r.x, r.width + (west ? - dx : drag.handle.includes('e') ? dx : 0)))
  let h = Math.max(1, Math.min(north ? r.y + r.height : size.height - r.y, r.height + (north ? - dy : drag.handle.includes('s') ? dy : 0)))
  if (crop_locked.value || event.shiftKey) {
    const ratio = r.width / r.height
    h = Math.min(h, w / ratio)
    w = h * ratio
  }
  crop_rect.value = { x: west ? r.x + r.width - w : r.x, y: north ? r.y + r.height - h : r.y, width: w, height: h }
}
function crop_end(event: PointerEvent) {
  if (crop_drag.value?.id === event.pointerId)
    crop_drag.value = null
}
const touches = new Map<number, { x: number, y: number }>()
let pinch: { distance: number, scale: number, x: number, y: number } | null = null
function touch_start(event: PointerEvent) {
  if (event.pointerType !== 'touch' || props.pending || working.value)
    return
  touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
  // Blank viewport space has no drawing handler to capture the first finger.
  // Keep tracking it even when it moves outside before the second finger lands.
  if (event.target === stage.value || event.target === event.currentTarget)
    stage.value?.setPointerCapture(event.pointerId)
  if (touches.size < 2 && ! touch_blocked)
    return
  touch_blocked = true
  active_pointer.value = null
  active_stroke = null
  crop_drag.value = null
  viewport.reset()
  void image_session.repaint()
  for (const id of touches.keys()) stage.value?.setPointerCapture(id)
  const [a, b] = [... touches.values()]
  const rect = stroke_canvas.value?.getBoundingClientRect()
  if (a && b && rect)
    pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale: scale.value, x: ((a.x + b.x) / 2 - rect.left) / rect.width, y: ((a.y + b.y) / 2 - rect.top) / rect.height }
  event.preventDefault()
  event.stopPropagation()
}
async function touch_move(event: PointerEvent) {
  if (! touches.has(event.pointerId))
    return
  touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (! touch_blocked)
    return
  event.preventDefault()
  event.stopPropagation()
  const [a, b] = [... touches.values()]
  const box = stage.value
  const anchor = pinch
  if (! a || ! b || ! box || ! anchor)
    return
  scale.value = viewport.clamp_scale(anchor.scale * Math.hypot(a.x - b.x, a.y - b.y) / anchor.distance)
  await nextTick()
  if (pinch !== anchor)
    return
  const rect = box.getBoundingClientRect()
  box.scrollLeft = anchor.x * display_width.value - ((a.x + b.x) / 2 - rect.left)
  box.scrollTop = anchor.y * display_height.value - ((a.y + b.y) / 2 - rect.top)
}
function touch_end(event: PointerEvent) {
  touches.delete(event.pointerId)
  if (stage.value?.hasPointerCapture(event.pointerId))
    stage.value.releasePointerCapture(event.pointerId)
  if (! touch_blocked)
    return
  event.stopPropagation()
  pinch = null
  if (! touches.size)
    touch_blocked = false
}

function on_pointerdown(event: PointerEvent) {
  // Secondary buttons belong to the browser menu, a drag already in flight
  // (a second finger) must not hijack the stroke, and a pan gesture belongs to
  // the stage — the canvas must not also start drawing under it.
  if (touch_blocked || busy.value || event.button > 0 || is_pan_gesture(event))
    return
  update_cursor(event)
  const canvas = stroke_canvas.value
  const ctx = canvas?.getContext('2d')
  if (! canvas || ! ctx)
    return
  event.preventDefault()
  active_pointer.value = event.pointerId
  canvas.setPointerCapture(event.pointerId)
  const point = to_image_point(event)
  active_stroke = { width: brush_width.value, points: [point], erase: erasing.value }
  paint_redaction_stroke(ctx, active_stroke, 0)
}

function on_pointermove(event: PointerEvent) {
  if (crop_drag.value?.id === event.pointerId) {
    crop_move(event)
    return
  }
  update_cursor(event)
  const stroke = active_stroke
  const ctx = stroke_canvas.value?.getContext('2d')
  if (! stroke || ! ctx || event.pointerId !== active_pointer.value)
    return
  event.preventDefault()
  const point = to_image_point(event)
  const previous = stroke.points[stroke.points.length - 1]!
  if (stroke.points.length >= limits.maxStrokePoints) {
    on_pointerup(event)
    toast_error('单次笔迹过长，请分段涂抹')
    return
  }
  stroke.points.push(point)
  // Only the fresh segment is painted; a full repaint would be O(strokes) per move.
  paint_redaction_stroke(ctx, { width: stroke.width, points: [previous, point], erase: stroke.erase }, 0)
}

function on_pointerup(event: PointerEvent) {
  if (crop_drag.value?.id === event.pointerId) {
    crop_end(event)
    const canvas = stroke_canvas.value
    if (canvas?.hasPointerCapture(event.pointerId))
      canvas.releasePointerCapture(event.pointerId)
    return
  }
  if (event.pointerId !== active_pointer.value)
    return
  const canvas = stroke_canvas.value
  if (canvas?.hasPointerCapture(event.pointerId))
    canvas.releasePointerCapture(event.pointerId)
  active_pointer.value = null
  const stroke = active_stroke
  active_stroke = null
  if (stroke)
    void commit_action({ kind: 'stroke', stroke })
}

// Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y) are the drawing equivalents of
// the buttons, live only while the dialog is open. A drag in progress owns the
// history: stepping it mid-stroke would strand the live stroke's points.
function on_keydown(event: KeyboardEvent) {
  if (event.isComposing || loading.value || load_error.value || uses_space_key(event.target))
    return
  pan_modifier.value = event.ctrlKey || event.metaKey
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
  if (busy.value)
    return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    cancel_crop()
    return
  }
  if (! event.ctrlKey && ! event.metaKey && ! event.altKey) {
    const key = event.key.toLowerCase()
    if (['[', ']'].includes(key))
      event.preventDefault()
    if (key === '[' || key === ']')
      brush_width.value = Math.max(1, Math.min(brush_width_max.value, brush_width.value + (key === '[' ? - 1 : 1)))
  }
  if (! (event.ctrlKey || event.metaKey))
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
  pan_modifier.value = event.ctrlKey || event.metaKey
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

watch(() => [props.visible, source_url.value] as const, ([open, url]) => {
  stop_key_listeners()
  hide_brush_preview()
  release_source()
  if (! open || ! url)
    return
  start_key_listeners()
  void load_source()
}, { immediate: true })

// The listener block is client-only: setup runs on the server too (the dialog
// is always mounted so its leave transition can play), and the immediate run of
// this watcher would otherwise reach for `window` there.
function start_key_listeners() {
  if (import.meta.server)
    return
  window.addEventListener('keydown', on_keydown, true)
  window.addEventListener('keyup', on_keyup)
  // A keyup that lands outside the window would otherwise leave the hand tool
  // stuck on, with no way to tell it apart from a held key.
  window.addEventListener('blur', release_space)
}

function stop_key_listeners() {
  if (import.meta.server)
    return
  window.removeEventListener('keydown', on_keydown, true)
  window.removeEventListener('keyup', on_keyup)
  window.removeEventListener('blur', release_space)
  release_space()
}

function release_space() {
  space_held.value = false
  pan_modifier.value = false
  crop_drag.value = null
  touches.clear()
  touch_blocked = false
  pinch = null
  viewport.reset()
}

onBeforeUnmount(() => {
  generation ++
  stop_key_listeners()
  hide_brush_preview()
  release_source()
})
</script>

<style scoped>
.image-editor-workspace :deep(.p-button) {
  flex-shrink: 0;
  white-space: nowrap;
}

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

.redact-cursor.redact-eraser {
  background-color: theme('colors.white / 0.7');
  box-shadow: 0 0 0 1px theme('colors.slate.950 / 0.7');
}

.redact-crop-handle {
  background-color: theme('colors.slate.950 / 0.7');
}

.redact-crop-frame {
  box-shadow: inset 0 0 0 1px theme('colors.slate.950 / 0.7'), 0 0 0 9999px rgb(0 0 0 / 0.45);
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

.redact-crop-moving,
.redact-crop-moving :deep(*) {
  cursor: grabbing !important;
}
</style>
