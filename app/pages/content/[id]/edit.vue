<template>
  <div class="space-y-12 pb-12 pt-8">
    <div v-if="! is_edit || story">
      <MyContentStoryHeader back :invalid="! header_meta" :title="header_title" :labels="header_labels" :desc="header_desc" :cover="header_cover" :cover-label="header_cover_label" :cover-version="header_cover_version" :date="header_date" :story-id="is_edit ? story_id : null">
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
          @files-dropped="on_editor_files_dropped"
        >
          <template #toolbar-start>
            <div
              class="flex text-xs items-center gap-1"
              :class="draft_storage_error ? 'text-red-500 dark:text-red-400' : 'text-slate-500 dark:text-slate-400'"
            >
              <MyIcon :name="draft_storage_error ? 'lucide:circle-alert' : 'lucide:cloud-check'" class="mr-1 align-text-bottom" />
              <span>{{ draft_status_label }}</span>
              <Button
                v-if="draft_dirty"
                label="舍弃"
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
            <div class="mb-2 flex items-center justify-between gap-2">
              <span class="text-xs text-slate-500 dark:text-slate-400">
                共 {{ stored_attachments.length }} 个
                <span v-if="active_upload_count">
                  ，{{ active_upload_count }} 个待上传
                </span>
                <span v-if="failed_upload_count">
                  ，{{ failed_upload_count }} 个失败
                </span>
              </span>
              <Button
                size="small"
                severity="secondary"
                text
                label="上传"
                :loading="upload_busy"
                :disabled="upload_busy"
                @click="attachment_file_input?.click()"
              >
                <template #icon>
                  <MyIcon name="lucide:paperclip" />
                </template>
              </Button>
            </div>
            <div v-if="attachment_items.length" class="flex flex-col gap-2">
              <MyContentAttachmentCard
                v-for="item in attachment_items"
                :key="item.key"
                :file="item.card"
                :delete_pending="item.kind === 'stored' && delete_attachment_pending === item.card.file_name"
                :delete_disabled="delete_attachment_pending !== null"
                :rename_disabled="! is_edit"
                :replace_disabled="replace_pending !== null"
                :retry_disabled="upload_busy"
                @preview="preview_image"
                @copy="item.kind === 'stored' && copy_attachment_code(item.attachment)"
                @rename="item.kind === 'stored' && is_edit && open_rename_dialog(item.attachment)"
                @replace="item.kind === 'stored' && is_edit && open_replace_dialog(item.attachment)"
                @delete="item.kind === 'stored' && confirm_delete_attachment($event, item.attachment)"
                @retry="item.kind === 'upload' && retry_upload(item.task)"
                @cancel="item.kind === 'upload' && cancel_upload(item.task)"
                @remove="item.kind === 'upload' && remove_upload(item.task.id)"
              />
            </div>
            <div v-else class="py-8 text-center text-xs text-slate-500 dark:text-slate-400">
              暂无附件
            </div>
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
        <div class="w-full flex justify-end items-center gap-3">
          <span class="text-xs text-slate-500 dark:text-slate-400">
            共 {{ stored_attachments.length }} 个
            <span v-if="active_upload_count">
              ，{{ active_upload_count }} 个待上传
            </span>
            <span v-if="failed_upload_count">
              ，{{ failed_upload_count }} 个失败
            </span>
          </span>
          <input
            ref="attachment_file_input"
            type="file"
            multiple
            class="hidden"
            @change="on_attachment_files_picked"
          >
          <Button
            size="small"
            severity="secondary"
            text
            label="上传图片 / 附件"
            :loading="upload_busy"
            :disabled="upload_busy"
            @click="attachment_file_input?.click()"
          >
            <template #icon>
              <MyIcon name="lucide:paperclip" />
            </template>
          </Button>
        </div>

        <div v-if="attachment_items.length" class="mt-4 columns-1 gap-3 md:columns-2">
          <MyContentAttachmentCard
            v-for="item in attachment_items"
            :key="item.key"
            :file="item.card"
            :delete_pending="item.kind === 'stored' && delete_attachment_pending === item.card.file_name"
            :delete_disabled="delete_attachment_pending !== null"
            :rename_disabled="! is_edit"
            :replace_disabled="replace_pending !== null"
            :retry_disabled="upload_busy"
            @preview="preview_image"
            @copy="item.kind === 'stored' && copy_attachment_code(item.attachment)"
            @rename="item.kind === 'stored' && is_edit && open_rename_dialog(item.attachment)"
            @replace="item.kind === 'stored' && is_edit && open_replace_dialog(item.attachment)"
            @delete="item.kind === 'stored' && confirm_delete_attachment($event, item.attachment)"
            @retry="item.kind === 'upload' && retry_upload(item.task)"
            @cancel="item.kind === 'upload' && cancel_upload(item.task)"
            @remove="item.kind === 'upload' && remove_upload(item.task.id)"
          />
        </div>

        <div v-else class="text-center text-sm text-slate-500 dark:text-slate-400">
          暂无附件
        </div>
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
import type { ContentStoryAttachment, ContentStoryDetail, ContentStorySummary } from '@shared/types/content'
import type MyContentMarkdownEditor from '~/components/MyContent/MarkdownEditor.vue'
import type { ContentDraftRecord } from '~/stores/contentDraft'
import type { AttachmentCardData, AttachmentUploadStatus } from '~/utils/content/attachment'
import { extract_attachment_names, link_file_name_illegal_chars, parse_story_markdown, rename_attachment_references, story_markdown_template } from '@shared/content-markdown'
import { sync_resource } from '@shared/types/sync'
import { storeToRefs } from 'pinia'
import { useContentDraftStore } from '~/stores/contentDraft'
import { content_attachment_markdown } from '~/utils/content/attachment-drag'
import { format_event_range } from '~/utils/content/event'

interface PendingAttachmentUpload {
  id: number
  file: File
  progress: number
  /** Measured upload speed in bytes per second. */
  speed: number
  status: AttachmentUploadStatus
  message: string | null
  controller: AbortController | null
  insert_position: number | null
}

type AttachmentListItem = {
  key: string
  card: AttachmentCardData
} & (
  | { kind: 'stored', attachment: ContentStoryAttachment }
  | { kind: 'upload', task: PendingAttachmentUpload }
)

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
const delete_attachment_pending = ref<string | null>(null)
const attachment_file_input = ref<HTMLInputElement>()
const attachment_drag_over = ref(false)
const markdown_editor = ref<InstanceType<typeof MyContentMarkdownEditor>>()
const pending_uploads = ref<PendingAttachmentUpload[]>([])
const upload_busy = ref(false)
const draft_conflict_visible = ref(false)
const pending_conflict_draft = ref<ContentDraftRecord | null>(null)
const discard_draft_pending = ref(false)
let next_upload_id = 1

const preview_visible = ref(false)
const preview_images = ref<string[]>([])

const active_upload_count = computed(() => pending_uploads.value.filter(upload => upload.status === 'queued' || upload.status === 'uploading').length)
const failed_upload_count = computed(() => pending_uploads.value.filter(upload => upload.status === 'error').length)
const draft_status_label = computed(() => {
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
const new_attachments = useState<ContentStoryAttachment[] | null>('content_orphan_attachments', () => null)
const new_attachments_loading = useState('content_orphan_attachments_loading', () => false)
const stored_attachments = computed(() => story.value?.attachments ?? new_attachments.value ?? [])

const header_cover_version = computed(() => {
  const cover = header_cover.value
  return cover && ! cover.includes('/') && ! cover.startsWith('#') && ! /^[a-z][\w+.-]*:/i.test(cover)
    ? (stored_attachments.value.find(item => item.file_name === cover)?.version ?? null)
    : null
})

const attachment_items = computed<AttachmentListItem[]>(() => {
  const items: AttachmentListItem[] = []
  const referenced = new Set(referenced_files.value)
  for (const attachment of stored_attachments.value) {
    items.push({
      key: `stored:${attachment.file_name}`,
      kind: 'stored',
      attachment,
      card: {
        ... attachment,
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
        file_name: task.file.name,
        mime_type: task.file.type || null,
        file_size: task.file.size,
        status: task.status,
        progress: task.progress,
        speed: task.speed,
        message: task.message,
      },
    })
  }
  return items.sort((a, b) => a.card.file_name.localeCompare(b.card.file_name, 'zh-CN'))
})

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
  await useSyncedData<ContentStoryAttachment[]>(
    computed(() => sync_resource('content_orphan_attachments', 'all')),
    () => content.list_orphan_attachments(),
    new_attachments,
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
          story.value = { ... story.value, attachments: latest_story.attachments }
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

function process_files_for_upload(files: File[], insert_position?: number | null) {
  if (! files.length)
    return

  const max_size_mb = config.max_content_attachment_size_mb
  const max_bytes = max_size_mb * 1024 * 1024
  const accepted: File[] = []
  for (const file of files) {
    if (file.size > max_bytes)
      error(`大大大！单个文件不能超过 ${max_size_mb} MB`)
    else
      accepted.push(file)
  }
  if (! accepted.length)
    return

  const uploads: PendingAttachmentUpload[] = accepted.map(file => reactive({
    id: next_upload_id ++,
    file,
    progress: 0,
    speed: 0,
    status: 'queued' as const,
    message: null,
    controller: null,
    insert_position: insert_position ?? null,
  }))
  pending_uploads.value.push(... uploads)
  void upload_queue(uploads)
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

function on_attachment_files_picked(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [... (input.files ?? [])]
  input.value = ''
  process_files_for_upload(files)
}

function on_attachment_drop(event: DragEvent) {
  attachment_drag_over.value = false
  const files = event.dataTransfer?.files ? [... event.dataTransfer.files] : []
  process_files_for_upload(files)
}

function on_editor_files_dropped(files: File[], position: number | null) {
  process_files_for_upload(files, position)
}

async function upload_queue(uploads: PendingAttachmentUpload[]) {
  upload_busy.value = true
  try {
    for (const upload of uploads) {
      if (upload.status === 'cancelled')
        continue
      await upload_attachment(upload)
    }
  }
  finally {
    upload_busy.value = false
  }
}

async function upload_attachment(upload: PendingAttachmentUpload) {
  const controller = new AbortController()
  upload.status = 'uploading'
  upload.progress = 0
  upload.speed = 0
  upload.message = null
  upload.controller = controller

  // Track bytes/time deltas to report a live transfer rate.
  let last_loaded = 0
  let last_stamp = performance.now()

  try {
    const attachment = await content.upload_attachment(story_id.value, upload.file, (progress, loaded) => {
      upload.progress = progress
      const now = performance.now()
      const elapsed = (now - last_stamp) / 1000
      if (elapsed >= 0.3 && loaded >= last_loaded) {
        upload.speed = (loaded - last_loaded) / elapsed
        last_loaded = loaded
        last_stamp = now
      }
    }, controller.signal)
    upload.progress = 100
    upload.status = 'completed'
    await new Promise(resolve => setTimeout(resolve, 250))
    if (story.value) {
      if (! story.value.attachments.some(item => item.file_name === attachment.file_name)) {
        story.value = {
          ... story.value,
          attachments: [... story.value.attachments, attachment],
        }
      }
    }
    else if (! new_attachments.value?.some(item => item.file_name === attachment.file_name)) {
      // The orphan-pool sync event may have already delivered this file.
      new_attachments.value = [... (new_attachments.value ?? []), attachment]
    }
    if (upload.insert_position !== null) {
      insert_attachment_markdown(attachment.file_name, attachment.is_image, upload.insert_position)
    }
    remove_upload(upload.id)
    ok(`『${attachment.file_name}』上传成功`)
  }
  catch (ex) {
    if (controller.signal.aborted) {
      remove_upload(upload.id)
      return
    }
    upload.status = 'error'
    upload.message = error_message(ex)
    error(ex)
  }
  finally {
    if (upload.controller === controller) {
      upload.controller = null
    }
  }
}

function retry_upload(upload: PendingAttachmentUpload) {
  void upload_queue([upload])
}

function cancel_upload(upload: PendingAttachmentUpload) {
  upload.status = 'cancelled'
  upload.controller?.abort()
  remove_upload(upload.id)
}

function remove_upload(id: number) {
  pending_uploads.value = pending_uploads.value.filter(upload => upload.id !== id)
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
    ok('已复制附件 Markdown 代码')
  }
  catch (ex) {
    error(ex)
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
  rename_file_name.value = attachment_stem(attachment.file_name)
  rename_visible.value = true
}

async function rename_attachment() {
  const target = rename_target.value
  const file_name = `${rename_file_name.value.trim()}${attachment_extension(target?.file_name ?? '')}`
  if (! target || ! file_name || rename_pending.value)
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
    ok('附件已重命名')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    rename_pending.value = false
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
    ok('附件已替换')
  }
  catch (ex) {
    error(ex)
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

  confirm_require(event, '确定要永久删除该未引用附件吗？', () => {
    void delete_attachment(attachment)
  }, {
    acceptProps: { severity: 'danger' },
  })
}

async function delete_attachment(attachment: ContentStoryAttachment) {
  if (is_referenced(attachment.file_name))
    return

  delete_attachment_pending.value = attachment.file_name
  try {
    if (! is_edit.value) {
      await content.delete_orphan_attachment(attachment.file_name)
      new_attachments.value = (new_attachments.value ?? []).filter(item => item.file_name !== attachment.file_name)
      ok('附件已删除')
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
    ok('附件已删除')
  }
  catch (ex) {
    if (get_error_status(ex) === 409 && await show_save_conflict()) {
      return
    }
    error(ex)
  }
  finally {
    delete_attachment_pending.value = null
  }
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
    const claim_files = (new_attachments.value ?? []).map(attachment => attachment.file_name)
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
