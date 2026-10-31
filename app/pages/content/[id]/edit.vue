<template>
  <div class="space-y-12 pb-12 pt-8">
    <div v-if="private_blocked" class="section-card-collapse py-12 text-center text-slate-500 dark:text-slate-400">
      编辑云端草稿需要档案管理和机密读取权限
    </div>

    <div v-else-if="cloud">
      <MyContentStoryHeader back :invalid="! header_meta" :title="header_title" :labels="header_labels" :desc="header_desc" :cover="header_cover" :cover-label="header_cover_label" :cover-url="header_cover_url" :cover-image="header_cover_image" :date="header_date" :story-id="is_edit ? story_id : null">
        <template #actions>
          <Button
            severity="danger"
            text
            size="small"
            label="删除"
            :loading="delete_pending"
            :disabled="delete_pending || ! tab_writable"
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
            :disabled="save_pending || reference_rewrite_pending || ! tab_writable"
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
          :key="editor_session_key"
          ref="markdown_editor"
          v-model="markdown"
          :readonly="reference_rewrite_pending || ! tab_writable"
          :allow-write="draft_store.can_write_now"
          :story-id="is_edit ? story_id : null"
          :attachments="stored_attachments"
          :stories="existing_stories ?? []"
          :folders="folder_names"
          @files-dropped="on_editor_files_dropped"
          @files-pasted="on_editor_files_pasted"
          @attachment-drop-outside="on_attachment_drop_outside"
        >
          <template #toolbar-start>
            <div
              class="flex text-xs items-center gap-1"
              :class="draft_storage_error || (! tab_writable && tab_lock_unavailable) ? 'text-red-500 dark:text-red-400' : 'text-slate-500 dark:text-slate-400'"
            >
              <MyIcon
                :name="draft_storage_error || (! tab_writable && tab_lock_unavailable) ? 'lucide:circle-alert' : save_pending || reference_rewrite_pending || ! tab_writable ? 'lucide:loader-circle' : 'lucide:cloud-check'"
                class="mr-1 align-text-bottom"
                :class="{ 'animate-spin': ! draft_storage_error && ! tab_lock_unavailable && (save_pending || reference_rewrite_pending || ! tab_writable) }"
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
                :disabled="discard_draft_pending || ! tab_writable"
                @click="confirm_abandon_draft"
              />
            </div>
          </template>
          <template #attachments>
            <MyContentAttachmentWorkspace v-if="is_edit" :controller="attachment_panel" :dialogs="false" layout="stack" class="h-full" />
            <div v-else class="py-10 text-center text-sm text-slate-400 dark:text-slate-500">
              创建档案后即可上传附件
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
      >
        <MyContentAttachmentWorkspace v-if="is_edit" :controller="attachment_panel" />
        <div v-else class="py-10 text-center text-sm text-slate-400 dark:text-slate-500">
          创建档案后即可上传附件
        </div>
      </MyHeightSection>
    </div>

    <div v-else class="section-card-collapse flex flex-col items-center gap-4 py-12 text-center text-slate-500 dark:text-slate-400" role="status">
      <MyIcon name="lucide:loader-circle" size="3rem" class="animate-spin" />
      正在连接云端草稿，或草稿已不可访问
    </div>

    <MyContentDeleteImpact
      v-model:visible="delete_visible" description="确认删除整个档案？所有附件都会一起消失。" :impact="delete_impact"
      :loading="delete_impact_loading" :failure="delete_impact_failure" :pending="delete_pending" :disabled="! tab_writable" @retry="load_delete_impact" @confirm="delete_story_confirmed"
    />

    <MyDialog v-model:visible="reference_history_warning_visible" header="引用历史不可用" :pending="save_pending">
      <p class="text-sm text-slate-600 dark:text-slate-300">
        这份草稿的部分引用历史已不可用，无法自动更新这段时间内变化的引用。请核对当前正文中的引用，确认后将按当前内容继续保存
      </p>
      <template #footer>
        <Button label="取消" severity="secondary" text :disabled="save_pending" @click="reference_history_warning_visible = false" />
        <Button label="继续保存" :loading="save_pending" :disabled="save_pending || reference_rewrite_pending || ! tab_writable" @click="confirm_reference_history_save">
          <template #icon>
            <MyIcon name="lucide:check" />
          </template>
        </Button>
      </template>
    </MyDialog>

    <div v-if="recovery" class="section-card-collapse mt-6" role="status">
      <p>编辑权已变更，以下修改未上传。可复制保留；关闭本页后将消失。</p>
      <Textarea :model-value="recovery" readonly class="mt-3 w-full" rows="8" aria-label="未上传修改恢复区" />
      <Button label="关闭恢复区" text @click="draft_store.recovery = ''" />
    </div>

    <MyDialog v-model:visible="paste_visible" header="命名">
      <InputText v-model="paste_name" class="w-full" aria-label="附件名称" @keydown.enter="submit_paste" />
      <template #footer>
        <Button label="取消" severity="secondary" text @click="paste_visible = false" />
        <Button label="上传" @click="submit_paste">
          <template #icon>
            <MyIcon name="lucide:check" />
          </template>
        </Button>
      </template>
    </MyDialog>
  </div>
</template>

<script setup lang="ts">
import type { ContentStoryMeta } from '@shared/content-markdown'
import type { ContentStorySummary } from '@shared/types/content'
import type MyContentMarkdownEditor from '~/components/MyContent/Markdown/Editor.vue'
import type { AttachmentUploadPick } from '~/utils/content/attachment'
import { parse_story_markdown, story_markdown_template } from '@shared/content-markdown'
import { content_name_key } from '@shared/content-reference'
import { settings } from '@shared/settings'
import { sync_resource } from '@shared/types/sync'
import { storeToRefs } from 'pinia'
import { useContentDraftStore } from '~/stores/contentDraft'
import { content_attachment_drag_file_names, content_attachment_markdown, get_content_attachment_drag_data, get_content_folder_drag_data } from '~/utils/content/attachment-drag'
import { format_event_range } from '~/utils/content/event'

definePageMeta({
  middleware: 'require-content-draft-auth',
  // Remount per story id: setup (story fetch, draft-store init/restore, sync
  // subscriptions) assumes a fresh instance — a reused one would carry the
  // previous story's draft into the create page (and vice versa).
  key: route => route.path,
})

const route = useRoute()
const { content } = useApi()
const { user } = useAuth()
const time_context = useDisplayTimeContext()
const { ok, error } = useMyToast()
const { confirm_require } = useMyConfirm()
// Known stories for `@story` completion, duplicate-title and dead-reference
// lints; kept in sync via the shared content_stories resource without touching
// the editing content.
const existing_stories = useSyncedState<ContentStorySummary[] | null>('content_stories', () => null)
const existing_stories_loading = useState('content_stories_loading', () => false)
await useSyncedData<ContentStorySummary[]>(
  sync_resource('content_stories', 'all'),
  () => content.list_stories(),
  existing_stories,
  existing_stories_loading,
)
const raw_id = computed(() => route.params.id as string)
const cloud_draft_id = /^draft-[a-f0-9]{32}$/.test(raw_id.value) ? raw_id.value.slice(6) : undefined
const is_edit = computed(() => ! cloud_draft_id && raw_id.value !== 'new')
const story_id = computed(() => is_edit.value ? Number(raw_id.value) : 0)
/** The draft this page instance owns; the store's key is bound to it at setup. */
const draft_story_id = is_edit.value ? story_id.value : null

const draft_store = useContentDraftStore(cloud_draft_id ?? draft_story_id)
const { markdown } = storeToRefs(draft_store)

const attachment_panel = await useAttachmentPanel(story_id.value, () => markdown.value)
const attachment_workspace = attachment_panel.catalog

// Existing titles must reach the save/header validation too, or every `content://` reference
// is flagged as dead (undefined existing_titles → `! undefined?.some()` is true).
const content_markdown_config = computed(() => ({
  title_max_length: settings.app.content.story.titleMaxLength,
  label_max_bytes: settings.app.content.story.labelMaxBytes,
  desc_max_bytes: settings.app.content.story.descMaxBytes,
  cover_max_bytes: settings.app.content.story.coverMaxBytes,
  markdown_max_bytes: settings.app.content.story.markdownMaxBytes,
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

useHead({ title: '蠢猪档案 - 编辑' })

useSeoMeta({ robots: 'noindex, nofollow' })
const header_labels = computed(() => header_meta.value?.labels ?? [])
const header_desc = computed(() => header_meta.value?.desc ?? null)
const header_cover = computed(() => header_meta.value?.cover ?? null)
const header_cover_label = computed(() => header_meta.value?.cover_label ?? null)
const header_date = computed(() => {
  const meta = header_meta.value
  return meta ? format_event_range(meta.event_precision, meta.event_entries, time_context.value.timezone) : null
})

const markdown_editor = ref<InstanceType<typeof MyContentMarkdownEditor>>()
const stored_attachments = computed(() => attachment_workspace.data.value?.attachments ?? [])
const folder_names = computed(() => attachment_workspace.data.value?.folders ?? [])
const header_cover_url = computed(() => {
  const cover = header_cover.value
  return cover && ! cover.startsWith('#') && ! /^[a-z][\w+.-]*:/i.test(cover) && cover.split('/').every(Boolean)
    ? (stored_attachments.value.find(item => content_name_key(item.file_name) === content_name_key(cover))?.url ?? null)
    : null
})

const header_cover_image = computed(() => stored_attachments.value.find(item => content_name_key(item.file_name) === content_name_key(header_cover.value ?? '') && item.url === header_cover_url.value)?.image)

const title_reference_version = useSyncedState<{ title_revision: number } | null>('content_title_reference_version', () => null)
const editing = useStoryEditSession({
  story_id: draft_story_id, draft_id: cloud_draft_id, draft_store, content, user, workspace: attachment_workspace.data, title_reference_version, markdown_editor,
  reference_sync_pending: () => attachment_panel.uploads.finalizing.size > 0 || attachment_workspace.loading.value,
  markdown_config: () => content_markdown_config.value,
  new_markdown: () => story_markdown_template(datetime_build_string(time_context.value.now_ms, '{YYYY}/{M}/{D}', time_context.value.timezone)),
  toast: { ok, error }, confirm_require,
})
const { cloud, private_blocked, page_disposed, editor_session_key, draft_storage_error, draft_dirty,
  draft_status_label, save_pending, reference_rewrite_pending, tab_writable, tab_lock_unavailable, delete_pending, discard_draft_pending,
  reference_history_warning_visible, confirm_reference_history_save, confirm_abandon_draft,
  on_save_click, confirm_delete_story, delete_visible, delete_impact, delete_impact_loading, delete_impact_failure, load_delete_impact, delete_story_confirmed, recovery } = editing

watch(() => draft_store.phase, (phase) => {
  if (phase === 'forbidden')
    last_valid_meta.value = null
})
if (import.meta.client)
  await useSyncedData(sync_resource('content_titles', 'all'), () => content.get_title_reference_version(), title_reference_version, { server: false })

async function upload_picks(picks: AttachmentUploadPick[], position: number | null) {
  if (! is_edit.value)
    return error('请先保存档案')
  const owner = user.value?.id
  const may_insert = draft_store.capture_write_permit()
  await attachment_panel.start(picks.map(pick => ({
    ... pick,
    on_landed(file) {
      if (position === null || page_disposed.value || user.value?.id !== owner || ! may_insert())
        return
      const text = content_attachment_markdown(file)
      if (markdown_editor.value)
        markdown_editor.value.insert_at_position(text, position)
    },
  })))
}

function on_editor_files_dropped(picks: AttachmentUploadPick[], position: number | null) {
  void upload_picks(picks, position)
}

const paste_visible = ref(false)
const paste_name = ref('')
let paste_pick: { pick: AttachmentUploadPick, position: number | null } | null = null
watch(editor_session_key, () => {
  paste_pick = null
  paste_visible.value = false
  paste_name.value = ''
}, { flush: 'sync' })
function on_editor_files_pasted(picks: AttachmentUploadPick[], position: number | null) {
  if (picks.length !== 1)
    return void upload_picks(picks, position)
  paste_pick = { pick: picks[0]!, position }
  paste_name.value = picks[0]!.file_name
  paste_visible.value = true
}
function submit_paste() {
  const held = paste_pick
  paste_visible.value = false
  paste_pick = null
  if (held)
    void upload_picks([{ ... held.pick, file_name: paste_name.value }], held.position)
}
function on_attachment_drop_outside(event: DragEvent) {
  const folder = get_content_folder_drag_data(event.dataTransfer)
  const file = get_content_attachment_drag_data(event.dataTransfer)
  const names = folder ? [folder.folder, ... folder.file_names ?? []] : file ? content_attachment_drag_file_names(file) : []
  const targets = (attachment_workspace.data.value?.nodes ?? [])
    .filter(node => names.includes(node.path) && node.parent_id !== attachment_panel.root_id.value)
    .map(node => ({ id: node.id, version: node.version }))
  if (targets.length)
    void attachment_panel.execute({ operation: 'move', targets, parent_id: attachment_panel.root_id.value })
}
</script>
