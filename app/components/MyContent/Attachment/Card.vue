<template>
  <div
    ref="row_el"
    :class="row_classes"
    :draggable="is_draggable"
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
        :name="folder.collapsed ? 'lucide:chevron-right' : 'lucide:chevron-down'"
        class="shrink-0 text-xs text-slate-400 dark:text-slate-500"
      />
      <span class="min-w-0 flex-1 truncate text-sm">{{ folder.name }}</span>
      <span class="ml-auto shrink-0 pl-2 text-xs text-slate-400 dark:text-slate-500">
        <MyIcon v-if="folder.moving || state.delete_pending" name="lucide:loader-circle" class="animate-spin" />
        <template v-else-if="! folder.count">空</template>
      </span>
    </template>

    <template v-else-if="file_row">
      <div
        v-if="progress_percent !== null"
        class="file-row-progress"
        :style="{ width: `${progress_percent}%` }"
      />
      <div class="relative">
        <div class="flex min-w-0 items-center gap-2">
          <MyIcon
            :name="`lucide:${file_icon(file_row)}`"
            class="shrink-0 text-base"
            :class="icon_class"
          />
          <span class="min-w-0 flex-1 truncate text-sm">{{ display_name }}</span>
          <span class="ml-auto flex shrink-0 items-center pl-2 text-xs text-slate-400 dark:text-slate-500">
            <MyIcon v-if="state.delete_pending || state.move_pending" name="lucide:loader-circle" class="animate-spin" />
            <template v-else-if="upload?.status === 'uploading' && upload.speed > 0">{{ format_speed(upload.speed) }}</template>
            <template v-else-if="upload?.status === 'paused'">{{ format_bytes(upload.file_size * upload.progress / 100) }} / {{ format_bytes(upload.file_size) }}</template>
            <template v-else-if="replacing && replacing.speed > 0">{{ format_speed(replacing.speed) }}</template>
            <template v-else>{{ format_bytes(file_row.file_size) }}</template>
          </span>
        </div>

        <div v-if="upload && upload.status !== 'error'" class="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {{ upload_status_text }}
        </div>
        <span v-else-if="upload" class="mt-0.5 truncate text-xs text-red-600 dark:text-red-400">
          上传失败：{{ upload.message }}
        </span>

        <div v-if="replacing" class="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {{ replace_status_text }}
        </div>
      </div>
    </template>

    <ContextMenu
      ref="menu"
      :model="menu_items"
      @show="menu_open = true"
      @hide="menu_open = false"
    >
      <template #itemicon="{ item }">
        <MyIcon :name="item.icon_name" />
      </template>
    </ContextMenu>
  </div>
</template>

<script setup lang="ts">
import type { MenuItem } from 'primevue/menuitem'
import type { MyContentAttachmentRow } from '~/utils/content/attachment'
import { attachment_base_name } from '@shared/content-markdown'
import { file_icon } from '~/utils/content/attachment'
import { format_bytes, format_speed } from '~/utils/size'

type AttachmentMenuItem = MenuItem & { icon_name?: string }

/** What ContextMenu.show() reads — satisfied by a MouseEvent or by long-press coordinates. */
type MenuOpenEvent = Pick<MouseEvent, 'pageX' | 'pageY' | 'stopPropagation' | 'preventDefault'>

interface Props {
  row: MyContentAttachmentRow
  readonly?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  readonly: false,
})

const emit = defineEmits<{
  'click': [event: MouseEvent]
  'contextmenu': [event: MouseEvent]
  'toggle-selection': []
  'dragstart': [event: DragEvent]
  'dragend': []
  'preview': [url: string]
  'copy': []
  'rename': []
  'replace': []
  'delete': [event: MouseEvent]
  'retry': []
  'pause': []
  'cancel': [event: MouseEvent]
  'remove': [event: MouseEvent]
  'start-selection': []
  'pause-selection': []
  'delete-selection': [event: MouseEvent]
  'create-folder': []
  'rename-folder': []
  'delete-folder': [event: MouseEvent]
  'copy-folder': []
}>()

const static_url = useStaticUrl()

const row_el = ref<HTMLElement>()
const menu = ref<{ show: (event: MenuOpenEvent) => void, hide: () => void }>()
const menu_open = ref(false)

// Anchor the confirm popup to the row: the clicked menu item is unmounted
// together with the menu right after the command runs.
function row_anchor_event() {
  return { currentTarget: row_el.value } as unknown as MouseEvent
}

const data = computed(() => props.row.data)
const state = computed(() => props.row.state)
const stored = computed(() => data.value.kind === 'stored' ? data.value : null)
const upload = computed(() => data.value.kind === 'upload' ? data.value : null)
const folder = computed(() => data.value.kind === 'folder' ? data.value : null)
const file_row = computed(() => data.value.kind === 'folder' ? null : data.value)
const replacing = computed(() => stored.value?.replacing ?? null)
const progress_percent = computed(() => {
  if (upload.value && upload.value.status !== 'error' && upload.value.status !== 'queued')
    return upload.value.progress
  if (replacing.value)
    return replacing.value.progress
  return null
})
const display_name = computed(() => folder.value ? folder.value.name : attachment_base_name(data.value.kind === 'folder' ? '' : data.value.file_name))
const selection_count = computed(() => state.value.selected ? state.value.selection_count : 0)

const rounding_class = computed(() => {
  const edges = state.value.selection_edges
  if (edges === 'top')
    return 'rounded-t-sm'
  if (edges === 'bottom')
    return 'rounded-b-sm'
  if (edges === 'none')
    return 'rounded-none'
  return 'rounded-sm'
})

const row_classes = computed(() => {
  const current = folder.value
  if (current) {
    return ['folder-row', rounding_class.value, {
      'folder-row-drop': current.drop_target,
      'folder-row-drop-disabled': current.drop_disabled,
      'folder-row-menu-open': menu_open.value,
      'folder-row-moving': current.moving,
      'folder-row-pending': current.dimmed,
      'folder-row-selected': state.value.selected,
    }]
  }
  return ['file-row', rounding_class.value, {
    'file-row-menu-open': menu_open.value,
    'file-row-selected': state.value.selected,
    'file-row-moving': state.value.move_pending,
  }]
})

const is_draggable = computed(() => ! props.readonly
  && ! state.value.structure_locked
  && (folder.value ? ! folder.value.batch_pending : (stored.value !== null && ! state.value.move_pending)))

const icon_class = computed(() => {
  if (upload.value?.status === 'error')
    return 'text-red-500 dark:text-red-400'
  if ((upload.value && upload.value.status !== 'completed') || replacing.value)
    return 'text-primary'
  return 'text-slate-400 dark:text-slate-500'
})

const menu_items = computed<AttachmentMenuItem[]>(() => {
  const current_folder = folder.value
  if (props.readonly) {
    const file = stored.value
    return current_folder || ! file
      ? []
      : [{ label: '打开附件', icon_name: 'lucide:external-link', command: open_file }]
  }
  if (current_folder) {
    if (selection_count.value > 1) {
      return [{
        label: `删除 ${selection_count.value} 个选中项`,
        icon_name: 'lucide:trash-2',
        class: 'attachment-menu-danger',
        disabled: state.value.delete_disabled,
        command: () => emit('delete-folder', { currentTarget: row_el.value } as unknown as MouseEvent),
      }]
    }
    return [
      // Same label and same shorthand as a file card: `[](folder)` renders the
      // folder card, no `!` prefix.
      { label: '复制 Markdown 代码', icon_name: 'lucide:copy', command: () => emit('copy-folder') },
      { separator: true },
      { label: '新建子文件夹', icon_name: 'lucide:folder-plus', disabled: state.value.structure_locked, command: () => emit('create-folder') },
      { label: '重命名', icon_name: 'lucide:pencil', disabled: state.value.structure_locked, command: () => emit('rename-folder') },
      {
        label: '删除',
        icon_name: 'lucide:trash-2',
        class: 'attachment-menu-danger',
        disabled: state.value.delete_disabled,
        // Anchor the confirm popup to the row: the clicked menu item is unmounted
        // together with the menu right after the command runs.
        command: () => emit('delete-folder', { currentTarget: row_el.value } as unknown as MouseEvent),
      },
    ]
  }

  const file = stored.value
  if (file) {
    // A right-clicked member of a multi-selection gets bulk actions only.
    if (selection_count.value > 1) {
      return [{
        label: `删除 ${selection_count.value} 个选中项`,
        icon_name: 'lucide:trash-2',
        class: 'attachment-menu-danger',
        disabled: state.value.delete_disabled,
        // Anchor the confirm popup to the row: the clicked menu item is
        // unmounted together with the menu right after the command runs.
        command: () => emit('delete', { currentTarget: row_el.value } as unknown as MouseEvent),
      }]
    }
    const items: AttachmentMenuItem[] = [
      file.is_image
        ? { label: '预览', icon_name: 'lucide:eye', command: () => emit('preview', static_url(file.url)) }
        : { label: '打开', icon_name: 'lucide:external-link', command: open_file },
      { label: '复制 Markdown 代码', icon_name: 'lucide:copy', command: () => emit('copy') },
    ]
    if (! state.value.rename_disabled) {
      items.push(
        { separator: true },
        { label: '重命名', icon_name: 'lucide:pencil', disabled: state.value.structure_locked, command: () => emit('rename') },
        { label: '替换文件', icon_name: 'lucide:refresh-cw', disabled: state.value.replace_disabled || state.value.structure_locked, command: () => emit('replace') },
      )
    }
    if (! file.referenced) {
      items.push(
        { separator: true },
        {
          label: '删除',
          icon_name: 'lucide:trash-2',
          class: 'attachment-menu-danger',
          disabled: state.value.delete_disabled,
          // Anchor the confirm popup to the row: the clicked menu item is
          // unmounted together with the menu right after the command runs.
          command: () => emit('delete', { currentTarget: row_el.value } as unknown as MouseEvent),
        },
      )
    }
    return items
  }

  const task = upload.value
  if (! task)
    return []
  if (selection_count.value > 1 && state.value.selected) {
    return [
      { label: `开始 ${selection_count.value} 个上传`, icon_name: 'lucide:play', command: () => emit('start-selection') },
      { label: `暂停 ${selection_count.value} 个上传`, icon_name: 'lucide:pause', command: () => emit('pause-selection') },
      {
        label: `删除 ${selection_count.value} 个上传`,
        icon_name: 'lucide:trash-2',
        class: 'attachment-menu-danger',
        command: () => emit('delete-selection', row_anchor_event()),
      },
    ]
  }
  const items: AttachmentMenuItem[] = []
  if (task.status === 'error') {
    items.push({ label: '重试上传', icon_name: 'lucide:rotate-cw', disabled: state.value.retry_disabled, command: () => emit('retry') })
  }
  if (task.status === 'uploading') {
    items.push({ label: '暂停上传', icon_name: 'lucide:pause', command: () => emit('pause') })
    items.push({ label: '取消上传', icon_name: 'lucide:x', command: () => emit('cancel', row_anchor_event()) })
  }
  else if (task.status === 'queued') {
    // Not started yet: resume is meaningless here, only removal makes sense.
    items.push({ label: '移除', icon_name: 'lucide:x', command: () => emit('remove', row_anchor_event()) })
  }
  else if (task.status === 'paused') {
    items.push({ label: '继续上传', icon_name: 'lucide:play', command: () => emit('pause') })
    items.push(task.can_resume
      ? { label: '取消上传', icon_name: 'lucide:x', command: () => emit('cancel', row_anchor_event()) }
      : { label: '移除', icon_name: 'lucide:x', command: () => emit('remove', row_anchor_event()) })
  }
  else {
    items.push({ label: '移除', icon_name: 'lucide:x', command: () => emit('remove', row_anchor_event()) })
  }
  return items
})

const upload_status_text = computed(() => {
  const current = upload.value
  if (! current)
    return ''
  if (current.status === 'queued')
    return '等待上传'
  if (current.status === 'paused') {
    if (! current.can_resume)
      return `已暂停 ${current.progress} %，需点继续重新选择文件`
    return `已暂停 ${current.progress} %`
  }
  if (current.status === 'completed')
    return '上传完成'
  if (current.status === 'uploading')
    return current.progress >= 95 ? '服务器处理中' : `${current.progress} %`
  return ''
})

const replace_status_text = computed(() => {
  const current = replacing.value
  if (! current)
    return ''
  return current.progress >= 95 ? '服务器处理中' : `替换中 ${current.progress} %`
})

function open_file() {
  const file = stored.value
  if (file)
    window.open(static_url(file.url), '_blank', 'noopener,noreferrer')
}

function on_dblclick() {
  const file = stored.value
  if (! file)
    return
  if (file.is_image && ! props.readonly)
    emit('preview', static_url(file.url))
  else
    open_file()
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
  if (state.value.move_pending || folder.value?.dimmed)
    return
  document.dispatchEvent(new Event(menu_open_event))
  // Open at the row's bottom-left corner instead of at the pointer.
  const rect = row_el.value?.getBoundingClientRect()
  menu.value?.show({
    pageX: rect ? rect.left + window.scrollX : event.pageX,
    pageY: rect ? rect.bottom + window.scrollY : event.pageY,
    stopPropagation: () => event.stopPropagation(),
    preventDefault: () => event.preventDefault(),
  })
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
  if (! menu_items.value.length)
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
  @apply col-span-full flex w-full min-w-0 cursor-pointer select-none items-center gap-2 border border-dashed border-transparent py-1 pr-2;
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
