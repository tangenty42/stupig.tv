<template>
  <div
    ref="root_el"
    class="w-full"
    :class="layout === 'stack' ? 'px-4' : ''"
    @dragenter.capture="emit('root-dragenter', $event)"
    @dragover.capture="emit('root-dragover', $event)"
    @dragleave.capture="emit('root-dragleave', $event)"
    @drop.capture="emit('root-drop', $event)"
    @pointerdown="on_marquee_pointerdown"
    @contextmenu="on_background_contextmenu"
  >
    <div v-if="! readonly" :class="header_class">
      <input
        ref="file_input"
        type="file"
        multiple
        class="hidden"
        @change="on_files_picked"
      >
      <input
        ref="folder_input"
        type="file"
        webkitdirectory
        class="hidden"
        @change="on_files_picked"
      >
      <Button
        class="w-8 h-auto aspect-square"
        aria-label="添加附件"
        @click="add_menu?.toggle($event)"
      >
        <template #icon>
          <MyIcon name="lucide:plus" />
        </template>
      </Button>
      <ContextMenu ref="add_menu" :model="add_menu_items">
        <template #itemicon="{ item }">
          <MyIcon :name="item.icon_name" />
        </template>
      </ContextMenu>
    </div>

    <div
      v-if="rows.length"
      class="file-list"
      :class="[list_class, { 'file-list-moving': move_to_root, 'file-list-drag-over': root_drag_over }]"
    >
      <template v-for="row in rows" :key="row.key">
        <MyContentAttachmentCard
          :row="row"
          :readonly="readonly"
          :data-row-key="row.key"
          :data-folder="row_data_folder(row)"
          :style="{ paddingLeft: `${0.5 + row.depth * 1.25}rem` }"
          @click="emit('row-click', $event, row)"
          @contextmenu="emit('row-contextmenu', $event, row)"
          @toggle-selection="emit('toggle-selection', row)"
          @dragstart="emit('row-dragstart', $event, row)"
          @dragend="emit('row-dragend', row)"
          @preview="emit('preview', $event)"
          @copy="emit('copy', row)"
          @rename="emit('rename', row)"
          @replace="emit('replace', row)"
          @create-abridged="emit('create-abridged', row)"
          @encrypt="emit('encrypt', $event, row)"
          @decrypt="emit('decrypt', $event, row)"
          @delete="emit('delete', $event, row)"
          @retry="emit('retry', row)"
          @pause="emit('pause', row)"
          @cancel="emit('cancel', $event, row)"
          @remove="emit('remove', $event, row)"
          @start-selection="emit('start-selection', row)"
          @pause-selection="emit('pause-selection', row)"
          @delete-selection="emit('delete-selection', $event, row)"
          @create-folder="emit('create-folder', row_folder_path(row))"
          @rename-folder="emit('rename-folder', row_folder_path(row))"
          @delete-folder="emit('delete-folder', $event, row_folder_path(row))"
          @copy-folder="emit('copy-folder', row)"
          @upload-files="pick_files(row_folder_path(row))"
          @upload-folder="pick_folder(row_folder_path(row))"
        />
      </template>
    </div>

    <div v-else :class="empty_class">
      暂无附件~
    </div>

    <div v-if="layout === 'columns'" class="h-48" aria-hidden="true" />

    <div v-if="marquee_style" class="marquee-rect" :style="marquee_style" />
  </div>
</template>

<script setup lang="ts">
import type { MenuItem } from 'primevue/menuitem'
import type { AttachmentUploadPick, MyContentAttachmentRow } from '~/utils/content/attachment'
import { attachment_folder_of } from '@shared/content-markdown'
import { picks_from_file_handles } from '~/utils/content/attachment'

type FileMenuItem = MenuItem & { icon_name?: string }

interface Props {
  /** Pre-built flat rows (folders + files, in display order) from the page. */
  rows: MyContentAttachmentRow[]
  upload_busy: boolean
  /** Whether the root is the current move target (background highlight). */
  move_to_root?: boolean
  /** Whether a drag hovers the list background (root drop target). */
  root_drag_over?: boolean
  /** Render the attachment tree without upload, move, or edit controls. */
  readonly?: boolean
  layout?: 'stack' | 'columns'
}

const props = withDefaults(defineProps<Props>(), {
  move_to_root: false,
  root_drag_over: false,
  readonly: false,
  layout: 'columns',
})

const emit = defineEmits<{
  'files-picked': [picks: AttachmentUploadPick[]]
  'create-folder': [parent: string | null]
  'row-click': [event: MouseEvent, row: MyContentAttachmentRow]
  'row-contextmenu': [event: MouseEvent, row: MyContentAttachmentRow]
  'toggle-selection': [row: MyContentAttachmentRow]
  'row-dragstart': [event: DragEvent, row: MyContentAttachmentRow]
  'row-dragend': [row: MyContentAttachmentRow]
  'preview': [url: string]
  'copy': [row: MyContentAttachmentRow]
  'rename': [row: MyContentAttachmentRow]
  'replace': [row: MyContentAttachmentRow]
  'create-abridged': [row: MyContentAttachmentRow]
  'encrypt': [event: MouseEvent, row: MyContentAttachmentRow]
  'decrypt': [event: MouseEvent, row: MyContentAttachmentRow]
  'delete': [event: MouseEvent, row: MyContentAttachmentRow]
  'retry': [row: MyContentAttachmentRow]
  'pause': [row: MyContentAttachmentRow]
  'cancel': [event: MouseEvent, row: MyContentAttachmentRow]
  'remove': [event: MouseEvent, row: MyContentAttachmentRow]
  'start-selection': [row: MyContentAttachmentRow]
  'pause-selection': [row: MyContentAttachmentRow]
  'delete-selection': [event: MouseEvent, row: MyContentAttachmentRow]
  'rename-folder': [path: string]
  'delete-folder': [event: MouseEvent, path: string]
  'copy-folder': [row: MyContentAttachmentRow]
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

const add_menu_items: FileMenuItem[] = [
  { label: '上传文件', icon_name: 'lucide:paperclip', command: () => void pick_files() },
  { label: '上传文件夹', icon_name: 'lucide:folder-up', command: () => void pick_folder() },
  { separator: true },
  { label: '新建文件夹', icon_name: 'lucide:folder-plus', command: () => emit('create-folder', null) },
]

const header_class = computed(() => 'w-full py-2 flex justify-center items-center')
// Both layouts cap the list: on a wide screen a full-bleed row pushes the size
// far from the name it belongs to. Only the editor needs the gap under its
// add-file button.
const list_class = computed(() => props.layout === 'columns'
  ? 'mx-auto mt-2 flex w-full max-w-3xl flex-col'
  : 'mx-auto flex w-full max-w-3xl flex-col')
const empty_class = computed(() => 'py-2 text-center text-xs text-slate-500 dark:text-slate-400')

function on_files_picked(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [... (input.files ?? [])]
  input.value = ''
  const target = input_target_folder.value
  input_target_folder.value = null
  emit('files-picked', with_target_folder(files.map(file => ({ file, file_name: file.webkitRelativePath || file.name })), target))
}

// Right-click on the list background opens the same menu as the "+" button;
// rows have their own context menus and keep them.
function on_background_contextmenu(event: MouseEvent) {
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
  return target ? picks.map(pick => ({ ... pick, file_name: `${target}/${pick.file_name}` })) : picks
}

// Prefer the File System Access pickers (Chromium) so picks carry a resumable
// handle; fall back to the hidden inputs where they are unavailable.
async function pick_files(target: string | null = null) {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      emit('files-picked', with_target_folder(await picks_from_file_handles(await window.showOpenFilePicker({ multiple: true })), target))
      return
    }
    catch (ex) {
      if ((ex as DOMException).name === 'AbortError')
        return
    }
  }
  input_target_folder.value = target
  file_input.value?.click()
}

async function pick_folder(target: string | null = null) {
  if (typeof window.showDirectoryPicker === 'function') {
    try {
      emit('files-picked', with_target_folder(await picks_from_file_handles([await window.showDirectoryPicker()]), target))
      return
    }
    catch (ex) {
      if ((ex as DOMException).name === 'AbortError')
        return
    }
  }
  input_target_folder.value = target
  folder_input.value?.click()
}

/** The drop-target folder a row belongs to: folder rows are their own path, file rows their parent folder. */
function row_data_folder(row: MyContentAttachmentRow) {
  if (row.data.kind === 'folder')
    return row.data.path
  return attachment_folder_of(row.data.file_name) ?? undefined
}

function row_folder_path(row: MyContentAttachmentRow): string {
  return row.data.kind === 'folder' ? row.data.path : ''
}

// Rubber-band selection from the list background: live-updates the selection
// with the rows intersecting the dragged rectangle (viewport coordinates).
const root_el = ref<HTMLElement>()
const marquee = ref<{ x1: number, y1: number, x2: number, y2: number } | null>(null)
let marquee_additive = false

const marquee_style = computed(() => {
  const current = marquee.value
  if (! current)
    return null
  const width = Math.abs(current.x2 - current.x1)
  const height = Math.abs(current.y2 - current.y1)
  // Hide below a small threshold so plain clicks never flash the rectangle.
  if (width < 4 && height < 4)
    return null
  return {
    left: `${Math.min(current.x1, current.x2)}px`,
    top: `${Math.min(current.y1, current.y2)}px`,
    width: `${width}px`,
    height: `${height}px`,
  }
})

function on_marquee_pointerdown(event: PointerEvent) {
  if (props.readonly || event.button !== 0)
    return
  const target = event.target as HTMLElement | null
  if (! target || target.closest('.file-row, .folder-row, button, input, a'))
    return
  // Keep the drag from selecting text on the page.
  event.preventDefault()
  marquee_additive = event.ctrlKey || event.metaKey
  marquee.value = { x1: event.clientX, y1: event.clientY, x2: event.clientX, y2: event.clientY }
  emit('marquee-select', [], marquee_additive, 'start')
  window.addEventListener('pointermove', on_marquee_move)
  window.addEventListener('pointerup', on_marquee_end, { once: true })
}

function on_marquee_move(event: PointerEvent) {
  const current = marquee.value
  if (! current)
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

function on_marquee_end() {
  window.removeEventListener('pointermove', on_marquee_move)
  if (marquee.value)
    emit('marquee-select', [], marquee_additive, 'end')
  marquee.value = null
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', on_marquee_move)
})
</script>

<style scoped>
/* Subtle inset indicator on the list when the root is the move target. */
.file-list-moving {
  @apply rounded-sm bg-primary/5;
  box-shadow: inset 0 0 0 1px theme('colors.primary / 0.3');
}

/* Root drag-over is border-only so row hover backgrounds stay visible; the
   padding keeps the border off the rows. */
.file-list {
  @apply rounded-sm border border-dashed border-transparent p-1;
  transition: border-color 150ms ease, background-color 150ms ease, box-shadow 150ms ease;
}

.file-list-drag-over {
  @apply border-primary/50 bg-primary/10 bg-clip-border;
}

/* Rubber-band selection rectangle (viewport-fixed, never intercepts events). */
.marquee-rect {
  @apply pointer-events-none fixed z-40 border border-primary/50 bg-primary/10;
}
</style>
