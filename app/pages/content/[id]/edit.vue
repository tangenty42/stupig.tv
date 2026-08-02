<template>
  <div class="space-y-6 pb-12 pt-8">
    <div v-if="! is_edit || story" class="space-y-6">
      <MyHeightSection tag="section" class="section-card-collapse">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="flex items-center gap-3">
            <Button text aria-label="返回" @click="navigateTo('/content')">
              <template #icon>
                <MyIcon name="lucide:arrow-left" />
              </template>
            </Button>
            <h1>{{ is_edit ? story!.title : '新建档案' }}</h1>
          </div>
          <div v-if="is_edit" class="flex items-center gap-2">
            <Button
              severity="danger"
              text
              size="small"
              label="删除档案"
              :loading="delete_pending"
              @click="confirm_delete_story"
            >
              <template #icon>
                <MyIcon name="lucide:trash-2" />
              </template>
            </Button>
          </div>
        </div>
      </MyHeightSection>

      <MyHeightSection tag="section" class="section-card-collapse">
        <MyContentMarkdownEditor
          ref="markdown_editor"
          v-model="markdown"
          :story-id="is_edit ? story!.id : null"
          :attachments="story?.attachments ?? []"
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
                v-if="is_edit && draft_dirty"
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
        </MyContentMarkdownEditor>
      </MyHeightSection>

      <MyHeightSection
        v-if="is_edit && story"
        tag="section"
        class="section-card-collapse transition-colors"
        @dragover.prevent="attachment_drag_over = true"
        @dragleave.prevent="attachment_drag_over = false"
        @drop.prevent="on_attachment_drop"
      >
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2>附件</h2>
          <div class="flex items-center gap-3">
            <span class="text-xs text-slate-500 dark:text-slate-400">
              共 {{ story.attachments.length }} 个
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
        </div>

        <div v-if="attachment_items.length" class="columns-1 gap-3 md:columns-2">
          <MyContentAttachmentCard
            v-for="item in attachment_items"
            :key="item.key"
            :file="item.card"
            :delete-pending="item.kind === 'stored' && delete_attachment_pending === item.card.file_name"
            :delete-disabled="delete_attachment_pending !== null"
            :retry-disabled="upload_busy"
            @preview="preview_image"
            @rename="item.kind === 'stored' && open_rename_dialog(item.attachment)"
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

      <MyHeightSection tag="section" class="section-card-collapse">
        <div class="flex justify-end gap-3">
          <Button
            severity="secondary"
            text
            label="返回"
            :disabled="save_pending"
            @click="navigateTo('/content')"
          />
          <Button
            :label="is_edit ? '保存' : '创建'"
            :loading="save_pending"
            :disabled="save_pending"
            @click="on_save_click"
          >
            <template #icon>
              <MyIcon :name="is_edit ? 'lucide:save' : 'lucide:check'" />
            </template>
          </Button>
        </div>
      </MyHeightSection>
    </div>

    <div v-else class="section-card py-12 text-center text-slate-500 dark:text-slate-400">
      档案不存在或已被删除
    </div>

    <MyDialog
      v-model:visible="draft_conflict_visible"
      header="版本冲突"
    >
      <div class="space-y-3 text-sm text-slate-600 dark:text-slate-300">
        <p>这份自动保存的草稿基于较早的数据库版本，继续编辑可能覆盖其他人已保存的修改！</p>
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
      v-model:visible="confirm_delete_visible"
      header="确认永久删除以下附件？"
      :pending="save_pending"
      :closable="! save_pending"
    >
      <p class="mb-4 text-sm text-slate-600 dark:text-slate-400">
        保存后将从服务器上永久删除，不可恢复
      </p>
      <ul class="mb-4 list-inside list-disc text-sm">
        <li v-for="a in pending_delete_files" :key="a">
          {{ a }}
        </li>
      </ul>

      <template #footer>
        <div class="flex justify-end gap-2">
          <Button label="取消" severity="secondary" text :disabled="save_pending" @click="confirm_delete_visible = false" />
          <Button label="确认保存并删除" :loading="save_pending" :disabled="save_pending" @click="() => do_save(pending_delete_files)">
            <template #icon>
              <MyIcon name="lucide:trash-2" />
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
        <label for="rename-attachment-name" class="block text-sm font-medium">文件名</label>
        <InputText
          id="rename-attachment-name"
          v-model="rename_file_name"
          fluid
          maxlength="120"
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

    <ClientOnly>
      <MyImagePreview
        v-if="is_edit"
        v-model:visible="preview_visible"
        :images="preview_images"
        :initial-index="0"
      />
    </ClientOnly>
  </div>
</template>

<script setup lang="ts">
import type { ContentStoryAttachment, ContentStoryDetail } from '@shared/types/content'
import type MyContentMarkdownEditor from '~/components/MyContent/MarkdownEditor.vue'
import type { ContentDraftRecord } from '~/stores/contentDraft'
import type { AttachmentCardData, AttachmentUploadStatus } from '~/utils/content/attachment'
import { extract_attachment_names, parse_story_markdown, rename_attachment_references, story_markdown_template } from '@shared/content-markdown'
import { storeToRefs } from 'pinia'
import { useContentDraftStore } from '~/stores/contentDraft'
import { content_attachment_markdown } from '~/utils/content/attachment-drag'

interface PendingAttachmentUpload {
  id: number
  file: File
  progress: number
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
})

const route = useRoute()
const { content } = useApi()
const { ok, error } = useMyToast()
const { confirm_require } = useMyConfirm()
const runtime_config = useRuntimeConfig()
const content_markdown_config = useContentMarkdownConfig()
const draft_store = useContentDraftStore()
const {
  markdown,
  base_updated_at,
  draft_saved_at,
  autosave_pending: draft_autosave_pending,
  storage_error: draft_storage_error,
  dirty: draft_dirty,
} = storeToRefs(draft_store)

const raw_id = computed(() => route.params.id as string)
const is_edit = computed(() => raw_id.value !== 'new')
const story_id = computed(() => is_edit.value ? Number(raw_id.value) : 0)

const story = useState<ContentStoryDetail | null>('content_story_detail', () => null)

const save_pending = ref(false)
const delete_pending = ref(false)
const pending_delete_files = ref<string[]>([])
const confirm_delete_visible = ref(false)
const rename_visible = ref(false)
const rename_pending = ref(false)
const rename_target = ref<ContentStoryAttachment | null>(null)
const rename_file_name = ref('')
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
    return '正在保存...'
  if (draft_dirty.value && draft_saved_at.value)
    return '草稿已保存'
  if (draft_dirty.value)
    return '草稿待保存'
  return ''
})

const referenced_files = computed(() => {
  if (! story.value || ! is_edit.value)
    return []
  return extract_attachment_names(markdown.value)
})

const trash_attachments = computed(() => {
  if (! story.value || ! is_edit.value)
    return []
  const set = new Set(referenced_files.value)
  return story.value.attachments.filter(a => ! set.has(a.file_name))
})

const attachment_items = computed<AttachmentListItem[]>(() => {
  const items: AttachmentListItem[] = []
  if (story.value) {
    const referenced = new Set(referenced_files.value)
    for (const attachment of story.value.attachments) {
      items.push({
        key: `stored:${attachment.file_name}`,
        kind: 'stored',
        attachment,
        card: { ... attachment, kind: 'stored', referenced: referenced.has(attachment.file_name) },
      })
    }
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
        message: task.message,
      },
    })
  }
  return items
})

async function fetch_story() {
  if (! is_edit.value)
    return null
  return await content.get_story(story_id.value)
}

// Avoid useSyncedData for such a edit page. We don't want to overwrite the editing content.
story.value = await fetch_story()

const initial_markdown = is_edit.value
  ? (story.value?.markdown ?? '')
  : story_markdown_template(content_markdown_config)
const initial_updated_at = is_edit.value ? (story.value?.updated_at ?? null) : null
const draft_story_id = is_edit.value ? story_id.value : null

draft_store.initialize(draft_story_id, initial_markdown, initial_updated_at)

onMounted(() => {
  window.addEventListener('pagehide', persist_draft_on_page_hide)

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
  draft_store.persist_now()
})

function persist_draft_on_page_hide() {
  draft_store.persist_now()
}

function use_database_version() {
  pending_conflict_draft.value = null
  draft_conflict_visible.value = false
  draft_store.discard()
  draft_store.initialize(draft_story_id, story.value?.markdown ?? initial_markdown, story.value?.updated_at ?? initial_updated_at)
}

function confirm_abandon_draft(event: Event) {
  if (! is_edit.value || discard_draft_pending.value)
    return

  confirm_require(event, '确定要舍弃本地草稿，并恢复为数据库最新版本吗？', abandon_draft)
}

async function abandon_draft() {
  if (! is_edit.value || discard_draft_pending.value)
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
    story.value?.updated_at ?? initial_updated_at,
  )
  pending_conflict_draft.value = null
  draft_conflict_visible.value = false
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

  if (! is_edit.value) {
    error('请先保存新建档案，再上传附件')
    return
  }

  const max_size_mb = runtime_config.public.max_content_attachment_size_mb as number
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

  const uploads = accepted.map(file => ({
    id: next_upload_id ++,
    file,
    progress: 0,
    status: 'queued' as const,
    message: null,
    controller: null,
    insert_position: insert_position ?? null,
  }))
  pending_uploads.value.push(... uploads)
  void upload_queue(uploads)
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
  upload.message = null
  upload.controller = controller

  try {
    const attachment = await content.upload_attachment(story_id.value, upload.file, (progress) => {
      upload.progress = progress
    }, controller.signal)
    upload.progress = 100
    upload.status = 'completed'
    await new Promise(resolve => setTimeout(resolve, 250))
    if (story.value && ! story.value.attachments.some(item => item.file_name === attachment.file_name)) {
      story.value = {
        ... story.value,
        attachments: [... story.value.attachments, attachment],
      }
    }
    if (upload.insert_position !== null) {
      const text = content_attachment_markdown(attachment)
      if (markdown_editor.value) {
        markdown_editor.value.insert_at_position(text, upload.insert_position)
      }
      else {
        const needs_newline = markdown.value.length > 0 && ! markdown.value.endsWith('\n')
        markdown.value += `${needs_newline ? '\n' : ''}${text}`
      }
    }
    remove_upload(upload.id)
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

function open_rename_dialog(attachment: ContentStoryAttachment) {
  rename_target.value = attachment
  rename_file_name.value = attachment.file_name
  rename_visible.value = true
}

async function rename_attachment() {
  const target = rename_target.value
  const file_name = rename_file_name.value.trim()
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
      draft_store.advance_base(story.value.markdown, story.value.updated_at)
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
    if (! base_updated_at.value) {
      throw new Error('缺少档案基础版本，请刷新页面后重试')
    }
    await content.delete_attachment(story_id.value, attachment.file_name, markdown.value, base_updated_at.value)
    story.value = await fetch_story()
    if (story.value) {
      draft_store.advance_base(story.value.markdown, story.value.updated_at)
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
  const { meta, issues } = parse_story_markdown(markdown.value, content_markdown_config)
  if (! meta) {
    error(issues[0]?.message ?? '档案格式不正确')
    return
  }

  if (! is_edit.value) {
    void do_create()
    return
  }

  const trash = trash_attachments.value.map(a => a.file_name)
  if (trash.length) {
    pending_delete_files.value = trash
    confirm_delete_visible.value = true
  }
  else {
    void do_save([])
  }
}

async function do_create() {
  save_pending.value = true
  try {
    const result = await content.create_story(markdown.value)

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

async function do_save(delete_files: string[]) {
  save_pending.value = true
  try {
    if (! base_updated_at.value) {
      throw new Error('缺少档案基础版本，请刷新页面后重试')
    }
    await content.update_story(story_id.value, {
      markdown: markdown.value,
      delete_files,
      base_updated_at: base_updated_at.value,
    })

    confirm_delete_visible.value = false
    story.value = await fetch_story()
    if (story.value) {
      draft_store.mark_saved(story.value.markdown, story.value.updated_at)
    }
    ok('档案已保存')
  }
  catch (ex) {
    if (get_error_status(ex) === 409 && await show_save_conflict()) {
      confirm_delete_visible.value = false
      return
    }
    error(ex)
  }
  finally {
    save_pending.value = false
    pending_delete_files.value = []
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
