<template>
  <div class="space-y-12 pb-12 pt-8">
    <div v-if="! is_edit || story">
      <MyContentStoryHeader back :invalid="! header_meta" :title="header_title" :labels="header_labels" :desc="header_desc" :cover="header_cover" :cover-label="header_cover_label" :cover-url="header_cover_url" :date="header_date" :story-id="is_edit ? story_id : null">
        <template #actions>
          <Button
            v-if="is_edit"
            severity="danger"
            text
            size="small"
            label="删除"
            :loading="delete_pending"
            @click="confirm_delete_story"
          >
            <template #icon>
              <MyIcon name="lucide:trash-2" />
            </template>
          </Button>
          <Button
            :label="is_edit ? '保存' : '创建'"
            size="small"
            :loading="save_pending"
            :disabled="save_pending"
            @click="on_save_click"
          >
            <template #icon>
              <MyIcon :name="is_edit ? 'lucide:save' : 'lucide:check'" />
            </template>
          </Button>
        </template>
      </MyContentStoryHeader>

      <MyHeightSection tag="section" class="section-card-collapse mt-6">
        <MyContentMarkdownEditor
          ref="markdown_editor"
          v-model="markdown"
          :story-id="is_edit ? story!.id : null"
          :attachments="stored_attachments"
          :stories="existing_stories ?? []"
          :folders="folder_names"
          @files-dropped="on_editor_files_dropped"
          @attachment-drop-outside="on_attachment_drop_outside"
        >
          <template #toolbar-start>
            <div
              class="flex text-xs items-center gap-1"
              :class="draft_storage_error ? 'text-red-500 dark:text-red-400' : 'text-slate-500 dark:text-slate-400'"
            >
              <MyIcon
                :name="save_pending ? 'lucide:loader-circle' : draft_storage_error ? 'lucide:circle-alert' : 'lucide:cloud-check'"
                class="mr-1 align-text-bottom"
                :class="{ 'animate-spin': save_pending }"
              />
              <span>{{ draft_status_label }}</span>
              <Button
                v-if="draft_dirty && ! save_pending"
                label="舍弃草稿"
                size="small"
                text
                severity="danger"
                class="!px-1.5 !py-1 !text-xs"
                :loading="discard_draft_pending"
                :disabled="discard_draft_pending"
                @click="confirm_abandon_draft"
              />
            </div>
          </template>
          <template #attachments>
            <MyContentAttachmentList
              v-bind="file_list_props"
              layout="stack"
              class="h-full"
              v-on="file_list_handlers"
            />
          </template>
        </MyContentMarkdownEditor>
      </MyHeightSection>

      <MyDivider v-show="markdown_editor?.editor_mode !== 'preview'" class="mt-12">
        附件
      </MyDivider>

      <MyHeightSection
        v-show="markdown_editor?.editor_mode !== 'preview'"
        tag="section"
        class="section-card-collapse transition-colors mt-6"
        @dragover.prevent="attachment_drag_over = true"
        @dragleave.prevent="attachment_drag_over = false"
        @drop.prevent="on_attachment_drop"
      >
        <MyContentAttachmentList
          v-bind="file_list_props"
          v-on="file_list_handlers"
        />
      </MyHeightSection>
    </div>

    <div v-else class="section-card-collapse py-12 text-center text-slate-500 dark:text-slate-400">
      档案不存在或已被删除
    </div>

    <MyDialog
      v-model:visible="draft_conflict_visible"
      header="版本冲突"
    >
      <div class="space-y-3 text-sm text-slate-600 dark:text-slate-300">
        <p>这份自动保存的草稿基于较旧的数据库版本，继续编辑可能覆盖其他人已保存的修改！</p>
        <p v-if="pending_conflict_draft" class="text-xs text-slate-500 dark:text-slate-400">
          （本地草稿保存于 {{ datetime_format(pending_conflict_draft.saved_at) }}）
        </p>
      </div>

      <template #footer>
        <div class="flex flex-wrap justify-end gap-2">
          <Button label="取消" severity="secondary" text @click="draft_conflict_visible = false" />
          <Button label="使用数据库最新版" severity="secondary" text @click="use_database_version" />
          <Button label="继续使用本地草稿" severity="warn" @click="restore_conflicting_draft">
            <template #icon>
              <MyIcon name="lucide:git-branch" />
            </template>
          </Button>
        </div>
      </template>
    </MyDialog>

    <MyDialog
      v-if="is_edit"
      v-model:visible="rename_visible"
      header="重命名附件"
      :pending="rename_pending"
      :closable="! rename_pending"
    >
      <Form id="rename-attachment-form" class="space-y-2" @submit="rename_attachment">
        <label for="rename-attachment-name" class="block text-sm font-medium">文件名（不含扩展名）</label>
        <MyFilteredInput
          id="rename-attachment-name"
          v-model="rename_file_name"
          :filter="link_file_name_illegal_chars"
          fluid
          :maxlength="120 - attachment_extension(rename_target?.file_name ?? '').length"
          autofocus
          :disabled="rename_pending"
        />
      </Form>

      <template #footer>
        <div class="flex justify-end gap-2">
          <Button label="取消" severity="secondary" text :disabled="rename_pending" @click="rename_visible = false" />
          <Button label="重命名" type="submit" form="rename-attachment-form" :loading="rename_pending" :disabled="! rename_file_name.trim() || rename_pending">
            <template #icon>
              <MyIcon name="lucide:pencil" />
            </template>
          </Button>
        </div>
      </template>
    </MyDialog>

    <MyDialog
      v-model:visible="folder_visible"
      header="新建文件夹"
      :pending="folder_pending"
      :closable="! folder_pending"
    >
      <Form id="create-folder-form" class="space-y-2" @submit="create_folder">
        <label for="create-folder-name" class="block text-sm font-medium">
          文件夹名称
          <span v-if="folder_parent" class="text-slate-400 dark:text-slate-500">（位于 {{ folder_parent }}）</span>
        </label>
        <MyFilteredInput
          id="create-folder-name"
          v-model="folder_name"
          :filter="link_file_name_illegal_chars"
          fluid
          :maxlength="60"
          autofocus
          :disabled="folder_pending"
        />
      </Form>

      <template #footer>
        <div class="flex justify-end gap-2">
          <Button label="取消" severity="secondary" text :disabled="folder_pending" @click="folder_visible = false" />
          <Button label="创建" type="submit" form="create-folder-form" :loading="folder_pending" :disabled="! folder_name.trim() || folder_pending">
            <template #icon>
              <MyIcon name="lucide:folder-plus" />
            </template>
          </Button>
        </div>
      </template>
    </MyDialog>

    <MyDialog
      v-model:visible="rename_folder_visible"
      header="重命名文件夹"
      :closable="! move_attachment_pending"
    >
      <Form id="rename-folder-form" class="space-y-2" @submit="rename_folder">
        <label for="rename-folder-name" class="block text-sm font-medium">文件夹名称</label>
        <MyFilteredInput
          id="rename-folder-name"
          v-model="rename_folder_name"
          :filter="link_file_name_illegal_chars"
          fluid
          :maxlength="60"
          autofocus
          :disabled="!! move_attachment_pending"
        />
      </Form>

      <template #footer>
        <div class="flex justify-end gap-2">
          <Button label="取消" severity="secondary" text :disabled="!! move_attachment_pending" @click="rename_folder_visible = false" />
          <Button label="重命名" type="submit" form="rename-folder-form" :loading="!! move_attachment_pending" :disabled="! rename_folder_name.trim() || rename_folder_name.trim() === attachment_base_name(rename_folder_target ?? '') || !! move_attachment_pending">
            <template #icon>
              <MyIcon name="lucide:pencil" />
            </template>
          </Button>
        </div>
      </template>
    </MyDialog>

    <MyDialog
      v-if="is_edit"
      v-model:visible="replace_visible"
      header="替换附件"
      :pending="replace_pending !== null"
      :closable="replace_pending === null"
    >
      <div
        class="flex flex-col items-center space-y-3 rounded-sm border border-dashed border-slate-300 p-3 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300"
        :class="{ 'border-brand-400 dark:border-brand-600': replace_drag_over }"
        @dragover.prevent="replace_drag_over = true"
        @dragleave.prevent="replace_drag_over = false"
        @drop.prevent="on_replace_drop"
      >
        <p class="font-bold">
          将『{{ replace_target?.file_name }}』替换为新文件
        </p>
        <p>可直接拖入或粘贴图片 / 文件</p>
        <p>
          <SelectButton
            v-model="replace_name_mode"
            :options="replace_name_modes"
            option-label="label"
            option-value="value"
            :allow-empty="false"
            :disabled="replace_pending !== null"
            size="small"
          />
        </p>
        <input
          ref="replace_file_input"
          type="file"
          class="hidden"
          :disabled="replace_pending !== null"
          @change="on_replace_file_picked"
        >
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <Button label="取消" severity="secondary" text :disabled="replace_pending !== null" @click="close_replace_dialog" />
          <Button
            label="选择新文件"
            severity="warn"
            :loading="replace_pending !== null"
            :disabled="replace_pending !== null"
            @click="replace_file_input?.click()"
          >
            <template #icon>
              <MyIcon name="lucide:file-input" />
            </template>
          </Button>
        </div>
      </template>
    </MyDialog>

    <ClientOnly>
      <MyImagePreview
        v-model:visible="preview_visible"
        :images="preview_images"
        :initial-index="0"
      />
    </ClientOnly>
  </div>
</template>

<script setup lang="ts">
import type { ContentStoryMeta } from '@shared/content-markdown'
import type { ContentAttachmentScope, ContentStoryAttachment, ContentStoryDetail, ContentStorySummary } from '@shared/types/content'
import type { AwsBody } from '@uppy/aws-s3'
import type { Uppy, UppyFile } from '@uppy/core'
import type MyContentMarkdownEditor from '~/components/MyContent/Markdown/Editor.vue'
import type { ContentDraftRecord } from '~/stores/contentDraft'
import type { AttachmentListItem, AttachmentUploadPick, MyContentAttachmentRow, PendingAttachmentUpload } from '~/utils/content/attachment'
import { attachment_ancestor_folders, attachment_base_name, attachment_folder_of, attachment_path_join, compare_attachment_names, extract_attachment_names, link_file_name_illegal_chars, parse_story_markdown, rename_attachment_references, story_markdown_template } from '@shared/content-markdown'
import { sync_resource } from '@shared/types/sync'
import AwsS3 from '@uppy/aws-s3'
import UppyCore from '@uppy/core'
import GoldenRetriever from '@uppy/golden-retriever'
import { storeToRefs } from 'pinia'
import { useContentDraftStore } from '~/stores/contentDraft'
import { attachment_picks_from_data_transfer } from '~/utils/content/attachment'
import { content_attachment_drag_file_names, content_attachment_drag_type, content_attachment_markdown, content_folder_drag_type, content_folder_markdown, get_content_attachment_drag_data, get_content_folder_drag_data, set_content_attachment_drag_data, set_content_folder_drag_data } from '~/utils/content/attachment-drag'
import { format_event_range } from '~/utils/content/event'
import { delete_upload_file_handle, load_upload_file_handle, save_upload_file_handle } from '~/utils/content/upload-file-handle'

definePageMeta({
  middleware: 'require-admin-auth',
  // Remount per story id: setup (story fetch, draft-store init/restore, sync
  // subscriptions) assumes a fresh instance — a reused one would carry the
  // previous story's draft into the create page (and vice versa).
  key: route => route.path,
})

const route = useRoute()
const { content } = useApi()
const { ok, error } = useMyToast()
const { confirm_require } = useMyConfirm()
const config = useRuntimeConfig().public
const upload_handle_db_name = config.content_upload_handle_storage_name
// Known stories for `@story` completion, duplicate-title and dead-reference
// lints; kept in sync via the shared content_stories resource without touching
// the editing content.
const existing_stories = useState<ContentStorySummary[] | null>('content_stories', () => null)
const existing_stories_loading = useState('content_stories_loading', () => false)
await useSyncedData<ContentStorySummary[]>(
  computed(() => sync_resource('content_stories', 'all')),
  () => content.list_stories(),
  existing_stories,
  existing_stories_loading,
)
const draft_store = useContentDraftStore()
const {
  markdown,
  base_revision,
  draft_saved_at,
  autosave_pending: draft_autosave_pending,
  storage_error: draft_storage_error,
  dirty: draft_dirty,
} = storeToRefs(draft_store)

const raw_id = computed(() => route.params.id as string)
const is_edit = computed(() => raw_id.value !== 'new')
const story_id = computed(() => is_edit.value ? Number(raw_id.value) : 0)

const story = useState<ContentStoryDetail | null>('content_story_detail', () => null)

// Existing titles must reach the save/header validation too, or every `@ref`
// is flagged as dead (undefined existing_titles → `! undefined?.some()` is true).
const content_markdown_config = computed(() => ({
  title_max_length: config.content_story_title_max_length,
  label_max_bytes: config.content_story_label_max_bytes,
  desc_max_bytes: config.content_story_desc_max_bytes,
  cover_max_bytes: config.content_story_cover_max_bytes,
  markdown_max_bytes: config.content_story_markdown_max_bytes,
  existing_titles: (existing_stories.value ?? [])
    .filter(story => story.id !== story_id.value)
    .map(story => ({ id: story.id, title: story.title })),
}))

const page_meta = computed(() => parse_story_markdown(markdown.value, content_markdown_config.value).meta)

// The header keeps the last valid front-matter status: a transient lint error
// nulls the current parse, and without this fallback the header would collapse
// blank mid-edit instead of staying on the last legal title/labels/date.
// `immediate` snapshots the initial valid state (e.g. the SSR/hydrated one)
// before any edit or draft restore can null it.
const last_valid_meta = ref<ContentStoryMeta | null>(null)
watch(page_meta, (meta) => {
  if (meta) {
    last_valid_meta.value = meta
  }
}, { immediate: true })
const header_meta = computed(() => page_meta.value ?? last_valid_meta.value)
const header_title = computed(() => header_meta.value?.title ?? '')

useHead({
  title: computed(() => header_title.value ? `蠢猪档案 - 编辑 - ${header_title.value}` : undefined),
})

useSeoMeta({ robots: 'noindex, nofollow' })
const header_labels = computed(() => header_meta.value?.labels ?? [])
const header_desc = computed(() => header_meta.value?.desc ?? null)
const header_cover = computed(() => header_meta.value?.cover ?? null)
const header_cover_label = computed(() => header_meta.value?.cover_label ?? null)
const header_date = computed(() => {
  const meta = header_meta.value
  return meta ? format_event_range(meta.event_precision, meta.event_entries) : null
})

const save_pending = ref(false)
const delete_pending = ref(false)
const rename_visible = ref(false)
const rename_pending = ref(false)
const rename_target = ref<ContentStoryAttachment | null>(null)
const rename_file_name = ref('')
const replace_visible = ref(false)
const replace_target = ref<ContentStoryAttachment | null>(null)
const replace_file = ref<File | null>(null)
const replace_file_input = ref<HTMLInputElement>()
const replace_drag_over = ref(false)
const replace_name_mode = ref<'keep-name' | 'new-name'>('keep-name')
const replace_name_modes = [
  { label: '保留旧文件名', value: 'keep-name' },
  { label: '使用新文件名', value: 'new-name' },
]
const replace_pending = ref<ContentStoryAttachment | null>(null)
const replace_progress = ref<{ progress: number, speed: number } | null>(null)
/** File names with an in-flight delete; a batch marks every member, not just one. */
const delete_attachment_pending = reactive(new Set<string>())
const move_attachment_pending = ref<{
  names: string[]
  target: string | null
  moves: { file_name: string, target_folder: string | null }[]
  source_folder?: string
  new_folder?: string
} | null>(null)
const attachment_drag_over = ref(false)
const folder_visible = ref(false)
const folder_pending = ref(false)
const folder_name = ref('')
const folder_parent = ref<string | null>(null)
const rename_folder_visible = ref(false)
const rename_folder_target = ref<string | null>(null)
const rename_folder_name = ref('')
const delete_folder_pending = reactive(new Set<string>())
const markdown_editor = ref<InstanceType<typeof MyContentMarkdownEditor>>()
const pending_uploads = ref<PendingAttachmentUpload[]>([])
const upload_busy = ref(false)
const draft_conflict_visible = ref(false)
const pending_conflict_draft = ref<ContentDraftRecord | null>(null)
const discard_draft_pending = ref(false)
let next_upload_id = 1

const upload_scope = computed(() => is_edit.value ? String(story_id.value) : 'new')
const live_upload_ids = new Set<string>()
// Last bytes/timestamp sample per file for the live transfer rate.
const upload_speed_marks = new Map<string, { loaded: number, stamp: number }>()

interface UploadMeta extends Record<string, unknown> {
  file_name: string
  insert_position: number | null
  local_upload_id: number
}

let uppy: Uppy<UploadMeta, AwsBody> | null = null

const preview_visible = ref(false)
const preview_images = ref<string[]>([])

const draft_status_label = computed(() => {
  if (save_pending.value)
    return is_edit.value ? '正在保存到服务器...' : '正在创建档案...'
  if (draft_storage_error.value)
    return '草稿保存失败'
  if (draft_autosave_pending.value)
    return '正在保存草稿...'
  if (draft_dirty.value && draft_saved_at.value)
    return '草稿已保存'
  if (draft_dirty.value)
    return '草稿待保存'
  return ''
})

const referenced_files = computed(() => {
  if (is_edit.value && ! story.value)
    return []
  return extract_attachment_names(markdown.value)
})

/** Attachments uploaded from the new-story editor (story_id NULL until create). */
const new_attachment_scope = useState<ContentAttachmentScope | null>('content_orphan_attachments', () => null)
const new_attachments_loading = useState('content_orphan_attachments_loading', () => false)
const stored_attachments = computed(() => story.value?.attachments ?? new_attachment_scope.value?.attachments ?? [])
/** Explicitly created folders (server rows); folders implied by file paths are derived in `folder_names`. */
const attachment_folders = computed(() => story.value?.folders ?? new_attachment_scope.value?.folders ?? [])

// Live-derive from the attachment list (the cover may change before any save);
// the local-path rule mirrors story_front_cover_url, including subfolder paths.
const header_cover_url = computed(() => {
  const cover = header_cover.value
  return cover && ! cover.startsWith('#') && ! /^[a-z][\w+.-]*:/i.test(cover) && cover.split('/').every(Boolean)
    ? (stored_attachments.value.find(item => item.file_name === cover)?.url ?? null)
    : null
})

const attachment_items = computed<AttachmentListItem[]>(() => {
  const items: AttachmentListItem[] = []
  const referenced = new Set(referenced_files.value)
  for (const attachment of stored_attachments.value) {
    const pending_move = move_attachment_pending.value
    const move = pending_move?.moves.find(item => item.file_name === attachment.file_name)
    const move_source_file_name = move
      ? attachment.file_name
      : undefined
    // Rebuild the displayed tree from the exact submitted move map while the
    // request is pending; the server response remains the source of truth.
    const file_name = move
      ? attachment_path_join(move.target_folder, attachment_base_name(attachment.file_name))
      : attachment.file_name
    const displayed_attachment = file_name === attachment.file_name
      ? attachment
      : { ... attachment, file_name }
    items.push({
      key: `stored:${attachment.file_name}`,
      kind: 'stored',
      attachment: displayed_attachment,
      move_source_file_name,
      card: {
        ... displayed_attachment,
        kind: 'stored',
        referenced: referenced.has(attachment.file_name),
        ... (replace_pending.value?.file_name === attachment.file_name && replace_progress.value
          ? { replacing: replace_progress.value }
          : {}),
      },
    })
  }
  for (const task of pending_uploads.value) {
    items.push({
      key: `upload:${task.id}`,
      kind: 'upload',
      task,
      card: {
        kind: 'upload',
        file_name: task.file_name,
        mime_type: task.mime_type,
        file_size: task.file_size,
        status: task.status,
        progress: task.progress,
        speed: task.speed,
        message: task.message,
        can_resume: Boolean(task.file || task.handle),
      },
    })
  }
  // Re-sort because pending uploads are merged in above; the server only orders
  // the stored rows it knows about. Both sides share the comparator so an
  // upload lands where its final position will be.
  return items.sort((a, b) => compare_attachment_names(a.card.file_name, b.card.file_name))
})

/** The storage path of any item (stored or pending upload), so uploads nest under their folders too. */
function item_file_name(item: AttachmentListItem) {
  return item.kind === 'stored' ? item.attachment.file_name : item.task.file_name
}

function item_folder(item: AttachmentListItem) {
  return attachment_folder_of(item_file_name(item))
}

// The union of persisted folder paths and every ancestor prefix implied by
// file paths, for both stored files and pending uploads.
const folder_names = computed(() => {
  const names = new Set(attachment_folders.value)
  for (const item of attachment_items.value) {
    let folder = item_folder(item)
    while (folder) {
      names.add(folder)
      folder = attachment_folder_of(folder)
    }
  }
  return [... names].sort(compare_attachment_names)
})

const grouped_items = computed(() => {
  const groups = new Map<string | null, AttachmentListItem[]>()
  for (const item of attachment_items.value) {
    const folder = item_folder(item)
    const key = folder && folder_names.value.includes(folder) ? folder : null
    const group = groups.get(key)
    if (group)
      group.push(item)
    else
      groups.set(key, [item])
  }
  return groups
})

/** Files (stored or pending uploads) anywhere under a folder path (recursive). */
function folder_count(folder: string) {
  return attachment_items.value.filter(item => item_file_name(item).startsWith(`${folder}/`)).length
}

// Folders start collapsed; the set tracks only the ones the user expanded.
const expanded_folders = ref(new Set<string>())

function toggle_folder(folder: string) {
  const next = new Set(expanded_folders.value)
  if (next.has(folder))
    next.delete(folder)
  else
    next.add(folder)
  expanded_folders.value = next
}

/** Expand a folder and its ancestors so items moved/uploaded into it stay visible. */
function expand_folder(folder: string | null) {
  if (! folder)
    return
  const paths = [folder, ... attachment_ancestor_folders(folder)]
  if (paths.every(path => expanded_folders.value.has(path)))
    return
  const next = new Set(expanded_folders.value)
  for (const path of paths)
    next.add(path)
  expanded_folders.value = next
}

// Multi-select over stored files and folders; keys are typed (`file:...` /
// `folder:...`) because a folder path and a file path can collide.
const selection = reactive(new Set<string>())
const selection_anchor = ref<string | null>(null)

function file_selection_key(name: string) {
  return `file:${name}`
}

function folder_selection_key(path: string) {
  return `folder:${path}`
}

function upload_selection_key(id: number) {
  return `upload:${id}`
}

/** The selection key an attachment item participates in (stored → file:, upload → upload:). */
function item_selection_key(item: AttachmentListItem) {
  return item.kind === 'stored' ? file_selection_key(item.attachment.file_name) : item.key
}

/** Drop every selected upload task — uploads never coexist with stored/folder selections. */
function clear_upload_selection() {
  for (const key of [... selection]) {
    if (key.startsWith('upload:'))
      selection.delete(key)
  }
}

/** Drop every selected stored file and folder. */
function clear_stored_selection() {
  for (const key of [... selection]) {
    if (! key.startsWith('upload:'))
      selection.delete(key)
  }
}

const selected_upload_tasks = computed(() => pending_uploads.value.filter(task => selection.has(upload_selection_key(task.id))))

const selected_file_names = computed(() => [... selection]
  .filter(key => key.startsWith('file:'))
  .map(key => key.slice('file:'.length)))

/**
 * The scope's server-side operation lock. The refs above only describe this
 * tab, so a move/rename started in another tab or by another admin is invisible
 * without it — the server publishes its lock with the attachment payload and
 * this folds it into the same disabled row state.
 */
const remote_operation_lock = computed(() => story.value?.operation_lock ?? new_attachment_scope.value?.operation_lock ?? null)
const structure_locked = computed(() => remote_operation_lock.value !== null)

function is_item_moving(item: AttachmentListItem) {
  return item.kind === 'stored' && (move_attachment_pending.value?.names.includes(item.move_source_file_name ?? item.attachment.file_name) ?? false)
}

// While a move batch runs, dim the folders it touches: the dragged items'
// current folders (or the dragged folder itself) and the target folder, each
// with all their ancestors.
const pending_dim_folders = computed(() => {
  const pending = move_attachment_pending.value
  const folders = new Set<string>()
  if (! pending)
    return folders
  const add_with_ancestors = (folder: string | null) => {
    if (! folder)
      return
    folders.add(folder)
    for (const ancestor of attachment_ancestor_folders(folder))
      folders.add(ancestor)
  }
  if (pending.source_folder)
    add_with_ancestors(pending.source_folder)
  for (const name of pending.names)
    add_with_ancestors(attachment_folder_of(name))
  add_with_ancestors(pending.target)
  return folders
})

// Drag between folders: folder rows, card rows (into the card's folder) and
// the list background (root) are drop targets for the attachment drag type.
const drop_folder = ref<string | null>(null)
const dragged_file_names = ref<string[] | null>(null)
const dragged_folder = ref<string | null>(null)
// True while an attachment/folder drag hovers the list background (root target).
const root_drag_over = ref(false)
// dragenter/dragleave fire on every child boundary, so track depth instead of
// relatedTarget (which is always null mid-drag) to know when the drag leaves
// the whole list.
let root_drag_depth = 0

function folder_row_data(path: string) {
  return {
    kind: 'folder',
    path,
    name: attachment_base_name(path),
    collapsed: ! expanded_folders.value.has(path),
    count: folder_count(path),
    drop_target: drop_folder.value === path,
    drop_disabled: is_folder_drop_disabled(path) || is_folder_target_disabled(path) || structure_locked.value,
    moving: move_attachment_pending.value?.target === path || move_attachment_pending.value?.new_folder === path,
    dimmed: pending_dim_folders.value.has(path),
    batch_pending: move_attachment_pending.value !== null || structure_locked.value,
  } as const
}

function file_row_state(item: AttachmentListItem) {
  const selected = selection.has(item_selection_key(item))
  return {
    selected,
    selection_edges: null,
    selection_count: selected ? selection.size : 0,
    delete_pending: item.kind === 'stored' && delete_attachment_pending.has(item.card.file_name),
    delete_disabled: delete_attachment_pending.size > 0 || structure_locked.value,
    rename_disabled: ! is_edit.value,
    replace_disabled: replace_pending.value !== null,
    retry_disabled: upload_busy.value,
    move_pending: is_item_moving(item),
    structure_locked: structure_locked.value,
  } satisfies MyContentAttachmentRow['state']
}

function row_selection_edges(rows: MyContentAttachmentRow[], index: number): MyContentAttachmentRow['state']['selection_edges'] {
  if (! rows[index]!.state.selected)
    return null
  const prev_selected = index > 0 && rows[index - 1]!.state.selected
  const next_selected = index < rows.length - 1 && rows[index + 1]!.state.selected
  if (prev_selected && next_selected)
    return 'none'
  if (prev_selected)
    return 'bottom'
  if (next_selected)
    return 'top'
  return 'both'
}

// Flattened tree: folders first (with their subtrees), then the level's files;
// rows under a collapsed folder are omitted entirely.
const file_rows = computed<MyContentAttachmentRow[]>(() => {
  const rows: MyContentAttachmentRow[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const folder of folder_names.value.filter(name => attachment_folder_of(name) === parent)) {
      rows.push({
        key: folder_selection_key(folder),
        depth,
        data: folder_row_data(folder),
        state: {
          selected: selection.has(folder_selection_key(folder)),
          selection_edges: null,
          selection_count: selection.has(folder_selection_key(folder)) ? selection.size : 0,
          delete_pending: delete_folder_pending.has(folder),
          delete_disabled: delete_attachment_pending.size > 0 || delete_folder_pending.size > 0 || structure_locked.value,
          rename_disabled: structure_locked.value,
          replace_disabled: structure_locked.value,
          retry_disabled: false,
          move_pending: false,
          structure_locked: structure_locked.value,
        },
        item: null,
      })
      if (expanded_folders.value.has(folder))
        walk(folder, depth + 1)
    }
    for (const item of grouped_items.value.get(parent) ?? []) {
      rows.push({
        key: item.key,
        depth,
        data: item.card,
        state: file_row_state(item),
        item,
      })
    }
  }
  walk(null, 0)
  rows.forEach((row, index) => {
    row.state.selection_edges = row_selection_edges(rows, index)
  })
  return rows
})

const file_list_props = computed(() => ({
  rows: file_rows.value,
  upload_busy: upload_busy.value,
  move_to_root: move_attachment_pending.value?.target === null,
  root_drag_over: root_drag_over.value,
}))

const file_list_handlers = {
  'preview': preview_image,
  'copy': on_file_row_copy,
  'rename': on_file_row_rename,
  'replace': on_file_row_replace,
  'delete': on_file_row_delete,
  'retry': on_file_row_retry,
  'pause': on_file_row_pause,
  'cancel': on_file_row_cancel,
  'remove': on_file_row_remove,
  'start-selection': batch_start_selected_uploads,
  'pause-selection': batch_pause_selected_uploads,
  'delete-selection': batch_delete_selected_uploads,
  'files-picked': on_attachment_files_picked,
  'create-folder': on_attachment_create_folder,
  'rename-folder': on_attachment_rename_folder,
  'delete-folder': on_attachment_delete_folder,
  'copy-folder': on_attachment_copy_folder,
  'row-click': on_file_row_click,
  'row-contextmenu': on_file_row_contextmenu,
  'toggle-selection': on_file_row_toggle_selection,
  'marquee-select': on_list_marquee,
  'row-dragstart': on_file_row_dragstart,
  'row-dragend': on_file_row_dragend,
  'root-dragenter': on_file_root_dragenter,
  'root-dragover': on_file_root_dragover,
  'root-dragleave': on_file_root_dragleave,
  'root-drop': on_file_root_drop,
}

function is_folder_drop_disabled(folder: string) {
  const names = dragged_file_names.value
  return names !== null && names.length > 0 && names.every(name => attachment_folder_of(name) === folder)
}

function is_attachment_drag(event: DragEvent) {
  // While a move batch runs, further drops are refused entirely.
  if (move_attachment_pending.value || structure_locked.value)
    return false
  return event.dataTransfer?.types.includes(content_attachment_drag_type) ?? false
}

function is_folder_drag(event: DragEvent) {
  return ! move_attachment_pending.value && ! structure_locked.value && (event.dataTransfer?.types.includes(content_folder_drag_type) ?? false)
}

function is_folder_target_disabled(folder: string, source = dragged_folder.value) {
  return source !== null && (folder === source || folder.startsWith(`${source}/`))
}

function clear_dragged_file_names() {
  dragged_file_names.value = null
  dragged_folder.value = null
  drop_folder.value = null
  root_drag_over.value = false
  root_drag_depth = 0
}

const visible_selectable_keys = computed(() => file_rows.value.flatMap((row) => {
  if (row.data.kind === 'folder')
    return [folder_selection_key(row.data.path)]
  return row.item?.kind === 'stored' ? [file_selection_key(row.item.attachment.file_name)] : []
}))

watch(visible_selectable_keys, (keys) => {
  for (const key of [... selection]) {
    if (! key.startsWith('upload:') && ! keys.includes(key))
      selection.delete(key)
  }
})

const visible_upload_keys = computed(() => file_rows.value
  .filter(row => row.item?.kind === 'upload')
  .flatMap(row => row.item ? [item_selection_key(row.item)] : []))

watch(visible_upload_keys, (keys) => {
  for (const key of [... selection]) {
    if (key.startsWith('upload:') && ! keys.includes(key))
      selection.delete(key)
  }
})

function clear_selection() {
  selection.clear()
  selection_anchor.value = null
}

function select_range(anchor_key: string, target_key: string, additive: boolean) {
  const order = visible_selectable_keys.value
  const from = order.indexOf(anchor_key)
  const to = order.indexOf(target_key)
  if (from < 0 || to < 0)
    return false
  if (! additive)
    selection.clear()
  const range = order.slice(Math.min(from, to), Math.max(from, to) + 1)
  for (const key of range)
    selection.add(key)
  normalize_selection()
  return true
}

/** Shift-range over upload task keys only — uploads never mix with stored/folder selections. */
function select_upload_range(anchor_key: string, target_key: string, additive: boolean) {
  const order = visible_upload_keys.value
  const from = order.indexOf(anchor_key)
  const to = order.indexOf(target_key)
  if (from < 0 || to < 0)
    return false
  if (! additive)
    selection.clear()
  const range = order.slice(Math.min(from, to), Math.max(from, to) + 1)
  for (const key of range)
    selection.add(key)
  return true
}

/** The storage path (file or folder) a selection key refers to. */
function selection_key_path(key: string) {
  return key.slice(key.indexOf(':') + 1)
}

/** Remove any selected ancestor folders of `path` — selecting a descendant cancels its ancestors. */
function remove_ancestor_folder_selection(path: string) {
  for (let folder = attachment_folder_of(path); folder; folder = attachment_folder_of(folder))
    selection.delete(folder_selection_key(folder))
}

/** Enforce the invariant that a selected folder and its descendants never coexist (folder wins). */
function normalize_selection() {
  const selected_folders = [... selection]
    .filter(key => key.startsWith('folder:'))
    .map(key => key.slice('folder:'.length))
  for (const key of [... selection]) {
    if (key.startsWith('folder:')) {
      const path = key.slice('folder:'.length)
      if (selected_folders.some(folder => folder !== path && path.startsWith(`${folder}/`)))
        selection.delete(key)
    }
    else if (selected_folders.some(folder => selection_key_path(key).startsWith(`${folder}/`))) {
      selection.delete(key)
    }
  }
}

// Clicking anywhere off a row — blank space inside or outside the list —
// drops the selection; teleported overlays (menus, dialogs, confirm popups)
// still act on it.
function on_document_pointerdown(event: PointerEvent) {
  if (! selection.size)
    return
  const target = event.target as HTMLElement | null
  if (! target)
    return
  if (target.closest('.file-row, .folder-row, .p-contextmenu, .p-menu, .p-dialog, .p-confirmpopup'))
    return
  clear_selection()
}

function on_card_select(event: MouseEvent, item: AttachmentListItem) {
  if (item.kind !== 'stored')
    return
  const key = file_selection_key(item.attachment.file_name)
  if (event.shiftKey && selection_anchor.value && ! selection_anchor.value.startsWith('upload:')) {
    if (select_range(selection_anchor.value, key, event.ctrlKey || event.metaKey))
      return
  }
  clear_upload_selection()
  if (event.ctrlKey || event.metaKey) {
    if (selection.has(key)) {
      selection.delete(key)
    }
    else {
      remove_ancestor_folder_selection(item.attachment.file_name)
      selection.add(key)
    }
  }
  else {
    selection.clear()
    selection.add(key)
  }
  selection_anchor.value = key
}

/** Selecting upload tasks: ctrl/shift multi-select, mutually exclusive with stored/folder selection. */
function on_upload_card_select(event: MouseEvent, item: AttachmentListItem) {
  if (item.kind !== 'upload')
    return
  const key = item_selection_key(item)
  if (event.shiftKey && selection_anchor.value?.startsWith('upload:')) {
    if (select_upload_range(selection_anchor.value, key, event.ctrlKey || event.metaKey))
      return
  }
  clear_stored_selection()
  if (event.ctrlKey || event.metaKey) {
    if (selection.has(key))
      selection.delete(key)
    else
      selection.add(key)
  }
  else {
    selection.clear()
    selection.add(key)
  }
  selection_anchor.value = key
}

// Right-clicking an unselected card narrows the selection to it (VS Code style).
function on_card_contextmenu(item: AttachmentListItem) {
  if (item.kind !== 'stored')
    return
  const key = file_selection_key(item.attachment.file_name)
  if (! selection.has(key)) {
    selection.clear()
    selection.add(key)
    selection_anchor.value = key
  }
}

function on_folder_click(event: MouseEvent, folder: string) {
  // Selection changes are blocked mid-move (keys would dangle); folding is not.
  const selecting = event.shiftKey || event.ctrlKey || event.metaKey
  if (dragged_file_names.value || (selecting && move_attachment_pending.value))
    return
  const key = folder_selection_key(folder)
  if (event.shiftKey && selection_anchor.value && ! selection_anchor.value.startsWith('upload:')) {
    if (select_range(selection_anchor.value, key, event.ctrlKey || event.metaKey))
      return
  }
  if (event.ctrlKey || event.metaKey) {
    clear_upload_selection()
    if (selection.has(key)) {
      selection.delete(key)
    }
    else {
      remove_ancestor_folder_selection(folder)
      selection.add(key)
      normalize_selection()
    }
    selection_anchor.value = key
    return
  }
  toggle_folder(folder)
}

function on_folder_dragstart(event: DragEvent, folder: string) {
  if (! event.dataTransfer)
    return
  dragged_folder.value = folder
  const file_names = selection.has(folder_selection_key(folder))
    ? selected_file_names.value.filter(name => ! name.startsWith(`${folder}/`))
    : undefined
  set_content_folder_drag_data(event, folder, file_names)
}

function move_dragged_files(event: DragEvent, target_folder: string | null) {
  if (move_attachment_pending.value)
    return false
  const data = get_content_attachment_drag_data(event.dataTransfer)
  if (! data)
    return false
  event.preventDefault()
  event.stopPropagation()
  const names = content_attachment_drag_file_names(data).filter(name => attachment_folder_of(name) !== target_folder)
  if (names.length)
    void on_attachment_move(names, target_folder)
  return true
}

/** The folder a drag-over/drop targets: a folder row is itself, a file row its parent, the background the root. */
function drop_target_folder(event: DragEvent) {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('.folder-row, .file-row')
  return target?.dataset.folder ?? null
}

/**
 * Update the drop highlight for an internal drag. The OS cursor is kept as a
 * constant 'move' for the whole list — toggling dropEffect to 'none' over
 * disabled ancestor/descendant rows made the pointer flicker as rows were
 * crossed. Invalid targets are signalled by the row's own disabled styling and
 * rejected at drop time instead.
 */
function update_drop_state(event: DragEvent) {
  const folder_drag = is_folder_drag(event)
  if (! folder_drag && ! is_attachment_drag(event))
    return false
  event.preventDefault()
  if (event.dataTransfer)
    event.dataTransfer.dropEffect = 'move'
  const folder = drop_target_folder(event)
  const disabled = folder_drag
    ? folder !== null && is_folder_target_disabled(folder)
    : folder !== null && is_folder_drop_disabled(folder)
  drop_folder.value = disabled ? null : folder
  root_drag_over.value = folder === null
  return true
}

function on_file_root_dragover(event: DragEvent) {
  update_drop_state(event)
}

function on_file_root_dragenter(event: DragEvent) {
  root_drag_depth ++
  update_drop_state(event)
}

function on_file_root_dragleave() {
  root_drag_depth = Math.max(0, root_drag_depth - 1)
  if (root_drag_depth === 0) {
    root_drag_over.value = false
    drop_folder.value = null
  }
}

// OS file drops fall through (no attachment payload) to the page-level upload handler.
function on_file_root_drop(event: DragEvent) {
  root_drag_depth = 0
  root_drag_over.value = false
  const folder = drop_target_folder(event)
  if (is_folder_drag(event)) {
    const dragged = get_content_folder_drag_data(event.dataTransfer)
    const source = dragged?.folder
    const disabled = ! source || (folder !== null && is_folder_target_disabled(folder, source))
    clear_dragged_file_names()
    if (source && ! disabled)
      void move_dragged_folder(source, dragged?.file_names ?? [], folder)
    event.preventDefault()
    event.stopPropagation()
    return
  }
  dragged_file_names.value = null
  move_dragged_files(event, folder)
}

function on_file_row_click(event: MouseEvent, row: MyContentAttachmentRow) {
  if (row.data.kind === 'folder')
    on_folder_click(event, row.data.path)
  else if (row.item?.kind === 'stored')
    on_card_select(event, row.item)
  else if (row.item?.kind === 'upload')
    on_upload_card_select(event, row.item)
}

/** Touch swipe-left: same toggle as ctrl+click, which touch devices lack. */
function on_file_row_toggle_selection(row: MyContentAttachmentRow) {
  on_file_row_click({ ctrlKey: true, metaKey: false, shiftKey: false } as MouseEvent, row)
}

// Rubber-band selection: each move replaces the selection with the base set
// (captured at drag start, non-empty only for ctrl/meta) plus the boxed rows.
let marquee_base: string[] | null = null

/** Row keys map onto selection keys: folder rows already match, stored rows carry a `stored:` prefix. */
function row_key_to_selection_key(key: string) {
  return key.startsWith('stored:') ? file_selection_key(key.slice('stored:'.length)) : key
}

function on_list_marquee(keys: string[], additive: boolean, phase: 'start' | 'move' | 'end') {
  if (phase === 'start') {
    marquee_base = additive ? [... selection] : []
    return
  }
  if (phase === 'end') {
    marquee_base = null
    return
  }
  if (marquee_base === null)
    return
  const mapped = keys.map(row_key_to_selection_key)
  const stored_keys = mapped.filter(key => ! key.startsWith('upload:'))
  const upload_keys = mapped.filter(key => key.startsWith('upload:'))
  // Uploads never mix with stored/folder selection; stored wins on overlap.
  const box_stored = stored_keys.length > 0
  const boxed = box_stored ? stored_keys : upload_keys
  selection.clear()
  for (const key of marquee_base) {
    if (box_stored !== key.startsWith('upload:'))
      selection.add(key)
  }
  for (const key of boxed)
    selection.add(key)
  normalize_selection()
}

function on_file_row_contextmenu(_event: MouseEvent, row: MyContentAttachmentRow) {
  if (row.item?.kind === 'stored') {
    on_card_contextmenu(row.item)
    return
  }
  const key = row.item?.kind === 'upload' ? item_selection_key(row.item) : row.key
  if (! selection.has(key)) {
    selection.clear()
    selection.add(key)
    selection_anchor.value = key
  }
}

function on_file_row_dragstart(event: DragEvent, row: MyContentAttachmentRow) {
  if (row.data.kind === 'folder') {
    on_folder_dragstart(event, row.data.path)
    return
  }
  const item = row.item
  if (! item || item.kind !== 'stored')
    return
  const name = item.attachment.file_name
  const names = selected_file_names.value.length > 1 && selected_file_names.value.includes(name)
    ? [... selected_file_names.value]
    : [name]
  dragged_file_names.value = names
  set_content_attachment_drag_data(event, {
    file_name: name,
    is_image: item.attachment.is_image,
    url: item.attachment.url,
    file_names: names.length > 1 ? names : undefined,
  })
}

function on_file_row_dragend(_row: MyContentAttachmentRow) {
  clear_dragged_file_names()
}

function on_file_row_copy(row: MyContentAttachmentRow) {
  if (row.item)
    on_attachment_copy(row.item)
}

function on_file_row_rename(row: MyContentAttachmentRow) {
  if (row.item)
    on_attachment_rename(row.item)
}

function on_file_row_replace(row: MyContentAttachmentRow) {
  if (row.item)
    on_attachment_replace(row.item)
}

function on_file_row_delete(event: MouseEvent, row: MyContentAttachmentRow) {
  const item = row.item
  if (! item)
    return
  const selected = item.kind === 'stored' && selection.has(file_selection_key(item.attachment.file_name))
  if (selection.size > 1 && selected) {
    on_attachment_delete_selection(event)
  }
  else {
    on_attachment_delete(event, item)
  }
}

function on_file_row_retry(row: MyContentAttachmentRow) {
  if (row.item)
    on_attachment_retry(row.item)
}

function on_file_row_pause(row: MyContentAttachmentRow) {
  if (row.item)
    on_attachment_pause(row.item)
}

function on_file_row_cancel(event: MouseEvent, row: MyContentAttachmentRow) {
  if (row.item)
    on_attachment_cancel(event, row.item)
}

function on_file_row_remove(event: MouseEvent, row: MyContentAttachmentRow) {
  if (row.item)
    on_attachment_remove(event, row.item)
}

async function fetch_story() {
  if (! is_edit.value)
    return null
  return await content.get_story(story_id.value)
}

try {
  story.value = await fetch_story()
}
catch {
  error('获取档案信息失败')
}

// Restore unclaimed uploads from previous visits to the new-story editor; the
// orphan pool is shared, so keep it synced like `existing_stories`.
if (! is_edit.value) {
  await useSyncedData<ContentAttachmentScope>(
    computed(() => sync_resource('content_orphan_attachments', 'all')),
    () => content.list_orphan_attachments(),
    new_attachment_scope,
    new_attachments_loading,
  )
}

const initial_markdown = is_edit.value
  ? (story.value?.markdown ?? '')
  : story_markdown_template(datetime_build_string(null, '{YYYY}/{M}/{D}'))
const initial_revision = is_edit.value ? (story.value?.revision ?? null) : null
const draft_story_id = is_edit.value ? story_id.value : null

draft_store.initialize(draft_story_id, initial_markdown, initial_revision)

// Adopt a newer DB version of this story into the editor when it changes
// elsewhere (another admin/tab editing the same story) — content only if the
// editor hasn't diverged from the last known DB base (no local unsaved edits),
// so a remote update never clobbers in-progress work; the attachment list is
// always safe to adopt.
if (import.meta.client && is_edit.value) {
  const { subscribe } = useDataSync()
  const unsubscribe = subscribe(sync_resource('content_story', story_id.value), async () => {
    try {
      const latest_story = await fetch_story()
      if (! latest_story)
        return
      if (draft_dirty.value) {
        if (story.value)
          story.value = { ... story.value, attachments: latest_story.attachments, folders: latest_story.folders }
        return
      }
      story.value = latest_story
      draft_store.mark_saved(latest_story.markdown, latest_story.revision)
    }
    catch {
      // transient sync fetch failure — keep the current editor state
    }
  })
  onUnmounted(unsubscribe)
}

onMounted(() => {
  window.addEventListener('pagehide', persist_draft_on_page_hide)
  window.addEventListener('keydown', on_save_hotkey)
  document.addEventListener('pointerdown', on_document_pointerdown)

  if (is_edit.value && ! story.value)
    return

  const draft = draft_store.read_persisted(draft_story_id)
  if (! draft)
    return

  draft_store.restore(draft, initial_markdown)
  ok('已恢复自动保存的本地草稿')
})

onBeforeUnmount(() => {
  window.removeEventListener('pagehide', persist_draft_on_page_hide)
  window.removeEventListener('keydown', on_save_hotkey)
  document.removeEventListener('pointerdown', on_document_pointerdown)
  draft_store.persist_now()
})

function persist_draft_on_page_hide() {
  draft_store.persist_now()
}

function on_save_hotkey(event: KeyboardEvent) {
  if (! (event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's')
    return
  event.preventDefault()
  if (! save_pending.value)
    on_save_click()
}

function use_database_version() {
  pending_conflict_draft.value = null
  draft_conflict_visible.value = false
  draft_store.discard()
  draft_store.initialize(draft_story_id, story.value?.markdown ?? initial_markdown, story.value?.revision ?? initial_revision)
}

function confirm_abandon_draft(event: Event) {
  if (discard_draft_pending.value)
    return

  const message = is_edit.value
    ? '确定要舍弃本地草稿，并恢复为数据库最新版本吗？'
    : '确定要舍弃本地草稿，并恢复为初始模板吗？'
  confirm_require(event, message, abandon_draft)
}

async function abandon_draft() {
  if (discard_draft_pending.value)
    return

  discard_draft_pending.value = true
  try {
    const latest_story = await fetch_story()
    if (latest_story)
      story.value = latest_story

    use_database_version()
    ok('已舍弃本地草稿')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    discard_draft_pending.value = false
  }
}

function restore_conflicting_draft() {
  const draft = pending_conflict_draft.value
  if (! draft)
    return

  draft_store.restore(
    draft,
    story.value?.markdown ?? initial_markdown,
    story.value?.revision ?? initial_revision,
  )
  pending_conflict_draft.value = null
  draft_conflict_visible.value = false

  on_save_click()
}

async function show_save_conflict() {
  draft_store.persist_now()
  const draft = draft_store.read_persisted(draft_story_id)
  const latest_story = await fetch_story()
  if (! draft || ! latest_story)
    return false

  story.value = latest_story
  pending_conflict_draft.value = draft
  draft_conflict_visible.value = true
  return true
}

function upload_from_file(file: UppyFile<UploadMeta, AwsBody>) {
  const meta = file.meta
  const file_name = meta.file_name || file.name
  const existing = pending_uploads.value.find(upload => upload.uppy_id === file.id)
  const progress = file.progress
  const missing_file = file.isGhost || ! file.data
  const data_type = file.data instanceof Blob ? file.data.type : null
  const status = file.error
    ? 'error'
    : progress?.uploadComplete
      ? 'completed'
      : missing_file
        ? 'paused'
        : file.isPaused
          ? 'paused'
          : progress?.uploadStarted
            ? 'uploading'
            : 'queued'
  const message = file.error ?? (missing_file ? '文件未恢复，请重新选择' : null)
  if (existing) {
    existing.file = file.data as File | null
    existing.file_name = file_name
    existing.file_size = file.data?.size ?? file.size ?? 0
    existing.mime_type = file.type || data_type || null
    // Monotonic like the upload-progress handler: state syncs must not regress.
    existing.progress = Math.max(existing.progress, progress?.percentage ?? 0)
    existing.status = status
    existing.message = message
    return existing
  }
  const upload = reactive<PendingAttachmentUpload>({
    id: meta.local_upload_id ?? next_upload_id ++,
    uppy_id: file.id,
    file: file.data as File | null,
    handle: null,
    file_name,
    file_size: file.data?.size ?? file.size ?? 0,
    mime_type: file.type || data_type || null,
    progress: progress?.percentage ?? 0,
    speed: 0,
    status,
    message,
    controller: null,
    insert_position: meta.insert_position,
  })
  next_upload_id = Math.max(next_upload_id, upload.id + 1)
  pending_uploads.value.push(upload)
  return upload
}

function process_files_for_upload(picks: AttachmentUploadPick[], insert_position?: number | null) {
  if (! uppy || ! picks.length)
    return

  sync_uppy_files(uppy)

  const max_bytes = config.max_content_attachment_size_mb * 1024 * 1024
  const accepted = picks.filter(pick => pick.file.size <= max_bytes)
  if (! accepted.length)
    return

  for (const pick of accepted)
    expand_folder(attachment_folder_of(pick.file_name))

  const new_files = accepted.filter((pick) => {
    const existing = uppy?.getFiles().find(file => file.meta.file_name === pick.file_name && ! file.progress?.uploadComplete)
    if (existing) {
      if (existing.isGhost || ! existing.data) {
        uppy?.removeFile(existing.id)
        return true
      }
      upload_from_file(existing)
      return false
    }
    const completed = uppy?.getFiles().find(file => file.meta.file_name === pick.file_name)
    if (completed)
      uppy?.removeFile(completed.id)
    return true
  })
  const added_ids: string[] = []
  for (const pick of new_files) {
    const file_id = uppy.addFile({
      name: pick.file_name,
      type: pick.file.type,
      data: pick.file,
      meta: {
        file_name: pick.file_name,
        insert_position: insert_position ?? null,
        local_upload_id: next_upload_id ++,
      },
    })
    added_ids.push(file_id)
    const task = pending_uploads.value.find(upload => upload.uppy_id === file_id)
    if (task && pick.handle) {
      task.handle = pick.handle
      void save_upload_file_handle(upload_handle_db_name, `${uppy.getID()}!${file_id}`, {
        file_name: pick.file.name,
        file_size: pick.file.size,
        handle: pick.handle,
      })
    }
  }
  // Start only the newly added files: uppy.upload() would also retry errored
  // tasks, and resumeAll() would unpause tasks the user paused on purpose.
  for (const file_id of added_ids)
    void uppy.retryUpload(file_id)
}

function insert_attachment_markdown(file_name: string, is_image: boolean, position: number | null) {
  const text = content_attachment_markdown({ file_name, is_image, url: '' })
  if (position !== null && markdown_editor.value) {
    markdown_editor.value.insert_at_position(text, position)
    return
  }
  const needs_newline = markdown.value.length > 0 && ! markdown.value.endsWith('\n')
  markdown.value += `${needs_newline ? '\n' : ''}${text}`
}

function on_attachment_files_picked(picks: AttachmentUploadPick[]) {
  process_files_for_upload(picks)
}

async function on_attachment_drop(event: DragEvent) {
  attachment_drag_over.value = false
  const dragged = get_content_attachment_drag_data(event.dataTransfer)
  if (dragged) {
    const names = content_attachment_drag_file_names(dragged).filter(name => attachment_folder_of(name))
    if (names.length)
      void on_attachment_move(names, null)
    return
  }
  process_files_for_upload(await attachment_picks_from_data_transfer(event.dataTransfer))
}

// Fullscreen drops outside the list and the editor (preview pane, dividers,
// toolbar, gaps) mean "drag out to the root", like the section background.
function on_attachment_drop_outside(event: DragEvent) {
  const dragged_folder = get_content_folder_drag_data(event.dataTransfer)
  if (dragged_folder) {
    void move_dragged_folder(dragged_folder.folder, dragged_folder.file_names ?? [], null)
    return
  }
  const dragged = get_content_attachment_drag_data(event.dataTransfer)
  if (! dragged)
    return
  const names = content_attachment_drag_file_names(dragged).filter(name => attachment_folder_of(name))
  if (names.length)
    void on_attachment_move(names, null)
}

function on_editor_files_dropped(picks: AttachmentUploadPick[], position: number | null) {
  process_files_for_upload(picks, position)
}

async function confirm_uppy_upload(file: UppyFile<UploadMeta, AwsBody>, response: AwsBody) {
  const upload = upload_from_file(file)
  try {
    const attachment = await content.confirm_attachment_upload(story_id.value, response.key, upload.file_name)
    upload.progress = 100
    upload.status = 'completed'
    if (story.value && ! story.value.attachments.some(item => item.file_name === attachment.file_name)) {
      story.value = { ... story.value, attachments: [... story.value.attachments, attachment] }
    }
    else if (! story.value) {
      const scope = new_attachment_scope.value ?? { attachments: [], folders: [], operation_lock: null }
      if (! scope.attachments.some(item => item.file_name === attachment.file_name))
        new_attachment_scope.value = { ... scope, attachments: [... scope.attachments, attachment] }
    }
    if (upload.insert_position !== null)
      insert_attachment_markdown(attachment.file_name, attachment.is_image, upload.insert_position)
    remove_upload(upload.id)
  }
  catch (ex) {
    upload.status = 'error'
    upload.message = error_message(ex)
  }
}

/** Recover the source file for a data-less task: handle permission (A), then picker (B). */
async function resolve_upload_file(upload: PendingAttachmentUpload): Promise<File | null> {
  const record = uppy
    ? await load_upload_file_handle(upload_handle_db_name, `${uppy.getID()}!${upload.uppy_id}`).catch(() => null)
    : null
  if (record) {
    upload.handle = record.handle
    let permission: PermissionState | null = null
    try {
      const handle = record.handle
      if (typeof handle.queryPermission === 'function') {
        permission = await handle.queryPermission({ mode: 'read' })
        if (permission === 'prompt' && typeof handle.requestPermission === 'function')
          permission = await handle.requestPermission({ mode: 'read' })
      }
      else if (typeof handle.requestPermission === 'function') {
        permission = await handle.requestPermission({ mode: 'read' })
      }
    }
    catch {
      permission = null
    }
    if (permission === 'granted') {
      const file = await record.handle.getFile().catch(() => null)
      if (file && file.name === record.file_name && file.size === record.file_size)
        return file
      return null
    }
  }
  const expected_name = record?.file_name ?? attachment_base_name(upload.file_name)
  const expected_size = record?.file_size ?? upload.file_size
  return await pick_resume_file(expected_name, expected_size)
}

/** Ask the user to re-select the source file, matching name and size (fallback B). */
function pick_resume_file(expected_name: string, expected_size: number): Promise<File | null> {
  if (typeof window.showOpenFilePicker === 'function') {
    return window.showOpenFilePicker({ multiple: false })
      .then(async ([handle]) => {
        if (! handle)
          return null
        const file = await handle.getFile()
        if (file.name !== expected_name || file.size !== expected_size)
          return null
        return file
      })
      .catch(() => null)
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.onchange = () => {
      const file = input.files?.[0] ?? null
      resolve(file && file.name === expected_name && file.size === expected_size ? file : null)
    }
    input.click()
  })
}

async function retry_upload(upload: PendingAttachmentUpload) {
  if (! uppy)
    return
  const instance = uppy
  const file = instance.getFile(upload.uppy_id)
  if (! file)
    return
  if (! file.data) {
    const resolved = await resolve_upload_file(upload)
    if (! resolved)
      return
    instance.setFileState(upload.uppy_id, { data: resolved, isGhost: false })
  }
  upload.message = null
  upload.status = 'uploading'
  void instance.retryUpload(upload.uppy_id).catch((ex) => {
    upload.status = 'error'
    upload.message = error_message(ex)
  })
}

async function pause_upload(upload: PendingAttachmentUpload) {
  if (! uppy)
    return
  const instance = uppy
  const file = instance.getFile(upload.uppy_id)
  if (! file)
    return

  // The card toggles between "暂停上传" and "继续上传" based on task.status;
  // drive the action off that (not `file.isPaused`) so a restored ghost that
  // never got paused still resumes instead of pausing again.
  const resuming = upload.status === 'paused' || upload.status === 'queued'
  if (! resuming) {
    const is_paused = instance.pauseResume(upload.uppy_id)
    if (is_paused !== undefined)
      upload.status = is_paused ? 'paused' : 'uploading'
    return
  }

  if (live_upload_ids.has(upload.uppy_id)) {
    instance.pauseResume(upload.uppy_id)
    upload.status = 'uploading'
    return
  }

  if (! file.data) {
    const resolved = await resolve_upload_file(upload)
    if (! resolved)
      return
    instance.setFileState(upload.uppy_id, { data: resolved, isGhost: false })
  }
  instance.setFileState(upload.uppy_id, { isPaused: false, error: null })
  const restored_upload_id = Object.entries(instance.getState().currentUploads)
    .find(([, current]) => current.fileIDs.includes(upload.uppy_id))?.[0]
  const resume = restored_upload_id
    ? instance.restore(restored_upload_id)
    : instance.retryUpload(upload.uppy_id)
  upload.message = null
  upload.status = 'uploading'
  void resume.catch(async (ex) => {
    try {
      await instance.retryUpload(upload.uppy_id)
    }
    catch (retry_ex) {
      upload.status = 'error'
      upload.message = error_message(retry_ex || ex)
    }
  })
}

function cancel_upload(upload: PendingAttachmentUpload) {
  live_upload_ids.delete(upload.uppy_id)
  uppy?.removeFile(upload.uppy_id)
  remove_upload(upload.id, false)
}

function remove_upload(id: number, remove_from_uppy = true) {
  const upload = pending_uploads.value.find(item => item.id === id)
  if (remove_from_uppy && upload)
    uppy?.removeFile(upload.uppy_id)
  pending_uploads.value = pending_uploads.value.filter(upload => upload.id !== id)
}

/** Batch-resume every selected paused/queued upload (continues multipart where it left off). */
function batch_start_selected_uploads() {
  const tasks = selected_upload_tasks.value.filter(task => task.status === 'paused' || task.status === 'queued')
  for (const task of tasks)
    void pause_upload(task)
}

/** Batch-pause every selected actively uploading task. */
function batch_pause_selected_uploads() {
  const tasks = selected_upload_tasks.value.filter(task => task.status === 'uploading')
  for (const task of tasks)
    void pause_upload(task)
}

/** Batch-cancel (and remove) every selected upload task, after confirmation. */
function batch_delete_selected_uploads(event: MouseEvent) {
  const tasks = [... selected_upload_tasks.value]
  if (! tasks.length)
    return
  confirm_require(event, `确定要删除选中的 ${tasks.length} 个上传任务吗？`, () => {
    for (const task of tasks)
      cancel_upload(task)
    clear_selection()
  }, {
    acceptProps: { label: '删除', severity: 'danger' },
  })
}

function sync_uppy_files(instance: Uppy<UploadMeta, AwsBody>) {
  for (const file of instance.getFiles()) {
    if (! file.progress?.uploadComplete)
      upload_from_file(file)
  }
}

function setup_uppy() {
  if (! import.meta.client || uppy)
    return

  const instance = new UppyCore<UploadMeta, AwsBody>({
    id: `content-upload-${upload_scope.value}`,
    autoProceed: false,
    restrictions: {
      maxFileSize: config.max_content_attachment_size_mb * 1024 * 1024,
    },
  })
  instance.on('file-added', file => upload_from_file(file))
  instance.on('file-removed', (file) => {
    upload_speed_marks.delete(file.id)
    void delete_upload_file_handle(upload_handle_db_name, `${instance.getID()}!${file.id}`).catch(() => {})
  })
  instance.on('upload-start', (files) => {
    for (const file of files)
      live_upload_ids.add(file.id)
  })
  instance.on('upload-progress', (file, progress) => {
    if (! file)
      return
    const upload = upload_from_file(file)
    live_upload_ids.add(file.id)
    upload.status = 'uploading'
    // A retried part restarts its byte counter at 0; never move the bar backwards.
    const percent = progress.bytesTotal ? Math.round(progress.bytesUploaded / progress.bytesTotal * 100) : 0
    if (percent > upload.progress)
      upload.progress = percent
    // Bytes/time delta for a live transfer rate; skipped while the counter regresses.
    const now = performance.now()
    let mark = upload_speed_marks.get(file.id)
    if (! mark) {
      mark = { loaded: 0, stamp: now }
      upload_speed_marks.set(file.id, mark)
    }
    const elapsed = (now - mark.stamp) / 1000
    if (elapsed >= 0.3 && progress.bytesUploaded >= mark.loaded) {
      upload.speed = (progress.bytesUploaded - mark.loaded) / elapsed
      upload_speed_marks.set(file.id, { loaded: progress.bytesUploaded, stamp: now })
    }
    upload_busy.value = true
  })
  instance.on('upload-error', (file, upload_error) => {
    if (! file)
      return
    const upload = upload_from_file(file)
    live_upload_ids.delete(file.id)
    upload_speed_marks.delete(file.id)
    upload.status = 'error'
    upload.speed = 0
    upload.message = upload_error.message
    upload_busy.value = false
  })
  instance.on('upload-pause', (file, is_paused) => {
    if (! file)
      return
    const upload = upload_from_file(file)
    // Drop the sample so a resume recalibrates instead of averaging in the pause.
    upload_speed_marks.delete(file.id)
    upload.speed = 0
    // Keep the id in live_upload_ids while paused: the uploader instance (and
    // its queue slot) stays alive, so resume must go through pauseResume
    // rather than restore(), which would spawn a duplicate uploader.
    upload.status = is_paused ? 'paused' : 'uploading'
  })
  instance.on('upload-success', (file, response) => {
    if (! file || ! response?.body?.key)
      return
    live_upload_ids.delete(file.id)
    upload_speed_marks.delete(file.id)
    void confirm_uppy_upload(file, response.body)
  })
  instance.on('restored', () => {
    sync_uppy_files(instance)
    for (const file of instance.getFiles()) {
      const multipart = 's3Multipart' in file ? file.s3Multipart : undefined
      if (! multipart)
        continue
      const upload = upload_from_file(file)
      if (file.data) {
        upload.status = 'uploading'
        upload.message = null
        void instance.retryUpload(file.id).catch((ex) => {
          upload.status = 'error'
          upload.message = error_message(ex)
        })
      }
      else {
        // Blob was too big for GoldenRetriever; try the File System Access handle.
        upload.status = 'paused'
        upload.message = null
        void load_upload_file_handle(upload_handle_db_name, `${instance.getID()}!${file.id}`)
          .then((record) => {
            if (record)
              upload.handle = record.handle
          })
          .catch(() => {})
      }
    }
  })
  instance.on('complete', () => {
    upload_busy.value = false
  })
  instance.use(AwsS3, {
    shouldUseMultipart: file => (file.size ?? 0) > 5 * 1024 * 1024,
    getChunkSize: () => 8 * 1024 * 1024,
    // Paused uploads hold their queue slots (their promises stay pending), so a
    // finite limit would let a few paused tasks starve every new upload. 0 =
    // unlimited file concurrency; parts of each file still upload sequentially.
    limit: 0,
    generateObjectKey: () => `content-upload/${upload_scope.value}/${crypto.randomUUID()}`,
    signRequest: async request => content.sign_attachment_upload({
      story_id: story_id.value,
      method: request.method,
      key: request.key,
      ... ('uploadId' in request ? { upload_id: request.uploadId } : {}),
      ... ('partNumber' in request ? { part_number: request.partNumber } : {}),
    }),
  })
  instance.use(GoldenRetriever, { serviceWorker: false })
  sync_uppy_files(instance)
  uppy = instance
}

onMounted(setup_uppy)

function on_attachment_copy(item: AttachmentListItem) {
  if (item.kind === 'stored')
    copy_attachment_code(item.attachment)
}

function on_attachment_rename(item: AttachmentListItem) {
  if (item.kind === 'stored' && is_edit.value)
    open_rename_dialog(item.attachment)
}

function on_attachment_replace(item: AttachmentListItem) {
  if (item.kind === 'stored' && is_edit.value)
    open_replace_dialog(item.attachment)
}

function on_attachment_delete(event: MouseEvent, item: AttachmentListItem) {
  if (item.kind === 'stored')
    confirm_delete_attachment(event, item.attachment)
}

function on_attachment_retry(item: AttachmentListItem) {
  if (item.kind === 'upload')
    retry_upload(item.task)
}

function on_attachment_pause(item: AttachmentListItem) {
  if (item.kind === 'upload')
    pause_upload(item.task)
}

function on_attachment_cancel(event: MouseEvent, item: AttachmentListItem) {
  if (item.kind !== 'upload')
    return
  confirm_require(event, `确定要取消『${item.task.file_name}』的上传吗？`, () => cancel_upload(item.task), {
    acceptProps: { label: '取消上传', severity: 'danger' },
  })
}

function on_attachment_remove(event: MouseEvent, item: AttachmentListItem) {
  if (item.kind !== 'upload')
    return
  confirm_require(event, `确定要移除『${item.task.file_name}』的上传任务吗？`, () => remove_upload(item.task.id), {
    acceptProps: { label: '移除', severity: 'danger' },
  })
}

function is_referenced(file_name: string) {
  return referenced_files.value.includes(file_name)
}

function preview_image(url: string) {
  preview_images.value = [url]
  preview_visible.value = true
}

async function copy_attachment_code(attachment: ContentStoryAttachment) {
  try {
    await navigator.clipboard.writeText(content_attachment_markdown(attachment))
  }
  catch {
    // Clipboard permission denial stays silent.
  }
}

function on_attachment_copy_folder(row: MyContentAttachmentRow) {
  if (row.data.kind !== 'folder')
    return
  // A folder copies the same shorthand as a file: `[](folder)`, no image prefix.
  void copy_folder_code(row.data.path)
}

async function copy_folder_code(folder: string) {
  try {
    await navigator.clipboard.writeText(content_folder_markdown(folder))
  }
  catch {
    // Clipboard permission denial stays silent.
  }
}

function attachment_stem(file_name: string) {
  const dot = file_name.lastIndexOf('.')
  return dot > 0 ? file_name.slice(0, dot) : file_name
}

function attachment_extension(file_name: string) {
  const dot = file_name.lastIndexOf('.')
  return dot > 0 ? file_name.slice(dot) : ''
}

function open_rename_dialog(attachment: ContentStoryAttachment) {
  rename_target.value = attachment
  rename_file_name.value = attachment_stem(attachment_base_name(attachment.file_name))
  rename_visible.value = true
}

async function rename_attachment() {
  const target = rename_target.value
  const file_name = attachment_path_join(attachment_folder_of(target?.file_name ?? ''), `${rename_file_name.value.trim()}${attachment_extension(target?.file_name ?? '')}`)
  if (! target || ! rename_file_name.value.trim() || rename_pending.value)
    return

  if (file_name === target.file_name) {
    rename_visible.value = false
    return
  }

  rename_pending.value = true
  try {
    await content.rename_attachment(story_id.value, target.file_name, file_name)
    markdown.value = rename_attachment_references(markdown.value, target.file_name, file_name)
    story.value = await fetch_story()
    if (story.value) {
      draft_store.advance_base(story.value.markdown, story.value.revision)
    }
    rename_visible.value = false
  }
  catch {
    // Attachment operations no longer toast; the dialog stays open for a retry.
  }
  finally {
    rename_pending.value = false
  }
}

const content_scope_id = computed(() => is_edit.value ? story_id.value : 0)

/** Adopt a folder/file operation's scope payload into the local state. */
function apply_scope_payload(payload: ContentAttachmentScope) {
  if (is_edit.value) {
    if (story.value)
      story.value = { ... story.value, attachments: payload.attachments, folders: payload.folders }
  }
  else {
    new_attachment_scope.value = payload
  }
}

function on_attachment_create_folder(parent: string | null) {
  folder_parent.value = parent
  folder_name.value = ''
  folder_visible.value = true
}

async function create_folder() {
  const name = folder_name.value.trim()
  if (! name || folder_pending.value)
    return

  const path = attachment_path_join(folder_parent.value, name)
  if (folder_names.value.includes(path))
    return

  folder_pending.value = true
  try {
    apply_scope_payload(await content.create_folder(content_scope_id.value, path))
    expand_folder(path)
    folder_visible.value = false
  }
  catch {
    // Attachment operations no longer toast.
  }
  finally {
    folder_pending.value = false
  }
}

function on_attachment_rename_folder(folder: string) {
  if (move_attachment_pending.value)
    return
  rename_folder_target.value = folder
  rename_folder_name.value = attachment_base_name(folder)
  rename_folder_visible.value = true
}

async function rename_folder() {
  const source = rename_folder_target.value
  const name = rename_folder_name.value.trim()
  if (! source || ! name || move_attachment_pending.value)
    return

  const new_folder = attachment_path_join(attachment_folder_of(source), name)
  if (new_folder === source) {
    rename_folder_visible.value = false
    return
  }
  if (folder_names.value.includes(new_folder))
    return

  rename_folder_visible.value = false
  await move_folder_to(source, new_folder)
}

function folder_attachment_names(folder: string) {
  return stored_attachments.value
    .filter(attachment => attachment.file_name.startsWith(`${folder}/`))
    .map(attachment => attachment.file_name)
}

function on_attachment_delete_folder(event: MouseEvent, folder: string) {
  if (delete_folder_pending.size || delete_attachment_pending.size)
    return
  if (selection.size > 1 && selection.has(folder_selection_key(folder))) {
    on_attachment_delete_selection(event)
    return
  }
  const names = folder_attachment_names(folder)
  if (! names.length) {
    confirm_require(event, `确定要删除空文件夹『${folder}』吗？`, () => {
      void delete_folder(folder)
    }, {
      acceptProps: { label: '删除', severity: 'danger' },
    })
    return
  }
  const referenced = names.filter(name => is_referenced(name))
  if (referenced.length)
    return
  confirm_require(event, `确定要永久删除文件夹『${folder}』及其 ${names.length} 个附件吗？`, () => {
    void delete_folder_with_attachments(folder, names)
  }, {
    acceptProps: { label: '删除', severity: 'danger' },
  })
}

function selected_delete_targets() {
  const folders = [... selection]
    .filter(key => key.startsWith('folder:'))
    .map(key => key.slice('folder:'.length))
  const names = new Set([... selection]
    .filter(key => key.startsWith('file:'))
    .map(key => key.slice('file:'.length)))
  for (const folder of folders) {
    for (const name of folder_attachment_names(folder))
      names.add(name)
  }
  return {
    folders,
    attachments: stored_attachments.value.filter(attachment => names.has(attachment.file_name)),
  }
}

function on_attachment_delete_selection(event: MouseEvent) {
  if (delete_folder_pending.size || delete_attachment_pending.size)
    return
  const { folders, attachments } = selected_delete_targets()
  const referenced = attachments.filter(attachment => is_referenced(attachment.file_name))
  if (referenced.length)
    return
  if (! folders.length && ! attachments.length)
    return
  const folder_label = folders.length ? ` ${folders.length} 个文件夹` : ''
  const attachment_label = attachments.length ? ` ${attachments.length} 个附件` : ''
  const target_label = [folder_label, attachment_label].filter(Boolean).join('及')
  confirm_require(event, `确定要永久删除所选${target_label}吗？`, () => {
    void delete_selected_attachments(folders, attachments)
  }, {
    acceptProps: { label: '删除', severity: 'danger' },
  })
}

async function delete_folder(folder: string) {
  delete_folder_pending.add(folder)
  try {
    apply_scope_payload(await content.delete_folder(content_scope_id.value, folder))
  }
  catch {
    // Attachment operations no longer toast.
  }
  finally {
    delete_folder_pending.delete(folder)
  }
}

async function delete_folder_with_attachments(folder: string, names: string[]) {
  delete_folder_pending.add(folder)
  try {
    if (! is_edit.value) {
      for (const name of names) {
        delete_attachment_pending.add(name)
        try {
          await content.delete_orphan_attachment(name)
        }
        finally {
          delete_attachment_pending.delete(name)
        }
      }
      apply_scope_payload(await content.delete_folder(content_scope_id.value, folder))
      return
    }
    if (! base_revision.value)
      throw new Error('缺少档案基础版本，请刷新页面后重试')
    for (const name of names)
      delete_attachment_pending.add(name)
    await content.update_story(story_id.value, {
      markdown: markdown.value,
      base_revision: base_revision.value,
      delete_files: names,
    })
    await content.delete_folder(content_scope_id.value, folder)
    story.value = await fetch_story()
    if (story.value)
      draft_store.advance_base(story.value.markdown, story.value.revision)
  }
  catch (ex) {
    if (get_error_status(ex) === 409 && await show_save_conflict())
      return
    // Attachment operations no longer toast.
  }
  finally {
    for (const name of names)
      delete_attachment_pending.delete(name)
    delete_folder_pending.delete(folder)
  }
}

async function on_attachment_move(file_names: string[], target_folder: string | null) {
  expand_folder(target_folder)
  const moves = file_names.map(file_name => ({ file_name, target_folder }))
  await execute_attachment_moves(moves, { names: file_names, target: target_folder })
}

async function move_dragged_folder(source_folder: string, file_names: string[], target_folder: string | null) {
  expand_folder(target_folder)
  const new_folder = attachment_path_join(target_folder, attachment_base_name(source_folder))
  const extra_names = file_names.filter(file_name => ! file_name.startsWith(`${source_folder}/`) && attachment_folder_of(file_name) !== target_folder)
  const moved = await move_folder_to(source_folder, new_folder)
  if (moved && extra_names.length) {
    await execute_attachment_moves(
      extra_names.map(file_name => ({ file_name, target_folder })),
      { names: extra_names, target: target_folder },
    )
  }
}

/** Rewrites `markdown` so every local reference follows a just-completed set of moves. */
function apply_local_attachment_moves(moves: { file_name: string, target_folder: string | null }[]) {
  for (const move of moves) {
    markdown.value = rename_attachment_references(
      markdown.value,
      move.file_name,
      attachment_path_join(move.target_folder, attachment_base_name(move.file_name)),
    )
  }
}

async function execute_attachment_moves(
  moves: { file_name: string, target_folder: string | null }[],
  pending: Omit<NonNullable<typeof move_attachment_pending.value>, 'moves'>,
) {
  // One move batch at a time; the list blocks further drops while this is set.
  if (move_attachment_pending.value || ! moves.length)
    return false
  move_attachment_pending.value = { ... pending, moves }
  try {
    const moved = await content.move_attachments(content_scope_id.value, moves)
    // Follow the rename in the local markdown whether or not the draft is
    // dirty: in edit mode the server rewrote the stored markdown, so leaving
    // the editor on the old names would make the tab dirty against the new
    // base and its next save would revert the rename.
    apply_local_attachment_moves(moves)
    if (is_edit.value) {
      story.value = await fetch_story()
      if (story.value)
        draft_store.advance_base(story.value.markdown, story.value.revision)
    }
    else {
      const scope = new_attachment_scope.value
      if (scope)
        new_attachment_scope.value = { ... scope, attachments: moved }
    }
    return true
  }
  catch {
    // Attachment operations no longer toast.
    return false
  }
  finally {
    move_attachment_pending.value = null
  }
}

/** Moves/renames a whole folder server-side (one prefix rewrite, no per-file calls). */
async function move_folder_to(source_folder: string, new_folder: string) {
  if (move_attachment_pending.value || new_folder === source_folder)
    return false

  const names = folder_attachment_names(source_folder)
  // Synthesize the display-only move map so rows show their new paths mid-flight.
  const moves = names.map(file_name => ({
    file_name,
    target_folder: attachment_folder_of(attachment_path_join(new_folder, file_name.slice(source_folder.length + 1))),
  }))
  move_attachment_pending.value = { names, target: attachment_folder_of(new_folder), moves, source_folder, new_folder }
  try {
    const payload = await content.move_folder(content_scope_id.value, source_folder, new_folder)
    apply_local_attachment_moves(moves)
    if (is_edit.value) {
      story.value = await fetch_story()
      if (story.value)
        draft_store.advance_base(story.value.markdown, story.value.revision)
    }
    else {
      apply_scope_payload(payload)
    }
    return true
  }
  catch {
    // Attachment operations no longer toast.
    return false
  }
  finally {
    move_attachment_pending.value = null
  }
}

function open_replace_dialog(attachment: ContentStoryAttachment) {
  replace_target.value = attachment
  replace_file.value = null
  replace_name_mode.value = 'keep-name'
  replace_drag_over.value = false
  if (replace_file_input.value) {
    replace_file_input.value.value = ''
  }
  replace_visible.value = true
}

function close_replace_dialog() {
  if (replace_pending.value)
    return
  replace_visible.value = false
  replace_target.value = null
  replace_file.value = null
  replace_drag_over.value = false
}

function on_replace_file_picked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  if (file) {
    replace_file.value = file
    void do_replace()
  }
}

function on_replace_drop(event: DragEvent) {
  replace_drag_over.value = false
  const file = event.dataTransfer?.files?.[0] ?? null
  if (file) {
    replace_file.value = file
    void do_replace()
  }
}

function on_replace_paste(event: ClipboardEvent) {
  const file = event.clipboardData?.files?.[0] ?? null
  if (file) {
    event.preventDefault()
    replace_file.value = file
    void do_replace()
  }
}

// The modal traps focus, so a paste may originate anywhere inside the dialog;
// listen at window level while the dialog is open.
watch(replace_visible, (visible) => {
  if (visible) {
    window.addEventListener('paste', on_replace_paste)
  }
  else {
    window.removeEventListener('paste', on_replace_paste)
  }
})

async function do_replace() {
  const target = replace_target.value
  const file = replace_file.value
  if (! target || ! file || replace_pending.value)
    return

  replace_pending.value = target
  replace_progress.value = reactive({ progress: 0, speed: 0 })
  // Close the dialog right away: live progress is shown on the attachment card.
  replace_visible.value = false

  // Track bytes/time deltas to report a live transfer rate.
  let last_loaded = 0
  let last_stamp = performance.now()

  try {
    const replaced = await content.replace_attachment(story_id.value, target.file_name, file, replace_name_mode.value, (progress, loaded) => {
      const state = replace_progress.value
      if (! state)
        return
      state.progress = progress
      const now = performance.now()
      const elapsed = (now - last_stamp) / 1000
      if (elapsed >= 0.3 && loaded >= last_loaded) {
        state.speed = (loaded - last_loaded) / elapsed
        last_loaded = loaded
        last_stamp = now
      }
    })
    if (replaced.file_name !== target.file_name) {
      markdown.value = rename_attachment_references(markdown.value, target.file_name, replaced.file_name)
    }
    story.value = await fetch_story()
    if (story.value) {
      draft_store.advance_base(story.value.markdown, story.value.revision)
    }
  }
  catch {
    // Attachment operations no longer toast.
  }
  finally {
    replace_pending.value = null
    replace_progress.value = null
    replace_target.value = null
    replace_file.value = null
    if (replace_file_input.value) {
      replace_file_input.value.value = ''
    }
  }
}

function confirm_delete_attachment(event: Event, attachment: ContentStoryAttachment) {
  if (is_referenced(attachment.file_name))
    return

  confirm_require(event, '确定要永久删除该附件吗？', () => {
    void delete_attachment(attachment)
  }, {
    acceptProps: { severity: 'danger' },
  })
}

async function delete_attachment(attachment: ContentStoryAttachment) {
  if (is_referenced(attachment.file_name))
    return

  delete_attachment_pending.add(attachment.file_name)
  try {
    if (! is_edit.value) {
      await content.delete_orphan_attachment(attachment.file_name)
      const scope = new_attachment_scope.value
      if (scope)
        new_attachment_scope.value = { ... scope, attachments: scope.attachments.filter(item => item.file_name !== attachment.file_name) }
      return
    }
    if (! base_revision.value) {
      throw new Error('缺少档案基础版本，请刷新页面后重试')
    }
    await content.delete_attachment(story_id.value, attachment.file_name, markdown.value, base_revision.value)
    story.value = await fetch_story()
    if (story.value) {
      draft_store.advance_base(story.value.markdown, story.value.revision)
    }
  }
  catch (ex) {
    if (get_error_status(ex) === 409 && await show_save_conflict()) {
      return
    }
    // Attachment operations no longer toast.
  }
  finally {
    delete_attachment_pending.delete(attachment.file_name)
  }
}

async function delete_selected_attachments(folders: string[], attachments: ContentStoryAttachment[]) {
  for (const folder of folders)
    delete_folder_pending.add(folder)
  try {
    const deleted = await delete_attachments(attachments)
    if (deleted !== attachments.length)
      return
    for (const folder of folders)
      apply_scope_payload(await content.delete_folder(content_scope_id.value, folder))
    clear_selection()
  }
  finally {
    for (const folder of folders)
      delete_folder_pending.delete(folder)
  }
}

// Sequential deletes: each pass refetches the story and advances the base revision.
async function delete_attachments(attachments: ContentStoryAttachment[]) {
  let deleted = 0
  if (is_edit.value) {
    for (const attachment of attachments)
      delete_attachment_pending.add(attachment.file_name)
    try {
      if (! base_revision.value)
        throw new Error('缺少档案基础版本，请刷新页面后重试')
      await content.update_story(story_id.value, {
        markdown: markdown.value,
        base_revision: base_revision.value,
        delete_files: attachments.map(attachment => attachment.file_name),
      })
      story.value = await fetch_story()
      if (story.value)
        draft_store.advance_base(story.value.markdown, story.value.revision)
      deleted = attachments.length
    }
    catch (ex) {
      if (get_error_status(ex) === 409 && await show_save_conflict())
        return 0
      // Attachment operations no longer toast.
    }
    finally {
      for (const attachment of attachments)
        delete_attachment_pending.delete(attachment.file_name)
    }
    return deleted
  }
  for (const attachment of attachments) {
    delete_attachment_pending.add(attachment.file_name)
    try {
      if (! is_edit.value) {
        await content.delete_orphan_attachment(attachment.file_name)
        const scope = new_attachment_scope.value
        if (scope)
          new_attachment_scope.value = { ... scope, attachments: scope.attachments.filter(item => item.file_name !== attachment.file_name) }
        deleted ++
        continue
      }
      if (! base_revision.value)
        throw new Error('缺少档案基础版本，请刷新页面后重试')
      await content.delete_attachment(story_id.value, attachment.file_name, markdown.value, base_revision.value)
      story.value = await fetch_story()
      if (story.value)
        draft_store.advance_base(story.value.markdown, story.value.revision)
      deleted ++
    }
    catch {
      break
    }
    finally {
      delete_attachment_pending.delete(attachment.file_name)
    }
  }
  return deleted
}

function on_save_click() {
  // Prefer the editor's full combined lint (front matter + HTML grammar +
  // markdownlint) so save blocks on exactly what the editor shows; fall back
  // to the shared front-matter parser if the editor isn't mounted.
  const issues = markdown_editor.value?.validate()?.map(item => ({
    line: item.line,
    severity: item.severity,
    message: item.message,
  })) ?? parse_story_markdown(markdown.value, content_markdown_config.value).issues
  if (issues.some(issue => issue.severity === 'error')) {
    const first_error = issues.find(issue => issue.severity === 'error')
    error(first_error?.message ? `第 ${first_error.line} 行：${first_error.message}` : 'Markdown 代码存在未知错误')
    return
  }

  if (! is_edit.value) {
    void do_create()
    return
  }

  void do_save()
}

async function do_create() {
  save_pending.value = true
  try {
    const claim_files = (new_attachment_scope.value?.attachments ?? []).map(attachment => attachment.file_name)
    const result = await content.create_story(markdown.value, claim_files)

    draft_store.discard()
    ok('档案已创建')
    await navigateTo(`/content/${result.id}/edit`)
  }
  catch (ex) {
    error(ex)
  }
  finally {
    save_pending.value = false
  }
}

async function do_save() {
  save_pending.value = true
  try {
    if (! base_revision.value) {
      throw new Error('缺少档案基础版本，请刷新页面后重试')
    }
    await content.update_story(story_id.value, {
      markdown: markdown.value,
      base_revision: base_revision.value,
    })

    story.value = await fetch_story()
    if (story.value) {
      draft_store.mark_saved(story.value.markdown, story.value.revision)
    }
    ok('档案已保存')
  }
  catch (ex) {
    if (get_error_status(ex) === 409 && await show_save_conflict()) {
      return
    }
    error(ex)
  }
  finally {
    save_pending.value = false
  }
}

function confirm_delete_story(event: Event) {
  if (! story.value)
    return

  confirm_require(event, '确定要删除整个档案吗？所有附件都会一起消失', async () => {
    delete_pending.value = true
    try {
      await content.delete_story(story_id.value)
      draft_store.discard()
      ok('档案已删除')
      await navigateTo('/content')
    }
    catch (ex) {
      error(ex)
    }
    finally {
      delete_pending.value = false
    }
  })
}
</script>
