<template>
  <div
    ref="row_el"
    :class="row_classes"
    :draggable="is_draggable"
    tabindex="0"
    @keydown.enter.prevent="emit('open')"
    @click="on_click"
    @dragstart="on_dragstart"
    @dragend="emit('dragend')"
    @dblclick="on_dblclick"
    @contextmenu.prevent="on_contextmenu"
    @touchstart.passive="on_touch_start"
    @touchmove.passive="on_touch_move"
    @touchend.passive="on_touch_end"
    @touchcancel.passive="on_touch_cancel"
  >
    <template v-if="folder">
      <MyIcon
        :name="presentation.icon"
        class="content-item-icon"
      />
      <span class="content-item-title" :title="folder.path">{{ folder.name }}</span>
      <span v-if="row_pending" class="ml-auto shrink-0 pl-2 text-xs text-slate-400 dark:text-slate-500">
        <MyIcon name="lucide:loader-circle" class="animate-spin" />
      </span>
    </template>

    <template v-else-if="file_row">
      <div
        v-if="progress_percent !== null"
        class="file-row-progress"
        :style="{ width: `${progress_percent}%` }"
      />
      <div class="relative min-w-0 w-full">
        <div class="content-item" :class="`content-item-${presentation.tone}`">
          <MyIcon
            :name="presentation.icon"
            class="content-item-icon"
          />
          <span class="content-item-title" :title="file_row.file_name">{{ display_name }}</span>
          <span v-if="row_pending || row_progress_text" class="ml-auto flex shrink-0 items-center pl-2 text-xs text-slate-400 dark:text-slate-500">
            <MyIcon v-if="row_pending && ! row_progress_text" name="lucide:loader-circle" class="animate-spin" />
            <template v-else-if="row_progress_text">{{ row_progress_text }}</template>
          </span>
        </div>

        <div v-if="upload && upload.status !== 'error'" class="mt-1 truncate text-xs text-slate-500 dark:text-slate-400" :title="upload_status_text">
          {{ upload_status_text }}
        </div>
        <span v-else-if="upload" class="mt-0.5 block truncate text-xs text-red-600 dark:text-red-400" :title="`上传失败：${upload.message}`">
          上传失败：{{ upload.message }}
        </span>
      </div>
    </template>

    <!-- Allow native reason tooltips; PrimeVue still guards disabled commands. -->
    <ContextMenu
      v-if="context_menu"
      ref="menu"
      :model="menu_model ?? menu_items"
      :pt="{ item: ({ context }) => ({ 'title': context.item.title, 'aria-description': context.item.title, 'style': context.item.title ? { pointerEvents: 'auto' } : undefined }) }"
      @show="menu_open = true"
      @hide="on_menu_hide"
    >
      <template #itemicon="{ item }">
        <MyIcon :name="item.icon_name" :class="{ 'animate-spin': item.spin }" />
      </template>
    </ContextMenu>
  </div>
</template>

<script setup lang="ts">
import type { AttachmentMenuItem, MyContentAttachmentRow } from '~/utils/content/attachment-list'
import { attachment_base_name, attachment_path_is_private } from '@shared/content-markdown'
import { attachment_item_presentation, folder_item_presentation } from '~/utils/content/item-presentation'
import { format_bytes } from '~/utils/size'

type MenuOpenEvent = Pick<MouseEvent, 'pageX' | 'pageY' | 'stopPropagation' | 'preventDefault'>
const props = withDefaults(defineProps<{ row: MyContentAttachmentRow, menu_items: AttachmentMenuItem[], readonly?: boolean, context_menu?: boolean, displayPath?: boolean }>(), { readonly: false, context_menu: true, displayPath: false })
const emit = defineEmits<{ 'click': [event: MouseEvent], 'contextmenu': [event: MouseEvent], 'toggle-selection': [], 'dragstart': [event: DragEvent], 'dragend': [], 'open': [] }>()
const row_el = ref<HTMLElement>()
const menu = ref<{ show: (event: MenuOpenEvent) => void, hide: () => void }>()
const menu_open = ref(false)
// Freeze the menu while it closes, as in the original list.
const menu_model = ref<AttachmentMenuItem[] | null>(null)
const menu_items = computed(() => props.menu_items)
const data = computed(() => props.row.data)
const state = computed(() => props.row.state)
const stored = computed(() => data.value.kind === 'stored' ? data.value : null)
const upload = computed(() => props.row.upload)
const folder = computed(() => data.value.kind === 'folder' ? data.value : null)
const folder_private = computed(() => !! folder.value && attachment_path_is_private(folder.value.path))
const file_row = computed(() => data.value.kind === 'folder' ? null : data.value)
const progress_percent = computed(() => upload.value && ! ['error', 'queued'].includes(upload.value.status) ? upload.value.progress : null)
const row_pending = computed(() => state.value.pending || upload.value?.status === 'queued' || upload.value?.status === 'uploading')
const row_progress_text = computed(() => upload.value?.status === 'paused' ? `${format_bytes(upload.value.file_size * upload.value.progress / 100)} / ${format_bytes(upload.value.file_size)}` : null)
const upload_status_text = computed(() => upload.value?.label ?? '')
const display_name = computed(() => folder.value ? folder.value.name : props.displayPath ? file_row.value?.file_name ?? '' : attachment_base_name(file_row.value?.file_name ?? ''))
const presentation = computed(() => folder.value ? folder_item_presentation(! folder.value.collapsed, state.value.error, folder_private.value) : attachment_item_presentation(file_row.value!, upload.value?.status))
const rounding_class = computed(() => ({ top: 'rounded-t-sm', bottom: 'rounded-b-sm', none: 'rounded-none', both: 'rounded-sm' })[state.value.selection_edges])
const row_classes = computed(() => folder.value
  ? ['folder-row', 'content-item', `content-item-${presentation.value.tone}`, rounding_class.value, { 'folder-row-drop': folder.value.drop_target, 'folder-row-drop-disabled': folder.value.drop_disabled, 'folder-row-menu-open': menu_open.value, 'folder-row-moving': state.value.move_pending, 'folder-row-pending': state.value.pending, 'folder-row-selected': state.value.selected }]
  : ['file-row', rounding_class.value, { 'file-row-menu-open': menu_open.value, 'file-row-selected': state.value.selected, 'file-row-moving': state.value.move_pending }])
const is_draggable = computed(() => ! props.readonly && state.value.draggable)
function on_dblclick() {
  if (! folder.value)
    emit('open')
}

// Swipe-left toggles selection: touch devices have no ctrl/meta multi-select.
// The row follows the finger, and the release past the threshold commits.
const swipe_left_threshold = 56
const swipe_direction_slop = 12
let swipe_touch: { id: number, start_x: number, start_y: number, dx: number, dy: number } | null = null
let swipe_left_active = false
let swipe_left_fired = false

function on_click(event: MouseEvent) {
  // The tap that ends a left-swipe gesture must not also toggle/collapse the row.
  if (swipe_left_fired) {
    swipe_left_fired = false
    return
  }
  if (folder.value || stored.value || upload.value)
    emit('click', event)
}

async function on_contextmenu(event: MouseEvent) {
  cancel_long_press()
  if (! props.context_menu)
    return
  // Let the page fold the selection onto this row before the menu model is read.
  emit('contextmenu', event)
  await nextTick()
  if (menu_items.value.length)
    open_menu(event)
}

// PrimeVue menus close on outside click but not on another row's right-click,
// so every opening menu broadcasts and the others hide themselves.
const menu_open_event = 'stupig-file-menu-open'

function open_menu(event: MenuOpenEvent) {
  document.dispatchEvent(new Event(menu_open_event))
  // Freeze the entries now that the row's context is settled (the page folds a
  // multi-selection before this runs).
  menu_model.value = menu_items.value
  // Open at the row's bottom-left corner instead of at the pointer.
  const rect = row_el.value?.getBoundingClientRect()
  menu.value?.show({
    pageX: rect ? rect.left + window.scrollX : event.pageX,
    pageY: rect ? rect.bottom + window.scrollY : event.pageY,
    stopPropagation: () => event.stopPropagation(),
    preventDefault: () => event.preventDefault(),
  })
}

function on_menu_hide() {
  menu_open.value = false
  menu_model.value = null
}

function on_other_menu_open() {
  if (menu_open.value)
    menu.value?.hide()
}

// Long-press opens the same menu on touch devices (iOS Safari never fires a
// native contextmenu event); scroll-ish movement cancels the pending press.
const long_press_ms = 500
const long_press_move_tolerance = 10
let long_press_timer: ReturnType<typeof setTimeout> | null = null
let long_press_touch: { id: number, client_x: number, client_y: number, page_x: number, page_y: number } | null = null

// Touch browsers don't perform HTML5 drag-and-drop (iOS Safari, Android
// Chrome), so draggable stays inert there and the long-press menu below keeps
// working; on desktop and trackpad-equipped devices the row is draggable.
onMounted(() => {
  document.addEventListener(menu_open_event, on_other_menu_open)
})

onBeforeUnmount(() => {
  cancel_long_press()
  document.removeEventListener(menu_open_event, on_other_menu_open)
})

function on_touch_start(event: TouchEvent) {
  cancel_long_press()
  swipe_touch = null
  swipe_left_active = false
  swipe_left_fired = false
  if (event.touches.length !== 1)
    return
  const touch = event.touches.item(0)
  if (! touch)
    return
  if (! props.readonly)
    swipe_touch = { id: touch.identifier, start_x: touch.clientX, start_y: touch.clientY, dx: 0, dy: 0 }
  if (! props.context_menu || ! menu_items.value.length)
    return
  long_press_touch = { id: touch.identifier, client_x: touch.clientX, client_y: touch.clientY, page_x: touch.pageX, page_y: touch.pageY }
  long_press_timer = setTimeout(() => {
    const pressed = long_press_touch
    cancel_long_press()
    if (pressed) {
      open_menu({
        pageX: pressed.page_x,
        pageY: pressed.page_y,
        stopPropagation: () => {},
        preventDefault: () => {},
      })
    }
  }, long_press_ms)
}

function on_touch_move(event: TouchEvent) {
  if (long_press_timer && long_press_touch) {
    const touch = event.touches[0]
    if (! touch || touch.identifier !== long_press_touch.id || Math.hypot(touch.clientX - long_press_touch.client_x, touch.clientY - long_press_touch.client_y) > long_press_move_tolerance)
      cancel_long_press()
  }
  const swipe = swipe_touch
  if (! swipe)
    return
  const touch = Array.from(event.touches).find(item => item.identifier === swipe.id)
  if (! touch) {
    swipe_touch = null
    return
  }
  swipe.dx = touch.clientX - swipe.start_x
  swipe.dy = touch.clientY - swipe.start_y
  if (! swipe_left_active) {
    if (swipe.dx <= - swipe_direction_slop && - swipe.dx > Math.abs(swipe.dy) * 1.5) {
      swipe_left_active = true
      cancel_long_press()
      if (row_el.value)
        row_el.value.style.transition = 'none'
    }
    else if (Math.abs(swipe.dy) > swipe_direction_slop && Math.abs(swipe.dy) > - swipe.dx) {
      // Vertical scroll gesture — stop tracking.
      swipe_touch = null
      return
    }
  }
  if (swipe_left_active && row_el.value) {
    const offset = Math.max(Math.min(swipe.dx, 0), - swipe_left_threshold * 1.25)
    row_el.value.style.transform = `translateX(${offset}px)`
  }
}

function on_touch_end() {
  cancel_long_press()
  finish_swipe_left(true)
}

function on_touch_cancel() {
  cancel_long_press()
  finish_swipe_left(false)
}

function finish_swipe_left(allow_toggle: boolean) {
  const swipe = swipe_touch
  swipe_touch = null
  if (! swipe_left_active)
    return
  swipe_left_active = false
  const el = row_el.value
  if (el) {
    el.style.transition = 'transform 150ms ease'
    el.style.transform = ''
  }
  if (allow_toggle && swipe && swipe.dx <= - swipe_left_threshold) {
    swipe_left_fired = true
    emit('toggle-selection')
  }
}

function cancel_long_press() {
  if (long_press_timer) {
    clearTimeout(long_press_timer)
    long_press_timer = null
  }
  long_press_touch = null
}

function on_dragstart(event: DragEvent) {
  // The page owns the drag payload and drop handling.
  emit('dragstart', event)
}
</script>

<style scoped>
.file-row {
  @apply relative flex w-full min-w-0 select-none flex-col overflow-hidden px-2 py-1;
  -webkit-touch-callout: none;
  touch-action: pan-y;
  transition: background-color 150ms ease, opacity 150ms ease;
}

.file-row-progress {
  @apply absolute inset-y-0 left-0 bg-primary/10;
  transition: width 200ms ease;
}

.file-row:hover,
.file-row-menu-open {
  @apply bg-slate-100 dark:bg-slate-800;
}

.file-row-selected,
.file-row-selected:hover {
  @apply bg-primary/10;
}

.file-row-moving {
  @apply opacity-60;
}

.folder-row {
  @apply col-span-full w-full cursor-pointer select-none border border-dashed border-transparent py-1 pr-2;
  -webkit-touch-callout: none;
  touch-action: pan-y;
  transition: background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease, opacity 150ms ease;
}

.folder-row:hover,
.folder-row-menu-open {
  @apply bg-slate-100 dark:bg-slate-800;
}

.folder-row-selected,
.folder-row-selected:hover {
  @apply bg-primary/10;
}

.folder-row-drop {
  /* bg-clip-border: fill runs under the dashed border so they read as one. */
  @apply border-primary/50 bg-primary/10 bg-clip-border;
}

.folder-row-drop-disabled {
  @apply cursor-not-allowed opacity-50;
}

/* Source/target folders (and their ancestors) of an in-flight move batch. */
.folder-row-pending {
  @apply opacity-50;
}

/* Subtle inset indicator on the move-target folder row. */
.folder-row-moving {
  @apply rounded-sm bg-primary/5;
  box-shadow: inset 0 0 0 1px theme('colors.primary / 0.3');
}

/* The menu is teleported to body; its root still carries this scope id. */
:deep(.attachment-menu-danger *) {
  @apply text-red-500 dark:text-red-400;
}
</style>
