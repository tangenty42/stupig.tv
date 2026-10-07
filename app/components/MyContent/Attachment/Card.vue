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
        <MyIcon v-if="row_pending" name="lucide:loader-circle" class="animate-spin" />
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
            :name="stored?.is_abridged_twin ? 'lucide:lock-open' : file_icon(file_row)"
            class="shrink-0 text-base"
            :class="icon_class"
          />
          <span v-if="stored?.is_encrypted" class="shrink-0 text-xs text-amber-600 dark:text-amber-400">已加密</span>
          <span v-else-if="stored?.is_abridged_twin" class="shrink-0 text-xs text-sky-600 dark:text-sky-400">删减版</span>
          <span class="min-w-0 flex-1 truncate text-sm">{{ display_name_parts.base }}<span v-if="display_name_parts.suffix" class="text-amber-600 dark:text-amber-400">{{ display_name_parts.suffix }}</span></span>
          <span class="ml-auto flex shrink-0 items-center pl-2 text-xs text-slate-400 dark:text-slate-500">
            <MyIcon v-if="row_pending && ! row_progress_text" name="lucide:loader-circle" class="animate-spin" />
            <template v-else-if="row_progress_text">{{ row_progress_text }}</template>
            <template v-else>{{ format_bytes(file_row.file_size) }}</template>
          </span>
        </div>

        <div v-if="upload && upload.status !== 'error'" class="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {{ upload_status_text }}
        </div>
        <span v-else-if="upload" class="mt-0.5 truncate text-xs text-red-600 dark:text-red-400">
          上传失败：{{ upload.message }}
        </span>
      </div>
    </template>

    <ContextMenu
      ref="menu"
      :model="menu_model ?? menu_items"
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
import type { ContentStoryAttachment } from '@shared/types/content'
import type { MenuItem } from 'primevue/menuitem'
import type { MyContentAttachmentRow } from '~/utils/content/attachment'
import { attachment_base_name, CONTENT_ATTACHMENT_DENIED_TEXT, decrypted_attachment_name, encrypted_attachment_suffix, is_encrypted_attachment, redactable_attachment_mime } from '@shared/content-markdown'
import { attachment_is_media, attachment_leading_action, file_icon, open_decrypted_attachment, save_decrypted_attachment, save_url_as } from '~/utils/content/attachment'
import { decrypted_blob_url, decrypting_urls } from '~/utils/content/attachment-crypto'
import { format_bytes, format_speed } from '~/utils/size'

type AttachmentMenuItem = MenuItem & { icon_name?: string, spin?: boolean }

/** What ContextMenu.show() reads — satisfied by a MouseEvent or by long-press coordinates. */
type MenuOpenEvent = Pick<MouseEvent, 'pageX' | 'pageY' | 'stopPropagation' | 'preventDefault'>

interface Props {
  row: MyContentAttachmentRow
  /** Owning story; the signed download URL is requested against it. */
  story_id: number
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
  'create-abridged': []
  'encrypt': [event: MouseEvent]
  'decrypt': [event: MouseEvent]
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
  'upload-files': []
  'upload-folder': []
}>()

const static_url = useStaticUrl()
const api = useApi()
const { info: toast_info, error: toast_error } = useMyToast()

const row_el = ref<HTMLElement>()
const menu = ref<{ show: (event: MenuOpenEvent) => void, hide: () => void }>()
const menu_open = ref(false)
/**
 * The entry list the open menu was built with, or null while it is closed. A
 * menu is a snapshot of what was clicked: the outside click that dismisses it
 * first clears or moves the selection (the page's document-level pointerdown
 * runs before PrimeVue hides the menu on click), and without the freeze the
 * panel would swap to the action set of the new selection on its way out —
 * which reads as one menu closing and another flashing up behind it.
 */
const menu_model = ref<AttachmentMenuItem[] | null>(null)

// Anchor the confirm popup to the row: the clicked menu item is unmounted
// together with the menu right after the command runs.
function row_anchor_event() {
  return { currentTarget: row_el.value } as unknown as MouseEvent
}

const data = computed(() => props.row.data)
const state = computed(() => props.row.state)
const stored = computed(() => data.value.kind === 'stored' ? data.value : null)
/** Encrypted and no key shipped with the payload: opening would yield ciphertext. */
const denied_access = computed(() => !! stored.value?.is_encrypted && ! stored.value.encryption_key)
/**
 * Why the 删减版 action is unavailable, or empty when it can run. The entry
 * stays in the menu either way, so a format the editor cannot write back (a
 * GIF, a PDF) reads as a limitation of the tool rather than as a missing
 * feature. A file can be inapplicable for several independent reasons at once
 * (an unencrypted GIF is both), so all of them are reported.
 */
const abridged_blocked_reasons = computed(() => {
  const file = stored.value
  if (! file)
    return []
  const reasons: string[] = []
  if (! redactable_attachment_mime(file.file_name))
    reasons.push('格式不支持')
  if (denied_access.value)
    reasons.push(CONTENT_ATTACHMENT_DENIED_TEXT)
  if (! file.is_encrypted)
    reasons.push('未加密')
  else
    reasons.push(... state.value.decrypt_blocked_reasons)
  return reasons
})

/** Separates independent reasons in one disabled entry ("已加密 / 文件太大"). */
const reason_separator = ' / '

/**
 * An action entry, or the reasons it cannot run. One rule for every operation,
 * single row or selection: it is offered whenever anything in its target set
 * can take it (the rest is skipped when it runs), and otherwise lists every
 * reason why not — keeping the action's own icon, so a row still reads as
 * "encrypt is unavailable" rather than as a generic refusal. Several reasons
 * are listed side by side: a selection can hold files that are inapplicable
 * for different causes, and naming only one would hide the rest.
 */
function action_item(options: { label: string, reasons: string[], icon_name: string, disabled?: boolean, danger?: boolean, command: () => void }): AttachmentMenuItem {
  if (options.reasons.length)
    return { label: options.reasons.join(reason_separator), icon_name: options.icon_name, disabled: true }
  return {
    label: options.label,
    icon_name: options.icon_name,
    class: options.danger ? 'attachment-menu-danger' : undefined,
    disabled: options.disabled ?? false,
    command: options.command,
  }
}

/** The row's ciphertext URL is mid decrypt+download right now. */
const is_decrypting = computed(() => {
  const file = stored.value
  return !! file?.is_encrypted && !! file.encryption_key && decrypting_urls.has(static_url(file.url))
})
const upload = computed(() => data.value.kind === 'upload' ? data.value : null)
const folder = computed(() => data.value.kind === 'folder' ? data.value : null)
const file_row = computed(() => data.value.kind === 'folder' ? null : data.value)
const progress_percent = computed(() => {
  if (upload.value && upload.value.status !== 'error' && upload.value.status !== 'queued')
    return upload.value.progress
  return null
})

/** Any in-flight operation on this row: its meta slot falls back to a spinner. */
const row_pending = computed(() => {
  const current_folder = folder.value
  if (current_folder)
    return state.value.delete_pending || current_folder.moving || current_folder.dimmed
  const task = upload.value
  if (task)
    return task.status === 'queued' || task.status === 'uploading'
  return state.value.delete_pending || state.value.encrypt_pending || state.value.move_pending
})

/** Measured progress text for the meta slot (transfer rate, or paused bytes). */
const row_progress_text = computed(() => {
  const task = upload.value
  if (task?.status === 'uploading')
    return task.speed > 0 ? format_speed(task.speed) : null
  if (task?.status === 'paused')
    return `${format_bytes(task.file_size * task.progress / 100)} / ${format_bytes(task.file_size)}`
  return null
})
const display_name = computed(() => folder.value ? folder.value.name : attachment_base_name(data.value.kind === 'folder' ? '' : data.value.file_name))

/**
 * The name split so the `.good` suffix can carry the confidential color. The
 * suffix is a marker the server appends when it encrypts a file, not part of
 * the name the author chose, so it reads as a tag on the name rather than as
 * part of it.
 */
const display_name_parts = computed(() => {
  const name = display_name.value
  return is_encrypted_attachment(name)
    ? { base: decrypted_attachment_name(name), suffix: encrypted_attachment_suffix }
    : { base: name, suffix: '' }
})
const selection_count = computed(() => state.value.selected ? state.value.selection_count : 0)
/** An in-flight operation on this row alone locks the entries that would collide with it. */
const row_locked = computed(() => state.value.structure_locked || row_pending.value)

/**
 * The encrypt/decrypt entries, on the unified availability rule. `busy` is the
 * transient guard: a single row waits only for itself, while a batch waits for
 * the whole selection to be idle (which is what the page's flag reports).
 */
function encryption_items(busy: boolean): AttachmentMenuItem[] {
  return [
    action_item({
      label: '加密',
      reasons: state.value.encrypt_blocked_reasons,
      icon_name: 'lucide:lock',
      disabled: busy,
      command: () => emit('encrypt', row_anchor_event()),
    }),
    action_item({
      label: '取消加密',
      reasons: state.value.decrypt_blocked_reasons,
      icon_name: 'lucide:lock-open',
      disabled: busy,
      command: () => emit('decrypt', row_anchor_event()),
    }),
  ]
}

/** The delete entry for a file or folder row, on the same rule. */
function delete_item(kind: 'file' | 'folder'): AttachmentMenuItem {
  return action_item({
    label: '删除',
    reasons: state.value.delete_blocked_reasons,
    icon_name: 'lucide:trash-2',
    disabled: state.value.delete_disabled || row_pending.value,
    danger: true,
    // Anchor the confirm popup to the row: the clicked menu item is unmounted
    // together with the menu right after the command runs.
    command: () => {
      const anchor = { currentTarget: row_el.value } as unknown as MouseEvent
      if (kind === 'file')
        emit('delete', anchor)
      else
        emit('delete-folder', anchor)
    },
  })
}

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
  && ! row_pending.value
  && (folder.value ? ! folder.value.batch_pending : stored.value !== null))

const icon_class = computed(() => {
  if (upload.value?.status === 'error')
    return 'text-red-500 dark:text-red-400'
  if (upload.value && upload.value.status !== 'completed')
    return 'text-primary'
  // Encrypted rows and abridged twins tint their lock icon with the badge color.
  if (stored.value?.is_encrypted)
    return 'text-amber-600 dark:text-amber-400'
  if (stored.value?.is_abridged_twin)
    return 'text-sky-600 dark:text-sky-400'
  return 'text-slate-400 dark:text-slate-500'
})

const menu_items = computed<AttachmentMenuItem[]>(() => {
  const current_folder = folder.value
  if (props.readonly) {
    const file = stored.value
    if (current_folder || ! file)
      return []
    // Encrypted without a shipped key: nothing useful to open (ciphertext).
    if (denied_access.value)
      return [{ label: CONTENT_ATTACHMENT_DENIED_TEXT, icon_name: 'lucide:ban', disabled: true }]
    if (is_decrypting.value)
      return [{ label: '解密中', icon_name: 'lucide:loader-circle', spin: true, disabled: true }]
    return open_download_items(file)
  }
  if (current_folder) {
    if (selection_count.value > 1)
      return [... encryption_items(state.value.delete_disabled), delete_item('folder')]
    return [
      // Same label and same shorthand as a file card: `[](folder)` renders the
      // folder card, no `!` prefix.
      { label: '复制 Markdown 代码', icon_name: 'lucide:copy', command: () => emit('copy-folder') },
      { separator: true },
      { label: '上传文件', icon_name: 'lucide:paperclip', command: () => emit('upload-files') },
      { label: '上传文件夹', icon_name: 'lucide:folder-up', command: () => emit('upload-folder') },
      { separator: true },
      { label: '新建子文件夹', icon_name: 'lucide:folder-plus', disabled: row_locked.value, command: () => emit('create-folder') },
      { label: '重命名', icon_name: 'lucide:pencil', disabled: row_locked.value, command: () => emit('rename-folder') },
      delete_item('folder'),
    ]
  }

  const file = stored.value
  if (file) {
    // A right-clicked member of a multi-selection gets the batch actions only.
    if (selection_count.value > 1)
      return [... encryption_items(state.value.delete_disabled), delete_item('file')]
    const leading: AttachmentMenuItem[] = denied_access.value
      ? [{ label: CONTENT_ATTACHMENT_DENIED_TEXT, icon_name: 'lucide:ban', disabled: true }]
      : is_decrypting.value
        ? [{ label: '解密中', icon_name: 'lucide:loader-circle', spin: true, disabled: true }]
        : open_download_items(file)
    const items: AttachmentMenuItem[] = [
      ... leading,
      { label: '复制 Markdown 代码', icon_name: 'lucide:copy', command: () => emit('copy') },
    ]
    items.push(
      { separator: true },
      { label: '重命名', icon_name: 'lucide:pencil', disabled: row_locked.value, command: () => emit('rename') },
      action_item({
        label: '替换文件',
        reasons: state.value.replace_blocked_reasons,
        icon_name: 'lucide:refresh-cw',
        disabled: state.value.replace_disabled || row_locked.value,
        command: () => emit('replace'),
      }),
      ... encryption_items(row_locked.value),
      // 创建删减版 is a single-file action, and its twin reuses the plaintext
      // name, which is exactly the condition a decrypt would also need.
      action_item({
        label: '创建删减版',
        reasons: abridged_blocked_reasons.value,
        icon_name: 'lucide:highlighter',
        disabled: row_locked.value,
        command: () => emit('create-abridged'),
      }),
    )
    items.push({ separator: true }, delete_item('file'))
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

/** Opens an encrypted attachment: media in a tab, anything else saved under its name. */
async function open_decrypted(file: ContentStoryAttachment) {
  if (is_decrypting.value) {
    toast_info('解密中，请稍候')
    return
  }
  try {
    await open_decrypted_attachment(static_url(file.url), file)
  }
  catch {
    toast_error('加密附件解密失败')
  }
}

/** Saves an encrypted attachment's plaintext even when it is viewable media. */
async function download_decrypted(file: ContentStoryAttachment) {
  if (is_decrypting.value) {
    toast_info('解密中，请稍候')
    return
  }
  try {
    await save_decrypted_attachment(static_url(file.url), file)
  }
  catch {
    toast_error('加密附件解密失败')
  }
}

/** One in-flight signature at a time; a second click just waits for the first. */
let download_signing = false

/** Signs the object GET on demand, then saves it under its row name (see sign_attachment_download). */
async function download_signed(file: ContentStoryAttachment) {
  if (download_signing) {
    toast_info('下载准备中，请稍候')
    return
  }
  download_signing = true
  try {
    const { url } = await api.content.sign_attachment_download(props.story_id, file.file_name)
    save_url_as(url)
  }
  catch {
    toast_error('附件下载失败')
  }
  finally {
    download_signing = false
  }
}

function open_file() {
  const file = stored.value
  if (! file || denied_access.value)
    return
  if (file.is_encrypted && file.encryption_key) {
    void open_decrypted(file)
    return
  }
  // Media opens inline in a tab; everything else saves under its row name,
  // since the object URL itself carries no file name to save it under.
  if (attachment_is_media(file)) {
    window.open(static_url(file.url), '_blank', 'noopener,noreferrer')
    return
  }
  void download_signed(file)
}

/**
 * The leading file menu entries: images preview, other media open in a tab, and
 * every file gets a named download. An encrypted row has no usable object URL —
 * its bytes are ciphertext — so both actions go through the client-side decrypt.
 */
function open_download_items(file: ContentStoryAttachment): AttachmentMenuItem[] {
  const encrypted = Boolean(file.is_encrypted && file.encryption_key)
  const leading = attachment_leading_action(file)
  return [
    ... (leading === 'preview'
      ? [{ label: '预览', icon_name: 'lucide:eye', command: () => void preview_file(file) } satisfies AttachmentMenuItem]
      : leading === 'open'
        ? [{ label: '打开', icon_name: 'lucide:external-link', command: () => void open_file() } satisfies AttachmentMenuItem]
        : []),
    {
      label: '下载',
      icon_name: 'lucide:download',
      command: encrypted ? () => void download_decrypted(file) : () => void download_signed(file),
    },
  ]
}

/** Preview decrypts first when the image is encrypted, so the lightbox never sees ciphertext. */
async function preview_file(file: ContentStoryAttachment) {
  if (! file.is_encrypted || ! file.encryption_key) {
    emit('preview', static_url(file.url))
    return
  }
  if (is_decrypting.value) {
    toast_info('解密中，请稍候')
    return
  }
  try {
    emit('preview', await decrypted_blob_url(static_url(file.url), file.encryption_key, file.mime_type))
  }
  catch {
    toast_error('加密附件解密失败')
  }
}

function on_dblclick() {
  const file = stored.value
  if (! file || denied_access.value)
    return
  if (file.is_image && ! props.readonly)
    void preview_file(file)
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
