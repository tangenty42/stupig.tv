<template>
  <div class="space-y-6 pb-12 pt-8">
    <div v-if="! is_edit || story" class="space-y-6">
      <MyHeightSection tag="section" class="section-card-collapse">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="flex items-center gap-3">
            <Button text rounded aria-label="返回" @click="navigateTo('/content')">
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
        />
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
      档案不存在或已被删除。
    </div>

    <MyDialog
      v-if="is_edit"
      v-model:visible="confirm_delete_visible"
      header="确认永久删除以下附件？"
      :pending="save_pending"
      :closable="! save_pending"
    >
      <p class="mb-4 text-sm text-slate-600 dark:text-slate-400">
        保存后将从服务器上永久删除，不可恢复。
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
      <form id="rename-attachment-form" class="space-y-2" @submit.prevent="rename_attachment">
        <label for="rename-attachment-name" class="block text-sm font-medium">文件名</label>
        <InputText
          id="rename-attachment-name"
          v-model="rename_file_name"
          fluid
          maxlength="120"
          autofocus
          :disabled="rename_pending"
        />
      </form>

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
import type MyContentMarkdownEditor from '~/components/MyContent/MarkdownEditor.vue'
import type { ApiContentStoryAttachment, ApiContentStoryDetail } from '~/composables/useApi'
import type { AttachmentCardData, AttachmentUploadStatus } from '~/utils/content/attachment'
import { extract_attachment_names, parse_story_markdown, rename_attachment_references, story_markdown_template } from '@shared/content-markdown'
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
  | { kind: 'stored', attachment: ApiContentStoryAttachment }
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

const raw_id = computed(() => route.params.id as string)
const is_edit = computed(() => raw_id.value !== 'new')
const story_id = computed(() => is_edit.value ? Number(raw_id.value) : 0)

const story = useState<ApiContentStoryDetail | null>('content_story_detail', () => null)

const markdown = ref('')
const markdown_loaded = ref(false)
const save_pending = ref(false)
const delete_pending = ref(false)
const pending_delete_files = ref<string[]>([])
const confirm_delete_visible = ref(false)
const rename_visible = ref(false)
const rename_pending = ref(false)
const rename_target = ref<ApiContentStoryAttachment | null>(null)
const rename_file_name = ref('')
const delete_attachment_pending = ref<string | null>(null)
const attachment_file_input = ref<HTMLInputElement>()
const attachment_drag_over = ref(false)
const markdown_editor = ref<InstanceType<typeof MyContentMarkdownEditor>>()
const pending_uploads = ref<PendingAttachmentUpload[]>([])
const upload_busy = ref(false)
let next_upload_id = 1

const preview_visible = ref(false)
const preview_images = ref<string[]>([])

const active_upload_count = computed(() => pending_uploads.value.filter(upload => upload.status === 'queued' || upload.status === 'uploading').length)
const failed_upload_count = computed(() => pending_uploads.value.filter(upload => upload.status === 'error').length)

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
        card: { ...attachment, kind: 'stored', referenced: referenced.has(attachment.file_name) },
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

async function fetch_story(): Promise<ApiContentStoryDetail | null> {
  if (! is_edit.value)
    return null
  return await content.get_story(story_id.value)
}

// Avoid useSyncedData for such a edit page. We don't want to overwrite the editing content.
story.value = await fetch_story()

watch([story, is_edit], () => {
  if (markdown_loaded.value)
    return

  if (! is_edit.value) {
    markdown.value = story_markdown_template()
    markdown_loaded.value = true
    return
  }

  if (story.value) {
    markdown.value = story.value.markdown
    markdown_loaded.value = true
  }
}, { immediate: true })

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
  pending_uploads.value.push(...uploads)
  void upload_queue(uploads)
}

function on_attachment_files_picked(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  process_files_for_upload(files)
}

function on_attachment_drop(event: DragEvent) {
  attachment_drag_over.value = false
  const files = event.dataTransfer?.files ? [...event.dataTransfer.files] : []
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
        ...story.value,
        attachments: [...story.value.attachments, attachment],
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

function is_referenced(file_name: string): boolean {
  return referenced_files.value.includes(file_name)
}

function preview_image(url: string) {
  preview_images.value = [url]
  preview_visible.value = true
}

function open_rename_dialog(attachment: ApiContentStoryAttachment) {
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

function confirm_delete_attachment(event: Event, attachment: ApiContentStoryAttachment) {
  if (is_referenced(attachment.file_name))
    return

  confirm_require(event, '确定要永久删除该未引用附件吗？', () => {
    void delete_attachment(attachment)
  }, {
    acceptProps: { severity: 'danger' },
  })
}

async function delete_attachment(attachment: ApiContentStoryAttachment) {
  if (is_referenced(attachment.file_name))
    return

  delete_attachment_pending.value = attachment.file_name
  try {
    await content.delete_attachment(story_id.value, attachment.file_name, markdown.value)
    if (story.value) {
      story.value = {
        ...story.value,
        attachments: story.value.attachments.filter(item => item.file_name !== attachment.file_name),
      }
    }
    ok('附件已删除')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    delete_attachment_pending.value = null
  }
}

function on_save_click() {
  const { meta, issues } = parse_story_markdown(markdown.value)
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
    await content.update_story(story_id.value, {
      markdown: markdown.value,
      delete_files,
    })

    confirm_delete_visible.value = false
    ok('档案已保存')

    story.value = await fetch_story()
  }
  catch (ex) {
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

  confirm_require(event, '确定要删除整个档案吗？所有附件都会一起消失。', async () => {
    delete_pending.value = true
    try {
      await content.delete_story(story_id.value)
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
