<template>
  <div class="flex w-full flex-col">
    <p class="sr-only" role="status">
      {{ model.uploads.preparing ? `校验文件：${model.uploads.preparing.path}` : model.uploads.admitting ? '正在准备上传' : '' }}
    </p>
    <div v-if="model.request_error || model.uploads.admission_error" class="mb-3 flex items-center gap-2 text-sm text-red-600" role="alert">
      <span>{{ model.request_error || model.uploads.admission_error }}</span>
      <Button label="重试" size="small" text @click="model.request_error ? model.submit() : model.uploads.submit()" />
    </div>
    <MyContentAttachmentList
      ref="list"
      class="flex-1"
      :rows="list_rows" :menu_items="row => menu_for(row.source)" :upload_busy="!! model.uploads.preparing || model.uploads.admitting"
      :readonly="model.readonly" :layout="layout" :root_drag_over="drag_parent === model.root_id"
      @files-picked="model.start($event)" @create-folder="new_folder(parent_id($event))"
      @row-click="row_click" @row-contextmenu="row_contextmenu" @toggle-selection="toggle_selection"
      @row-dragstart="(event, row) => drag(event, row.source)" @row-dragend="end_drag"
      @open="model.open($event.source)" @marquee-select="marquee_select"
      @root-dragenter="drag_over" @root-dragover="drag_over" @root-dragleave="drag_leave" @root-drop="root_drop"
    />
    <input ref="replacement" type="file" class="hidden" aria-label="选择替换文件" @change="replaced">
    <input ref="resume_picker" type="file" class="hidden" aria-label="重新选择原文件" @change="resumed">
    <MyDialog v-model:visible="name_visible" :header="name_target ? '重命名' : '新建文件夹'">
      <MyFileNameInput v-model="name" :suffix="name_suffix" aria-label="名称" @keydown.enter="submit_name" />
      <template #footer>
        <Button label="取消" text severity="secondary" @click="name_visible = false" />
        <Button label="确定" :disabled="name_target?.node?.kind === 'file' && ! name.trim()" @click="submit_name">
          <template #icon>
            <MyIcon name="lucide:check" />
          </template>
        </Button>
      </template>
    </MyDialog>
    <MyDialog v-model:visible="delete_visible" :header="deleting_redacted ? '删除删减版' : '删除'">
      <p v-if="deleting_redacted">
        确认删除『{{ delete_rows[0]?.path }}』的删减版？
      </p>
      <p v-else>
        确认删除所选 {{ delete_rows.length }} 项？
      </p>
      <template #footer>
        <Button label="取消" text severity="secondary" @click="delete_visible = false" />
        <Button label="删除" severity="danger" @click="submit_delete">
          <template #icon>
            <MyIcon name="lucide:check" />
          </template>
        </Button>
      </template>
    </MyDialog>
    <MyDialog v-model:visible="replace_visible" header="替换">
      <div
        class="flex flex-col items-center py-8 gap-y-3 rounded-sm border border-dashed p-4 transition-colors"
        :class="replace_drag_depth ? 'border-primary bg-primary/10' : 'border-slate-300 dark:border-slate-700'"
        tabindex="0"
        @dragenter.stop.prevent="replace_drag_enter"
        @dragover.stop.prevent="replace_drag_over"
        @dragleave.stop.prevent="replace_drag_depth = Math.max(0, replace_drag_depth - 1)"
        @drop.stop.prevent="replace_drop"
        @paste.prevent="replace_paste"
      >
        <p class="text-sm text-slate-500">
          可在此拖入或粘贴新文件
        </p>
        <Select v-model="keep_name" :options="[{ label: '保留原名称', value: true }, { label: '使用新文件名', value: false }]" option-label="label" option-value="value" />
      </div>
      <template #footer>
        <Button label="取消" text severity="secondary" @click="replace_visible = false" />
        <Button label="选择新文件" @click="replacement?.click()">
          <template #icon>
            <MyIcon name="lucide:mouse-pointer-2" />
          </template>
        </Button>
      </template>
    </MyDialog>
    <MyDialog v-model:visible="move_visible" header="移动">
      <div v-if="move_visible" class="h-64 max-h-[50dvh] overflow-y-auto" @pointerdown.capture="clear_move_selection">
        <MyContentAttachmentList
          class="min-h-full"
          :rows="move_folder_rows"
          :menu_items="() => []"
          :upload_busy="false"
          :add_controls="false"
          :context_menu="false"
          layout="stack"
          aria-label="目标目录"
          @row-click="(event, row) => row_click(event, row, true)"
          @toggle-selection="row => toggle_selection(row, true)"
          @marquee-select="(keys, additive, phase) => marquee_select(keys, additive, phase, true)"
        />
      </div>
      <template #footer>
        <Button label="取消" text severity="secondary" @click="move_visible = false" />
        <Button label="移动" :disabled="! move_ready" @click="submit_move">
          <template #icon>
            <MyIcon name="lucide:check" />
          </template>
        </Button>
      </template>
    </MyDialog>
    <MyDialog v-model:visible="private_visible" header="修改机密状态">
      <p>确认将 {{ private_rows.length }} 个项目{{ private_value ? '设为机密' : '取消机密' }}？</p>
      <p v-if="private_rows.some(row => row.node?.kind === 'folder')" class="mt-2 text-sm text-slate-500">
        文件夹内的子文件会随目录继承机密状态，独立声明的机密标记会保留。
      </p>
      <template #footer>
        <Button severity="secondary" label="取消" text @click="private_visible = false" />
        <Button label="确认" @click="submit_private">
          <template #icon>
            <MyIcon name="lucide:check" />
          </template>
        </Button>
      </template>
    </MyDialog>
    <MyContentAttachmentImageEditor v-model:visible="image_editor_visible" :attachment="image_editor_row?.node?.attachment ?? null" :redacted="editing_redacted" @save="save_image" />
    <MyContentAttachmentResolve v-if="dialogs" :resolution="model.resolution ?? model.uploads.resolution" :report="model.report ?? model.uploads.report" :admission="! model.report && !! model.uploads.report" :pending="model.resolution ? model.resolution_pending : !! model.uploads.resolution && model.uploads.admitting" :nodes="model.catalog.data?.nodes" @submit="resolve" @close="close_resolve" />
    <ClientOnly v-if="dialogs">
      <MyImagePreview v-model:visible="model.preview_visible" :images="model.preview_images" :initial-index="0" />
    </ClientOnly>
  </div>
</template>

<script setup lang="ts">
import type { ImageSaveMode } from '@shared/content-upload'
import type { ErrorPolicy } from '@shared/content-workspace'
import type { AttachmentMenuItem, MyContentAttachmentRow } from '~/utils/content/attachment-list'
import type { WorkspaceListRow } from '~/utils/content/workspace'
import { attachment_mime_type, decrypted_attachment_name, split_attachment_editable_name } from '@shared/content-markdown'
import { attachment_picks_from_data_transfer } from '~/utils/content/attachment'
import { content_selection_markdown, set_content_attachment_drag_data, set_content_folder_drag_data } from '~/utils/content/attachment-drag'
import { attachment_action_item, attachment_batch_action, attachment_menu_context, attachment_privacy_actions, attachment_selection_edges, guard_attachment_selection, normalize_attachment_selection, select_attachment_row } from '~/utils/content/attachment-list'
import { folder_picker_rows, move_destination_folders } from '~/utils/content/folder-picker'

const props = withDefaults(defineProps<{ controller: Awaited<ReturnType<typeof useAttachmentPanel>>, dialogs?: boolean, layout?: 'stack' | 'columns' }>(), { dialogs: true, layout: 'columns' })
const model = reactive(props.controller)
const drag_parent = ref<number | null>(null)
let marquee_base: Set<string> | null = null
let move_marquee_base: Set<string> | null = null
let move_anchor: string | null = null
const move_visible = ref(false)
const move_selected = ref(new Set<string>())
const move_expanded = ref(new Set<number>())
const move_rows = ref<WorkspaceListRow[]>([])
const move_folders = computed(() => move_destination_folders(model.catalog.data?.nodes ?? [], move_rows.value.map(row => row.node!.id)))
const move_folder_rows = computed(() => folder_picker_rows(move_folders.value, model.root_id, move_expanded.value, move_selected.value))
const move_parent = computed(() => [model.root_id, ... move_folders.value.map(folder => folder.id)].find(id => move_selected.value.has(`node:${id}`)) ?? null)
const move_ready = computed(() => {
  if (move_parent.value === null || (move_parent.value !== model.root_id && ! move_folders.value.some(folder => folder.id === move_parent.value)))
    return false
  const targets = move_rows.value.filter(row => model.capabilities(row).move && row.node!.parent_id !== move_parent.value).map(model.target)
  return targets.length > 0 && model.can_execute({ operation: 'move', targets, parent_id: move_parent.value })
})
const list_rows = computed<MyContentAttachmentRow[]>(() => model.rows.map((row, index) => {
  const cap = model.capabilities(row)
  const file = row.node?.attachment
  const session = row.session
  const message = session ? model.uploads.errors.get(session.id) ?? session.image_error ?? null : null
  const upload = session
    ? {
        status: message || session.image_status === 'failed' ? 'error' as const : model.uploads.queued.has(session.id) ? 'queued' as const : model.uploads.active.has(session.id) || !! session.image_status ? 'uploading' as const : 'paused' as const,
        progress: percent(row), file_size: session.size, message, label: status(row),
      }
    : null
  return {
    key: row.key, depth: row.depth, source: row, upload,
    data: row.node?.kind === 'folder'
      ? { kind: 'folder', path: row.path, name: row.name, collapsed: ! model.expanded.has(row.node.id), count: (model.catalog.data?.nodes ?? []).filter(node => node.path.startsWith(`${row.path}/`)).length, drop_target: drag_parent.value === row.node.id, drop_disabled: false }
      : file
        ? { ... file, kind: 'stored' }
        : { kind: 'upload', file_name: row.path, file_size: session?.size ?? 0, mime_type: attachment_mime_type(row.path) },
    state: { selected: model.selected.has(row.key), selection_edges: attachment_selection_edges(model.rows, index, model.selected), pending: model.command_pending(row), move_pending: model.command_moving(row), draggable: cap.move },
  }
}))
function parent_id(path: string | null) {
  return model.catalog.data?.nodes?.find(node => node.kind === 'folder' && node.path === path)?.id ?? model.root_id
}
function row_click(event: MouseEvent, row: MyContentAttachmentRow, picking = false) {
  if (row.source.node?.kind === 'folder' && ! event.ctrlKey && ! event.metaKey && ! event.shiftKey) {
    if (picking) {
      const next = new Set(move_expanded.value)
      if (next.has(row.source.node.id))
        next.delete(row.source.node.id)
      else
        next.add(row.source.node.id)
      move_expanded.value = next
    }
    else {
      model.toggle_folder(row.source)
    }
    return
  }
  if (picking) {
    move_selected.value = select_attachment_row(move_folder_rows.value.map(item => item.source), move_selected.value, move_anchor, row.source, event, 1)
    move_anchor = row.key
    return
  }
  if (! model.readonly)
    model.select(row.source, event)
}
function toggle_selection(row: MyContentAttachmentRow, picking = false) {
  row_click({ ctrlKey: true, metaKey: false, shiftKey: false } as MouseEvent, row, picking)
}
function row_contextmenu(_event: MouseEvent, row: MyContentAttachmentRow) {
  if (! model.readonly && ! model.selected.has(row.key))
    model.select(row.source, { ctrlKey: false, metaKey: false, shiftKey: false } as MouseEvent)
}
function marquee_select(keys: string[], additive: boolean, phase: 'start' | 'move' | 'end', picking = false) {
  if (phase === 'start') {
    if (picking)
      move_marquee_base = additive ? new Set(move_selected.value) : new Set()
    else
      marquee_base = additive ? new Set(model.selected) : new Set()
  }
  else if (phase === 'end') {
    if (picking)
      move_marquee_base = null
    else
      marquee_base = null
  }
  else {
    const base = picking ? move_marquee_base : marquee_base
    if (! base)
      return
    const next = normalize_attachment_selection(picking ? move_folder_rows.value.map(row => row.source) : model.rows, new Set([... base, ... keys]))
    if (picking)
      move_selected.value = guard_attachment_selection(move_selected.value, next, 1)
    else
      model.selected = next
  }
}
function drag_over(event: DragEvent) {
  if (model.readonly)
    return
  event.preventDefault()
  const path = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-row-key]')?.dataset.folder
  drag_parent.value = parent_id(path ?? null)
}
function drag_leave(event: DragEvent) {
  if (! (event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null))
    drag_parent.value = null
}
function end_drag() {
  drag_parent.value = null
  model.drag_ids = []
}
function root_drop(event: DragEvent) {
  if (model.readonly)
    return
  event.preventDefault()
  event.stopPropagation()
  const path = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-row-key]')?.dataset.folder
  drag_parent.value = null
  void drop(event, parent_id(path ?? null))
}
const { error } = useMyToast()
const list = ref<{ pick_files: (path?: string | null) => void, pick_folder: (path?: string | null) => void }>()
const replacement = ref<HTMLInputElement>()
const resume_picker = ref<HTMLInputElement>()
const name_visible = ref(false)
const name = ref('')
const name_suffix = ref('')
const name_target = ref<WorkspaceListRow | null>(null)
const delete_visible = ref(false)
const delete_rows = ref<WorkspaceListRow[]>([])
const deleting_redacted = ref(false)
const replace_visible = ref(false)
const replace_drag_depth = ref(0)
watch(replace_visible, () => {
  replace_drag_depth.value = 0
})
const replace_row = ref<WorkspaceListRow | null>(null)
const keep_name = ref(true)
const image_editor_visible = ref(false)
const editing_redacted = ref(false)
const image_editor_row = ref<WorkspaceListRow | null>(null)
let destination = 0
let resume_id: string | null = null
const private_visible = ref(false)
const private_rows = ref<WorkspaceListRow[]>([])
const private_value = ref(false)
function submit_move() {
  if (! move_ready.value || move_parent.value === null)
    return
  const targets = move_rows.value.filter(row => row.node!.parent_id !== move_parent.value && model.capabilities(row).move)
  model.selected = new Set(targets.map(row => row.key))
  move_visible.value = false
  void model.execute({ operation: 'move', targets: targets.map(model.target), parent_id: move_parent.value })
}
function clear_move_selection(event: PointerEvent) {
  const target = event.target as HTMLElement | null
  if (! target?.closest('.folder-row') && ! event.ctrlKey && ! event.metaKey) {
    move_selected.value = new Set()
    move_anchor = null
  }
}
function submit_private() {
  private_visible.value = false
  if (private_rows.value.length)
    void model.execute({ operation: 'set_private', targets: private_rows.value.map(model.target), private: private_value.value })
}
function accept_replacement(file?: File) {
  if (file && replace_row.value) {
    void model.replace(replace_row.value, file, keep_name.value)
    replace_visible.value = false
  }
}
function replace_drag_enter(event: DragEvent) {
  if (event.dataTransfer?.types.includes('Files'))
    replace_drag_depth.value ++
}
function replace_drag_over(event: DragEvent) {
  if (event.dataTransfer?.types.includes('Files'))
    replace_drag_depth.value = Math.max(1, replace_drag_depth.value)
}
function replace_drop(event: DragEvent) {
  replace_drag_depth.value = 0
  if (event.dataTransfer?.files.length !== 1)
    return error('替换时请选择一个文件')
  accept_replacement(event.dataTransfer.files[0])
}
function replace_paste(event: ClipboardEvent) {
  if (event.clipboardData?.files.length !== 1)
    return error('替换时请粘贴一个文件')
  accept_replacement(event.clipboardData.files[0])
}
function percent(row: WorkspaceListRow) {
  const session = row.session!
  const loaded = model.uploads.progress.get(session.id)?.loaded ?? session.parts.reduce((sum, part) => sum + part.size, 0)
  return session.size ? Math.min(100, Math.floor(loaded / session.size * 100)) : 0
}
function status(row: WorkspaceListRow) {
  const session = row.session!
  if (session.image_status)
    return session.image_status === 'failed' ? '图片处理失败' : '服务器处理中'
  if (session.status === 'ready')
    return '校验完成，等待发布'
  if (model.uploads.queued.has(session.id))
    return '等待上传'
  if (! model.uploads.active.has(session.id))
    return model.uploads.errors.has(session.id) ? '未完成' : '已暂停'
  const phase = model.uploads.progress.get(session.id)?.phase
  return phase === 'hashing' ? '正在校验原文件' : phase === 'verifying' || phase === 'ready' ? '服务器处理中' : `${percent(row)} %`
}
function pick(parent: number, folder: boolean) {
  const path = prefix(parent) || null
  if (folder)
    list.value?.pick_folder(path)
  else
    list.value?.pick_files(path)
}
function prefix(parent: number) {
  return model.catalog.data?.nodes?.find(node => node.id === parent)?.path ?? ''
}
function new_folder(parent: number) {
  destination = parent
  name_target.value = null
  name.value = ''
  name_suffix.value = ''
  name_visible.value = true
}
function rename(row: WorkspaceListRow) {
  const parts = row.node!.kind === 'file' ? split_attachment_editable_name(decrypted_attachment_name(row.name)) : { editable: row.name, locked: '' }
  name_target.value = row
  name.value = parts.editable
  name_suffix.value = parts.locked
  name_visible.value = true
}
function submit_name() {
  if (name_target.value?.node?.kind === 'file' && ! name.value.trim())
    return
  name_visible.value = false
  void (name_target.value ? model.execute({ operation: 'rename', target: model.target(name_target.value), name: `${name.value}${name_suffix.value}` }) : model.execute({ operation: 'create_folder', parent_id: destination, name: name.value }))
}
function submit_delete() {
  if (! delete_visible.value)
    return
  delete_visible.value = false
  if (deleting_redacted.value) {
    const row = delete_rows.value[0]
    if (row)
      void model.execute({ operation: 'delete_redacted', target: model.target(row) })
    return
  }
  void model.execute({ operation: 'delete', targets: delete_rows.value.map(model.target), draft_references: model.references })
}
function menu_for(row: WorkspaceListRow): AttachmentMenuItem[] {
  const { selected, single } = attachment_menu_context(row, model.selected_rows)
  const cap = model.capabilities(row)
  const blocked = (operation: keyof typeof cap.reasons, targets = [row]) => targets.flatMap(target => model.capabilities(target).reasons[operation])
  const read_entries: AttachmentMenuItem[] = []
  const edit_entries: AttachmentMenuItem[] = []
  const delete_entries: AttachmentMenuItem[] = []
  if (single && row.node) {
    if (row.node.kind === 'file' && row.node.attachment?.is_image) {
      read_entries.push(attachment_action_item({ label: '预览', icon_name: 'lucide:eye', disabled: ! cap.preview, command: () => model.preview(row) }, blocked('preview')))
      if (cap.preview_redacted)
        read_entries.push({ label: '预览删减版', icon_name: 'lucide:eye-off', command: () => model.preview(row, 'redacted_avif') })
    }
    else if (row.node.kind === 'file' && (row.node.attachment?.mime_type?.startsWith('audio/') || row.node.attachment?.mime_type?.startsWith('video/'))) {
      read_entries.push(attachment_action_item({ label: '打开', icon_name: 'lucide:external-link', disabled: ! cap.open, command: () => model.open(row) }, blocked('open')))
    }
    if (row.node.kind === 'file')
      read_entries.push(attachment_action_item({ label: '下载', icon_name: 'lucide:download', disabled: ! cap.download, command: () => void model.download(row) }, blocked('download')))
    if (row.node.attachment?.image?.has_original && cap.download)
      read_entries.push({ label: '下载原图', icon_name: 'lucide:download', command: () => void model.download(row, 'original') })
    if (row.node.attachment?.has_redacted)
      read_entries.push({ label: '下载删减版', icon_name: 'lucide:download', command: () => void model.download(row, 'redacted_avif') })
  }
  if (! model.readonly) {
    if (selected.every(item => item.node))
      read_entries.push({ label: '复制', icon_name: 'lucide:copy', command: () => void navigator.clipboard.writeText(content_selection_markdown(selected)) })
    if (single && row.session) {
      const session = row.session
      const running = model.uploads.active.has(session.id) || model.uploads.queued.has(session.id)
      edit_entries.push({ label: session.image_status ? session.image_status === 'failed' ? '重试' : '图片处理中' : running ? '暂停' : session.status === 'ready' ? '发布' : '继续', disabled: !! session.image_status && session.image_status !== 'failed', icon_name: running ? 'lucide:pause' : 'lucide:play', command: () => {
        if (model.uploads.active.has(session.id) || model.uploads.queued.has(session.id)) {
          model.uploads.pause(session.id)
        }
        else {
          void model.uploads.resume(session.id).then((started) => {
            if (! started) {
              resume_id = session.id
              resume_picker.value?.click()
            }
          }).catch(ex => error(ex.message))
        }
      } })
      delete_entries.push({ label: '取消', icon_name: 'lucide:x', class: 'attachment-menu-danger', command: () => void model.uploads.cancel(session.id).catch(ex => error(ex.message)) })
    }
    if (! single && selected.every(item => item.session)) {
      const sessions = selected.flatMap(item => item.session ? [item.session] : [])
      const running = sessions.filter(session => model.uploads.active.has(session.id) || model.uploads.queued.has(session.id))
      const resumable = sessions.filter(session => ! running.includes(session) && (! session.image_status || session.image_status === 'failed'))
      if (running.length)
        edit_entries.push({ label: '暂停', icon_name: 'lucide:pause', command: () => running.forEach(session => model.uploads.pause(session.id)) })
      if (resumable.length) {
        edit_entries.push({ label: '继续', icon_name: 'lucide:play', command: async () => {
          for (const session of resumable) {
            try {
              if (! await model.uploads.resume(session.id)) {
                resume_id = session.id
                resume_picker.value?.click()
                break
              }
            }
            catch (ex) {
              error(ex instanceof Error ? ex.message : String(ex))
            }
          }
        } })
      }
      delete_entries.push({ label: '取消', icon_name: 'lucide:x', class: 'attachment-menu-danger', command: async () => {
        for (const session of sessions)
          await model.uploads.cancel(session.id).catch(ex => error(ex.message))
      } })
    }
    if (single && row.node) {
      edit_entries.push(attachment_action_item({ label: '重命名', icon_name: 'lucide:pencil', disabled: ! cap.rename, command: () => rename(row) }, blocked('rename')))
      if (row.node.kind === 'folder') {
        edit_entries.push({ label: '上传', icon_name: 'lucide:paperclip', command: () => pick(row.node!.id, false) }, { label: '上传文件夹', icon_name: 'lucide:paperclip', command: () => pick(row.node!.id, true) }, { label: '新建文件夹', icon_name: 'lucide:folder-plus', command: () => new_folder(row.node!.id) })
      }
      else {
        edit_entries.push(attachment_action_item({ label: '替换', icon_name: 'lucide:refresh-cw', disabled: ! cap.replace, command: () => {
          replace_row.value = row
          keep_name.value = true
          replace_visible.value = true
        } }, blocked('replace')))
        if (row.node.attachment?.is_image) {
          edit_entries.push(attachment_action_item({ label: '编辑', icon_name: 'lucide:crop', disabled: ! cap.image_edit, command: () => {
            editing_redacted.value = false
            image_editor_row.value = row
            image_editor_visible.value = true
          } }, blocked('image_edit')))
          if (row.node.attachment.is_private) {
            edit_entries.push(attachment_action_item({ label: '编辑删减版', icon_name: 'lucide:crop', disabled: ! cap.image_edit, command: () => {
              editing_redacted.value = true
              image_editor_row.value = row
              image_editor_visible.value = true
            } }, blocked('image_edit')))
          }
          if (row.node.attachment.has_redacted) {
            delete_entries.push(attachment_action_item({ label: '删除删减版', icon_name: 'lucide:trash-2', class: 'attachment-menu-danger', disabled: ! cap.private, command: () => {
              deleting_redacted.value = true
              delete_rows.value = [row]
              delete_visible.value = true
            } }, blocked('private')))
          }
        }
      }
    }
    if (selected.every(item => item.node)) {
      for (const action of attachment_privacy_actions(selected, model.capabilities)) {
        edit_entries.push(attachment_action_item({ label: action.private ? '设为机密' : '取消机密', icon_name: action.private ? 'lucide:lock' : 'lucide:lock-open', disabled: action.disabled, command: () => {
          model.selected = new Set(action.targets.map(row => row.key))
          private_rows.value = [... action.targets]
          private_value.value = action.private
          private_visible.value = true
        } }, action.reasons))
      }
      const delete_action = attachment_batch_action(selected, (item) => {
        const cap = model.capabilities(item)
        return { allowed: cap.delete, reasons: cap.reasons.delete }
      })
      const move_action = attachment_batch_action(selected, (item) => {
        const cap = model.capabilities(item)
        return { allowed: cap.move, reasons: cap.reasons.move }
      })
      delete_entries.push(attachment_action_item({ label: '删除', icon_name: 'lucide:trash-2', class: 'attachment-menu-danger', disabled: delete_action.disabled, command: () => {
        model.selected = new Set(delete_action.targets.map(row => row.key))
        deleting_redacted.value = false
        delete_rows.value = [... delete_action.targets]
        delete_visible.value = true
      } }, delete_action.reasons))
      edit_entries.push(attachment_action_item({ label: '移动', icon_name: 'lucide:folder-input', disabled: move_action.disabled, command: () => {
        model.selected = new Set(move_action.targets.map(row => row.key))
        move_rows.value = [... move_action.targets]
        move_selected.value = new Set()
        move_expanded.value = new Set([model.root_id])
        move_anchor = null
        move_visible.value = true
      } }, move_action.reasons))
    }
  }
  return [read_entries, edit_entries, delete_entries].filter(group => group.length).flatMap((group, index) => index ? [{ separator: true }, ... group] : group)
}
function replaced(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file && replace_row.value)
    void model.replace(replace_row.value, file, keep_name.value)
  input.value = ''
  replace_visible.value = false
}
function resumed(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files?.[0] && resume_id)
    void model.uploads.resume(resume_id, input.files[0]).catch(ex => error(ex.message))
  input.value = ''
}
function save_image(file: File, mode: ImageSaveMode, name: string, basis: 'avif' | 'original') {
  image_editor_visible.value = false
  if (image_editor_row.value)
    void model.edit_image(image_editor_row.value, file, mode, name, basis)
}
function resolve(policy: ErrorPolicy) {
  void (model.resolution ? model.submit(policy) : model.uploads.submit(policy))
}
function close_resolve() {
  if (model.resolution)
    model.dismiss_resolution()
  else if (model.uploads.resolution)
    model.uploads.dismiss_resolution()
  else if (model.report)
    model.report = null
  else
    model.uploads.report = null
}
function drag(event: DragEvent, row: WorkspaceListRow) {
  if (! model.selected.has(row.key))
    model.selected = new Set([row.key])
  model.drag_ids = model.selected_rows.filter(item => item.node && model.capabilities(item).move).map(item => item.node!.id)
  const names = model.selected_rows.filter(item => item.node).map(item => item.path)
  const markdown = content_selection_markdown(model.selected_rows)
  if (row.node?.kind === 'folder')
    set_content_folder_drag_data(event, row.path, names, markdown)
  else if (row.node?.attachment)
    set_content_attachment_drag_data(event, { ... row.node.attachment, file_names: names, markdown })
}
async function drop(event: DragEvent, parent: number) {
  if (model.readonly)
    return
  if (model.drag_ids.length) {
    const nodes = model.catalog.data?.nodes ?? []
    const destination_path = prefix(parent)
    const targets = model.drag_ids.map(id => nodes.find(node => node.id === id)!).filter(node => node && node.parent_id !== parent && node.id !== parent && ! (node.kind === 'folder' && destination_path.startsWith(`${node.path}/`))).map(node => ({ id: node.id, version: node.version }))
    model.selected = new Set(model.selected_rows.filter(row => targets.some(target => target.id === row.node?.id)).map(row => row.key))
    model.drag_ids = []
    if (targets.length)
      await model.execute({ operation: 'move', targets, parent_id: parent })
  }
  else if (event.dataTransfer) {
    const path = prefix(parent)
    const picks = await attachment_picks_from_data_transfer(event.dataTransfer)
    await model.start(picks.map(pick => ({ ... pick, selection_root: pick.selection_root ? `${path ? `${path}/` : ''}${pick.selection_root}` : undefined, file_name: `${path ? `${path}/` : ''}${pick.file_name}` })))
  }
}
</script>
