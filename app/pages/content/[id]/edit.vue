<template>
  <div class="space-y-12 pb-12 pt-8">
    <div v-if="private_blocked" class="section-card-collapse py-12 text-center text-slate-500 dark:text-slate-400">
      这份档案包含机密内容，你没有机密内容的查看权限，无法编辑
    </div>

    <div v-else-if="! is_edit || story">
      <MyContentStoryHeader back :invalid="! header_meta" :title="header_title" :labels="header_labels" :desc="header_desc" :cover="header_cover" :cover-label="header_cover_label" :cover-url="header_cover_url" :cover-image="header_cover_image" :date="header_date" :story-id="is_edit ? story_id : null">
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
          ref="markdown_editor"
          v-model="markdown"
          :readonly="reference_rewrite_pending || ! tab_writable"
          :story-id="is_edit ? story!.id : null"
          :attachments="stored_attachments"
          :stories="existing_stories ?? []"
          :folders="folder_names"
          @files-dropped="on_editor_files_dropped"
          @files-pasted="on_editor_files_pasted"
          @attachment-drop-outside="on_attachment_drop_outside"
        >
          <template #diagnostics>
            <p v-if="! tab_writable" class="rounded-sm bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-800/50 dark:text-slate-300">
              {{ tab_lock_unavailable ? '当前浏览器不支持安全的多标签页草稿同步，请使用支持 Web Locks 的浏览器。' : '正在同步其他标签页的草稿；切回此页面后即可继续编辑。' }}
            </p>
            <div v-if="reference_review" class="shrink-0 rounded-sm border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300">
              <p v-if="reference_review.diagnostics.some(item => item.kind === 'story' && item.reason === 'replaced')">
                以下档案已被删除并同名重建，保存前需要确认：
              </p>
              <p v-for="item in reference_review.diagnostics.filter(item => item.kind === 'story' && item.reason === 'replaced')" :key="`${item.from}:${item.kind}`">
                第 {{ item.line }} 行：{{ item.target }}（目标已变更）
              </p>
              <p v-for="item in reference_review.diagnostics.filter(item => item.reason === 'missing')" :key="`${item.from}:${item.kind}`">
                第 {{ item.line }} 行：{{ item.target }}（目标不存在）
              </p>
              <Button label="确认当前引用目标" :disabled="! tab_writable || ! reference_review_can_confirm(reference_review)" size="small" text @click="confirm_reference_targets" />
            </div>
          </template>
          <template #toolbar-start>
            <div
              class="flex text-xs items-center gap-1"
              :class="draft_storage_error ? 'text-red-500 dark:text-red-400' : 'text-slate-500 dark:text-slate-400'"
            >
              <MyIcon
                :name="save_pending || reference_rewrite_pending ? 'lucide:loader-circle' : draft_storage_error ? 'lucide:circle-alert' : 'lucide:cloud-check'"
                class="mr-1 align-text-bottom"
                :class="{ 'animate-spin': save_pending || reference_rewrite_pending }"
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

    <div v-else class="section-card-collapse py-12 text-center text-slate-500 dark:text-slate-400">
      档案不存在或已被删除
    </div>

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

    <MyDialog
      v-model:visible="draft_conflict_visible"
      header="版本冲突"
    >
      <div class="space-y-3 text-sm text-slate-600 dark:text-slate-300">
        <p>这份自动保存的草稿基于较旧的数据库版本，继续编辑可能覆盖其他人已保存的修改！</p>
        <p v-if="pending_conflict_draft" class="text-xs text-slate-500 dark:text-slate-400">
          本地草稿保存于 {{ datetime_format(pending_conflict_draft.saved_at, time_context.timezone) }}
        </p>
      </div>

      <template #footer>
        <div class="flex flex-wrap justify-end gap-2">
          <Button label="取消" severity="secondary" text @click="draft_conflict_visible = false" />
          <Button label="使用数据库最新版" severity="secondary" text @click="use_database_version">
            <template #icon>
              <MyIcon name="lucide:check" />
            </template>
          </Button>
          <Button label="继续使用本地草稿" severity="warn" @click="restore_conflicting_draft">
            <template #icon>
              <MyIcon name="lucide:check" />
            </template>
          </Button>
        </div>
      </template>
    </MyDialog>

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
import type { ContentStoryBody, ContentStorySummary } from '@shared/types/content'
import type MyContentMarkdownEditor from '~/components/MyContent/Markdown/Editor.vue'
import type { AttachmentUploadPick } from '~/utils/content/attachment'
import { parse_story_markdown, story_markdown_template } from '@shared/content-markdown'
import { settings } from '@shared/settings'
import { sync_resource } from '@shared/types/sync'
import { storeToRefs } from 'pinia'
import { useContentDraftStore } from '~/stores/contentDraft'
import { content_attachment_drag_file_names, content_attachment_markdown, get_content_attachment_drag_data, get_content_folder_drag_data } from '~/utils/content/attachment-drag'
import { reference_review_can_confirm } from '~/utils/content/draft-reference-bridge'
import { format_event_range } from '~/utils/content/event'

definePageMeta({
  middleware: 'require-content-manage-auth',
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
const is_edit = computed(() => raw_id.value !== 'new')
const story_id = computed(() => is_edit.value ? Number(raw_id.value) : 0)
/** The draft this page instance owns; the store's key is bound to it at setup. */
const draft_story_id = is_edit.value ? story_id.value : null

const draft_store = useContentDraftStore(draft_story_id)
const { markdown } = storeToRefs(draft_store)

const attachment_panel = await useAttachmentPanel(story_id.value, () => markdown.value)
const attachment_workspace = attachment_panel.catalog

// Existing titles must reach the save/header validation too, or every `@ref`
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
  return meta ? format_event_range(meta.event_precision, meta.event_entries, time_context.value.timezone) : null
})

const markdown_editor = ref<InstanceType<typeof MyContentMarkdownEditor>>()
const stored_attachments = computed(() => attachment_workspace.data.value?.attachments ?? [])
const folder_names = computed(() => attachment_workspace.data.value?.folders ?? [])
const header_cover_url = computed(() => {
  const cover = header_cover.value
  return cover && ! cover.startsWith('#') && ! /^[a-z][\w+.-]*:/i.test(cover) && cover.split('/').every(Boolean)
    ? (stored_attachments.value.find(item => item.file_name === cover)?.url ?? null)
    : null
})

const header_cover_image = computed(() => stored_attachments.value.find(item => item.file_name === header_cover.value && item.url === header_cover_url.value)?.image)

const title_reference_version = useSyncedState<{ title_revision: number } | null>('content_title_reference_version', () => null)
const editing = useStoryEditSession({
  story_id: draft_story_id, draft_store, content, user, workspace: attachment_workspace.data, title_reference_version, markdown_editor,
  reference_sync_pending: () => attachment_panel.uploads.finalizing.size > 0 || attachment_workspace.loading.value,
  markdown_config: () => content_markdown_config.value,
  new_markdown: () => story_markdown_template(datetime_build_string(time_context.value.now_ms, '{YYYY}/{M}/{D}', time_context.value.timezone)),
  toast: { ok, error }, confirm_require,
})
const { story, private_blocked, page_disposed, draft_storage_error, draft_dirty,
  draft_status_label, save_pending, reference_rewrite_pending, tab_writable, tab_lock_unavailable, delete_pending, draft_conflict_visible, pending_conflict_draft, discard_draft_pending,
  reference_review, reference_history_warning_visible, confirm_reference_history_save, confirm_reference_targets, confirm_abandon_draft, use_database_version, restore_conflicting_draft,
  on_save_click, confirm_delete_story } = editing

await editing.load()
await useSyncedData(sync_resource('content_titles', 'all'), () => content.get_title_reference_version(), title_reference_version)
editing.initialize()

// Shared resource ownership stays on the page; the session applies draft-safe merges.
if (import.meta.client && is_edit.value) {
  await useSyncedData<ContentStoryBody | null>(
    computed(() => sync_resource('content_story', story_id.value)),
    editing.fetch_story,
    editing.synced_story,
    editing.story_sync_pending,
    { immediate: false, server: false, universal: false, on_error: () => {} },
  )
}

async function upload_picks(picks: AttachmentUploadPick[], position: number | null) {
  if (! is_edit.value)
    return error('请先保存档案')
  const owner = user.value?.id
  await attachment_panel.start(picks.map(pick => ({
    ... pick,
    on_landed(file) {
      if (position === null || page_disposed.value || user.value?.id !== owner)
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
