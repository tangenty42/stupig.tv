<template>
  <div
    class="attachment-card"
    :class="border_class"
    :draggable="stored !== null"
    @dragstart="on_dragstart"
  >
    <div class="attachment-card-content">
      <MyIcon
        :name="`lucide:${file_icon(props.file)}`"
        class="shrink-0 text-3xl text-slate-400 dark:text-slate-500"
      />
      <div class="attachment-card-details">
        <span class="truncate font-mono text-sm font-semibold" :title="props.file.file_name">{{ props.file.file_name }}</span>
        <span class="text-xs text-slate-500 dark:text-slate-400">
          {{ format_bytes(props.file.file_size) }}
        </span>

        <div v-if="upload && upload.status !== 'error'" class="mt-2 flex items-center gap-2">
          <ProgressBar
            :value="upload.progress"
            :show-value="false"
            class="h-1.5 min-w-0 flex-1"
          />
          <span class="shrink-0 text-xs text-slate-500 dark:text-slate-400">
            {{ upload_status_text }}
          </span>
        </div>
        <span v-else-if="upload" class="mt-1.5 text-xs text-red-600 dark:text-red-400">
          上传失败：{{ upload.message }}
        </span>

        <span
          v-if="stored && ! stored.referenced"
          class="mt-1.5 inline-flex flex-wrap items-center gap-2 text-xs text-red-600 dark:text-red-400"
        >
          <span>未引用，保存时将删除，或</span>
          <Button
            size="small"
            severity="danger"
            label="立即删除"
            class="shrink-0 !px-1.5 !py-1 !text-xs"
            :loading="props.delete_pending"
            :disabled="props.delete_disabled"
            @click="emit('delete', $event)"
          />
        </span>
      </div>
      <div class="attachment-card-actions">
        <template v-if="stored">
          <Button
            v-if="stored.is_image"
            text
            severity="secondary"
            aria-label="预览"
            @click="emit('preview', static_url(stored.url))"
          >
            <template #icon>
              <MyIcon name="lucide:eye" />
            </template>
          </Button>
          <Button text severity="secondary" aria-label="重命名" @click="emit('rename')">
            <template #icon>
              <MyIcon name="lucide:pencil" />
            </template>
          </Button>
          <Button
            text
            severity="secondary"
            as="a"
            :href="static_url(stored.url)"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="打开"
          >
            <template #icon>
              <MyIcon name="lucide:external-link" />
            </template>
          </Button>
        </template>

        <template v-else-if="upload">
          <Button
            v-if="upload.status === 'error'"
            text
            severity="secondary"
            aria-label="重试上传"
            :disabled="props.retry_disabled"
            @click="emit('retry')"
          >
            <template #icon>
              <MyIcon name="lucide:rotate-cw" />
            </template>
          </Button>
          <Button
            v-if="upload.status === 'queued' || upload.status === 'uploading'"
            text
            severity="secondary"
            aria-label="取消上传"
            @click="emit('cancel')"
          >
            <template #icon>
              <MyIcon name="lucide:x" />
            </template>
          </Button>
          <Button
            v-else
            text
            severity="secondary"
            aria-label="移除上传任务"
            @click="emit('remove')"
          >
            <template #icon>
              <MyIcon name="lucide:x" />
            </template>
          </Button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AttachmentCardData } from '~/utils/content/attachment'
import { file_icon } from '~/utils/content/attachment'
import { set_content_attachment_drag_data } from '~/utils/content/attachment-drag'

interface Props {
  file: AttachmentCardData
  delete_pending?: boolean
  delete_disabled?: boolean
  retry_disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  delete_pending: false,
  delete_disabled: false,
  retry_disabled: false,
})

const emit = defineEmits<{
  preview: [url: string]
  rename: []
  delete: [event: MouseEvent]
  retry: []
  cancel: []
  remove: []
}>()

const static_url = useStaticUrl()

const stored = computed(() => props.file.kind === 'stored' ? props.file : null)
const upload = computed(() => props.file.kind === 'upload' ? props.file : null)

const border_class = computed(() => {
  if (upload.value) {
    return upload.value.status === 'error'
      ? 'border-red-300 dark:border-red-800'
      : 'border-primary'
  }
  return stored.value?.referenced
    ? 'border-slate-200 dark:border-slate-700'
    : 'border-red-300 dark:border-red-800'
})

const upload_status_text = computed(() => {
  const current = upload.value
  if (! current)
    return ''
  if (current.status === 'queued')
    return '等待上传'
  if (current.status === 'completed')
    return '上传完成'
  if (current.status === 'uploading')
    return current.progress >= 95 ? '服务器处理中' : `${current.progress} %`
  return ''
})

function on_dragstart(event: DragEvent) {
  if (stored.value)
    set_content_attachment_drag_data(event, stored.value)
}
</script>

<style scoped>
.attachment-card {
  @apply mb-3 flex w-full min-w-0 break-inside-avoid flex-col rounded-sm border bg-white p-3 dark:bg-slate-900;
}

.attachment-card-content {
  @apply flex min-w-0 items-center gap-3;
}

.attachment-card-details {
  @apply flex min-w-0 flex-1 flex-col;
}

.attachment-card-actions {
  @apply flex shrink-0 items-center;
}

.attachment-card-actions :deep(.iconify) {
  @apply text-slate-400 dark:text-slate-500;
}
</style>
