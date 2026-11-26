<template>
  <div
    ref="root_el"
    class="file-list-root relative w-full"
    :aria-busy="loading || undefined"
    :class="[layout === 'stack' ? 'px-4' : '', { 'file-list-root-drag-over': root_drag_over }]"
    @dragenter.capture="emit('root-dragenter', $event)"
    @dragover.capture="emit('root-dragover', $event)"
    @dragleave.capture="emit('root-dragleave', $event)"
    @drop.capture="emit('root-drop', $event)"
    @pointerdown="on_marquee_pointerdown"
    @lostpointercapture="on_marquee_end"
    @contextmenu="on_background_contextmenu"
  >
    <!-- A separate touch surface reserves background drags for selection;
         rows remain siblings so their native vertical scrolling still works. -->
    <div class="absolute inset-0" :class="readonly ? 'pointer-events-none' : 'touch-none'" aria-hidden="true" />
    <div v-if="! readonly && add_controls" :class="header_class">
      <input
        ref="file_input"
        aria-label="选择上传文件"
        type="file"
        multiple
        class="hidden"
        @change="on_files_picked"
        @cancel="input_target_folder = null"
      >
      <input
        ref="folder_input"
        aria-label="选择上传文件夹"
        type="file"
        webkitdirectory
        class="hidden"
        @change="on_files_picked"
        @cancel="input_target_folder = null"
      >
      <Button
        class="mt-2 pointer-events-auto !w-8 h-auto aspect-square"
        outlined
        aria-label="添加"
        :aria-busy="upload_busy"
        :disabled="upload_busy"
        :title="upload_busy ? '正在准备上传' : undefined"
        @click="add_menu?.toggle($event)"
      >
        <template #icon>
          <MyIcon v-if="upload_busy" name="lucide:loader-circle" class="animate-spin" />
          <MyIcon v-else name="lucide:plus" />
        </template>
      </Button>
      <ContextMenu v-if="context_menu" ref="add_menu" :model="add_menu_items">
        <template #itemicon="{ item }">
          <MyIcon :name="item.icon_name" />
        </template>
      </ContextMenu>
    </div>
    <MyDialog v-if="! readonly && add_controls" :visible="!! retry_picker" header="未能添加附件" @update:visible="retry_picker = null">
      <p class="whitespace-pre-wrap break-words">
        {{ retry_picker?.message }}
      </p>
      <template #footer>
        <Button v-if="retry_picker" label="重新选择" :disabled="upload_busy" @click="retry_selection">
          <template #icon>
            <MyIcon name="lucide:folder-open" aria-hidden="true" />
          </template>
        </Button>
      </template>
    </MyDialog>

    <div v-if="error && ! loading" :class="empty_class">
      <MyContentListLoadError class="pointer-events-auto" @retry="emit('retry')" />
    </div>

    <div
      v-if="rows.length"
      class="file-list pointer-events-none relative"
      :class="[list_class, { 'file-list-moving': move_to_root }]"
    >
      <template v-for="row in rows" :key="row.key">
        <MyContentAttachmentCard
          class="pointer-events-auto"
          :row="row"
          :menu_items="menu_items(row)"
          :readonly="readonly"
          :context_menu="context_menu"
          :data-row-key="row.key"
          :data-folder="row_data_folder(row)"
          :style="{ paddingLeft: `${0.5 + row.depth * 1.25}rem` }"
          @click="emit('row-click', $event, row)"
          @contextmenu="emit('row-contextmenu', $event, row)"
          @toggle-selection="emit('toggle-selection', row)"
          @dragstart="emit('row-dragstart', $event, row)"
          @dragend="emit('row-dragend', row)"
          @open="emit('open', row)"
        />
      </template>
    </div>

    <div v-else-if="loading" :class="list_class" class="file-list pointer-events-none relative" role="status" aria-label="正在加载附件">
      <div v-for="index in 3" :key="index" class="flex h-7 items-center px-2" aria-hidden="true">
        <Skeleton width="13rem" height="1rem" class="max-w-full" />
      </div>
    </div>

    <div v-else-if="! error" :class="empty_class">
      暂无附件~
    </div>

    <div v-if="layout === 'columns'" class="pointer-events-none h-48" aria-hidden="true" />

    <div v-if="marquee_style" class="marquee-rect" :style="marquee_style" />
  </div>
</template>

<script setup lang="ts">
import type { AttachmentMenuItem } from '~/features/content/attachments/list-interaction'
import type { MyContentAttachmentRow } from '~/features/content/attachments/list-model'
import type { AttachmentUploadPick } from '~/features/content/uploads/picks'
import { attachment_folder_of } from '@shared/content-markdown'
import { attachment_add_menu_items } from '~/features/content/attachments/list-interaction'
import { attachment_pick_from_file } from '~/features/content/uploads/picks'

interface Props {
  /** Pre-built flat rows (folders + files, in display order) from the page. */
  rows: MyContentAttachmentRow[]
  /** Commands are supplied by the API/dialog controller, not owned by the row. */
  menu_items: (row: MyContentAttachmentRow) => AttachmentMenuItem[]
  upload_busy: boolean
  loading?: boolean
  error?: string | null
  create_folder_disabled?: boolean
  /** Whether the root is the current move target (background highlight). */
  move_to_root?: boolean
  /** Whether a drag hovers the list background (root drop target). */
  root_drag_over?: boolean
  /** Render the attachment tree without upload, move, or edit controls. */
  readonly?: boolean
  layout?: 'stack' | 'columns'
  add_controls?: boolean
  context_menu?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  move_to_root: false,
  loading: false,
  error: null,
  create_folder_disabled: false,
  root_drag_over: false,
  readonly: false,
  layout: 'columns',
  add_controls: true,
  context_menu: true,
})

const emit = defineEmits<{
  'retry': []
  'files-picked': [picks: AttachmentUploadPick[]]
  'create-folder': [parent: string | null]
  'row-click': [event: MouseEvent, row: MyContentAttachmentRow]
  'row-contextmenu': [event: MouseEvent, row: MyContentAttachmentRow]
  'toggle-selection': [row: MyContentAttachmentRow]
  'row-dragstart': [event: DragEvent, row: MyContentAttachmentRow]
  'row-dragend': [row: MyContentAttachmentRow]
  'open': [row: MyContentAttachmentRow]
  'root-dragenter': [event: DragEvent]
  'root-dragover': [event: DragEvent]
  'root-dragleave': [event: DragEvent]
  'root-drop': [event: DragEvent]
  'marquee-select': [keys: string[], additive: boolean, phase: 'start' | 'move' | 'end']
}>()

const file_input = ref<HTMLInputElement>()
const folder_input = ref<HTMLInputElement>()
const add_menu = ref<{ toggle: (event: Event) => void, show: (event: Event) => void }>()

/** Folder a folder-row picker targets; the hidden inputs stash it here until change fires. */
const input_target_folder = ref<string | null>(null)
type PickerKind = '文件' | '文件夹'
const retry_picker = ref<{ kind: PickerKind, target: string | null, message: string } | null>(null)

const add_menu_items = computed(() => attachment_add_menu_items({
  upload_busy: props.upload_busy,
  create_folder_disabled: props.create_folder_disabled,
  upload: () => pick_files(),
  upload_folder: () => pick_folder(),
  create_folder: () => emit('create-folder', null),
}))

const header_class = computed(() => 'pointer-events-none relative w-full py-2 flex justify-center items-center')
// Both layouts cap the list: on a wide screen a full-bleed row pushes the size
// far from the name it belongs to. Only the editor needs the gap under its
// add-file button.
const list_class = computed(() => props.layout === 'columns'
  ? 'mx-auto mt-2 flex w-full max-w-3xl flex-col'
  : 'mx-auto flex w-full max-w-3xl flex-col')
const empty_class = computed(() => 'pointer-events-none relative py-2 text-center text-xs text-slate-500 dark:text-slate-400')

function on_files_picked(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const files = [... (input.files ?? [])]
  input.value = ''
  const target = input_target_folder.value
  input_target_folder.value = null
  if (! files.length) {
    const kind = input === folder_input.value ? '文件夹' : '文件'
    const message = kind === '文件夹' ? '所选文件夹中没有文件，请选择包含文件的文件夹' : '没有可添加的文件，请重新选择或将文件拖到附件列表'
    retry_picker.value = { kind, target, message }
    return
  }
  emit('files-picked', with_target_folder(files.map(attachment_pick_from_file), target))
}

// Right-click on the list background opens the same menu as the "+" button;
// rows have their own context menus and keep them.
function on_background_contextmenu(event: MouseEvent) {
  if (! props.context_menu) {
    event.preventDefault()
    return
  }
  if (props.readonly)
    return
  const target = event.target as HTMLElement | null
  if (! target || target.closest('.file-row, .folder-row, button, input, a'))
    return
  event.preventDefault()
  add_menu.value?.show(event)
}

/** Prefix picks with the folder a folder-row menu targeted, if any. */
function with_target_folder(picks: AttachmentUploadPick[], target: string | null) {
  return target ? picks.map(pick => ({ ... pick, file_name: `${target}/${pick.file_name}`, selection_root: pick.selection_root ? `${target}/${pick.selection_root}` : undefined })) : picks
}

// Open on the menu/button's user gesture. The input delivers Files on change,
// independently of window focus and the Markdown editor's write lease.
function open_file_input(kind: PickerKind, target: string | null) {
  const input = kind === '文件' ? file_input.value : folder_input.value
  if (! input || props.upload_busy)
    return
  retry_picker.value = null
  input_target_folder.value = target
  try {
    if (typeof input.showPicker === 'function')
      input.showPicker()
    else
      input.click()
  }
  catch {
    input_target_folder.value = null
    retry_picker.value = { kind, target, message: `无法打开${kind}选择窗口，请重新选择或将${kind}拖到附件列表` }
  }
}

function retry_selection() {
  const retry = retry_picker.value
  if (retry)
    open_file_input(retry.kind, retry.target)
}

function pick_files(target: string | null = null) {
  open_file_input('文件', target)
}

function pick_folder(target: string | null = null) {
  open_file_input('文件夹', target)
}

/** The drop-target folder a row belongs to: folder rows are their own path, file rows their parent folder. */
function row_data_folder(row: MyContentAttachmentRow) {
  if (row.data.kind === 'folder')
    return row.data.path
  return attachment_folder_of(row.data.file_name) ?? undefined
}

// Rubber-band selection from the list background: live-updates the selection
// with the rows intersecting the dragged rectangle (viewport coordinates).
const root_el = ref<HTMLElement>()
const marquee = ref<{ x1: number, y1: number, x2: number, y2: number } | null>(null)
let marquee_additive = false
let marquee_pointer_id: number | null = null

const marquee_style = computed(() => {
  const current = marquee.value
  const root = root_el.value
  if (! current || ! root)
    return null
  const width = Math.abs(current.x2 - current.x1)
  const height = Math.abs(current.y2 - current.y1)
  // Hide below a small threshold so plain clicks never flash the rectangle.
  if (width < 4 && height < 4)
    return null
  const bounds = root.getBoundingClientRect()
  return {
    left: `${Math.min(current.x1, current.x2) - bounds.left - root.clientLeft + root.scrollLeft}px`,
    top: `${Math.min(current.y1, current.y2) - bounds.top - root.clientTop + root.scrollTop}px`,
    width: `${width}px`,
    height: `${height}px`,
  }
})

function on_marquee_pointerdown(event: PointerEvent) {
  if (props.readonly || event.button !== 0 || ! event.isPrimary || marquee_pointer_id !== null)
    return
  const target = event.target as HTMLElement | null
  if (! target || target.closest('.file-row, .folder-row, button, input, a'))
    return
  // Keep the drag from selecting text on the page.
  event.preventDefault()
  marquee_pointer_id = event.pointerId
  if (event.isTrusted)
    root_el.value?.setPointerCapture(event.pointerId)
  marquee_additive = event.ctrlKey || event.metaKey
  marquee.value = { x1: event.clientX, y1: event.clientY, x2: event.clientX, y2: event.clientY }
  emit('marquee-select', [], marquee_additive, 'start')
  window.addEventListener('pointermove', on_marquee_move)
  window.addEventListener('pointerup', on_marquee_end)
  window.addEventListener('pointercancel', on_marquee_end)
  window.addEventListener('blur', cancel_marquee)
}

function on_marquee_move(event: PointerEvent) {
  const current = marquee.value
  if (! current || event.pointerId !== marquee_pointer_id)
    return
  current.x2 = event.clientX
  current.y2 = event.clientY
  const left = Math.min(current.x1, current.x2)
  const top = Math.min(current.y1, current.y2)
  const right = Math.max(current.x1, current.x2)
  const bottom = Math.max(current.y1, current.y2)
  const keys: string[] = []
  for (const el of root_el.value?.querySelectorAll<HTMLElement>('[data-row-key]') ?? []) {
    const rect = el.getBoundingClientRect()
    if (rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top && el.dataset.rowKey)
      keys.push(el.dataset.rowKey)
  }
  emit('marquee-select', keys, marquee_additive, 'move')
}

function on_marquee_end(event: PointerEvent) {
  if (event.pointerId === marquee_pointer_id)
    cancel_marquee()
}

function cancel_marquee() {
  window.removeEventListener('pointermove', on_marquee_move)
  window.removeEventListener('pointerup', on_marquee_end)
  window.removeEventListener('pointercancel', on_marquee_end)
  window.removeEventListener('blur', cancel_marquee)
  const pointer_id = marquee_pointer_id
  marquee_pointer_id = null
  if (pointer_id !== null && root_el.value?.hasPointerCapture(pointer_id))
    root_el.value.releasePointerCapture(pointer_id)
  if (marquee.value)
    emit('marquee-select', [], marquee_additive, 'end')
  marquee.value = null
}

defineExpose({ pick_files, pick_folder })

onBeforeUnmount(cancel_marquee)
</script>

<style scoped>
/* Subtle inset indicator on the list when the root is the move target. */
.file-list-moving {
  @apply rounded-sm bg-primary/5;
  box-shadow: inset 0 0 0 1px theme('colors.primary / 0.3');
}

/* Keep the existing row spacing; the root drop indicator is drawn separately. */
.file-list {
  @apply rounded-sm border border-dashed border-transparent p-1;
  transition: border-color 150ms ease, background-color 150ms ease, box-shadow 150ms ease;
}

/* Match the drop receiver, including empty space below and beside the rows. */
.file-list-root::after {
  content: '';
  @apply pointer-events-none absolute inset-0 bg-primary/10 opacity-0;
  transition: opacity 150ms ease;
}

.file-list-root-drag-over::after {
  opacity: 1;
}

/* Position within the list: transformed dialogs must not offset the rectangle. */
.marquee-rect {
  @apply pointer-events-none absolute z-40 border border-primary/50 bg-primary/10;
}
</style>
