<template>
  <div class="space-y-12 pb-12 pt-8">
    <div v-if="private_blocked" class="section-card-collapse py-12 text-center text-slate-500 dark:text-slate-400">
      编辑云端草稿需要『蠢猪档案·完全』权限
    </div>

    <!-- Animate entry when a draft becomes available. Clear its content immediately on loss of access. -->
    <Transition v-else name="site-page" :mode="cloud ? 'out-in' : undefined" :css="!! cloud">
      <div v-if="cloud" key="ready">
        <div :key="`edit-${editor_session_key}`">
          <MyContentStoryHeader back :invalid="! header_meta" :title="header_title" :labels="header_labels" :desc="header_desc" :cover="header_cover" :cover-label="header_cover_label" :cover-url="header_cover_url" :cover-image="header_cover_image" :date="header_date" :story-id="is_edit ? story_id : null">
            <template #actions>
              <Button
                v-if="is_edit"
                severity="danger"
                text
                size="small"
                label="删除"
                :loading="delete_pending || delete_impact_loading"
                :disabled="delete_pending || delete_impact_loading || ! tab_writable"
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
              :history-key="cloud.lease_epoch"
              :readonly="! tab_writable"
              :allow-write="can_write_now"
              :story-id="is_edit ? story_id : null"
              :view-state-key="user && cloud ? `${user.id}:${cloud.id}` : null"
              :attachments="stored_attachments"
              :attachments-failure="attachments_completion_failure"
              :stories="existing_stories ?? []"
              :stories-failure="stories_completion_failure"
              :folders="folder_names"
              :referenced-paths="referenced_paths"
              @files-dropped="on_editor_files_dropped"
              @files-pasted="on_editor_files_pasted"
              @attachment-drop-outside="on_attachment_drop_outside"
            >
              <template #toolbar-start>
                <div
                  class="flex text-xs items-center gap-1"
                  :class="draft_storage_error ? 'text-red-500 dark:text-red-400' : 'text-slate-500 dark:text-slate-400'"
                >
                  <MyIcon
                    :name="draft_storage_error ? 'lucide:circle-alert' : save_pending || reference_rewrite_pending || ! tab_writable ? 'lucide:loader-circle' : 'lucide:cloud-check'"
                    class="mr-1 align-text-bottom"
                    :class="{ 'animate-spin': ! draft_storage_error && (save_pending || reference_rewrite_pending || ! tab_writable) }"
                  />
                  <span>{{ draft_status_label }}</span>
                  <Button
                    v-if="(draft_dirty || ! is_edit) && ! save_pending"
                    label="舍弃草稿"
                    size="small"
                    text
                    severity="danger"
                    class="!px-1.5 !py-1 !text-xs"
                    :disabled="! tab_writable"
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
      </div>

      <MyContentListLoadError v-else-if="draft_open_error === 'failed'" key="load-failed" class="section-card-collapse py-12" @retry="retry_draft_open" />
      <div v-else-if="draft_open_error" key="unavailable" class="section-card-collapse py-12 text-center text-slate-500 dark:text-slate-400">
        {{ draft_open_error === 'forbidden' ? '当前身份无权访问云端草稿' : '云端草稿不存在或已被删除' }}
      </div>
      <div v-else key="loading" class="section-card-collapse flex flex-col items-center gap-4 py-12 text-center text-slate-500 dark:text-slate-400" role="status">
        <MyIcon name="lucide:loader-circle" size="3rem" class="animate-spin" />
        正在连接云端草稿……
      </div>
    </Transition>

    <MyContentDeleteImpact
      v-model:visible="delete_visible" :impact="delete_impact"
      :pending="delete_pending" :disabled="! tab_writable" @confirm="delete_story_confirmed"
    />

    <MyDialog v-model:visible="reference_history_warning_visible" header="引用历史不可用" :pending="save_pending">
      <p class="text-sm text-slate-600 dark:text-slate-300">
        这份草稿的部分引用历史已不可用，无法自动更新这段时间内变化的引用。请核对当前正文中的引用，确认后将按当前内容继续保存
      </p>
      <template #footer>
        <Button label="继续保存" :loading="save_pending" :disabled="save_pending || reference_rewrite_pending || ! tab_writable" @click="confirm_reference_history_save">
          <template #icon>
            <MyIcon name="lucide:check" />
          </template>
        </Button>
      </template>
    </MyDialog>

    <MyDialog v-model:visible="draft_leave_visible" header="草稿尚未保存">
      <p class="text-sm text-slate-600 dark:text-slate-300">
        有修改还未保存到云端草稿！离开后，这些修改可能丢失！
      </p>
      <template #footer>
        <Button label="离开" severity="danger" text @click="finish_draft_leave(true)" />
        <Button label="留下" autofocus @click="finish_draft_leave(false)">
          <template #icon>
            <MyIcon name="lucide:check" />
          </template>
        </Button>
      </template>
    </MyDialog>

    <MyDialog v-model:visible="recovery_visible" header="恢复区" :closable="recovery_copy_attempted">
      <p class="text-sm text-slate-600 dark:text-slate-300">
        编辑权发生变化，当前编辑器内的内容尚未保存到云端，且关闭本弹窗后这些内容将丢失！请及时复制保存：
      </p>
      <Button type="button" label="复制未保存内容" size="large" class="mt-4 w-full" @click="copy_recovery">
        <template #icon>
          <MyIcon name="lucide:copy" />
        </template>
      </Button>
    </MyDialog>

    <MyDialog v-model:visible="paste_visible" header="命名">
      <MyFileNameInput v-model="paste_name" :suffix="paste_name_suffix" aria-label="附件名称" @keydown.enter="submit_paste" />
      <template #footer>
        <Button label="上传" :disabled="! paste_name.trim()" @click="submit_paste">
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
import type MyContentMarkdownEditor from '~/components/MyContent/Markdown/Editor.vue'
import type { AttachmentUploadPick } from '~/features/content/uploads/picks'
import { link_file_name_illegal_chars, parse_story_markdown, split_attachment_editable_name } from '@shared/content-markdown'
import { content_name_key } from '@shared/content-reference'
import { settings } from '@shared/settings'
import { content_attachment_drag_file_names } from '~/features/content/attachments/drag'
import { get_content_attachment_drag_data, get_content_folder_drag_data } from '~/features/content/attachments/drag-transfer'
import { content_browser_navigation } from '~/features/content/browser-navigation'
import { useStoryEditing } from '~/features/content/editing'
import { format_event_range } from '~/features/content/event'

definePageMeta({
  middleware: 'require-content-draft-auth',
  // Remount per story id: setup (story fetch, draft-store init/restore, sync
  // subscriptions) assumes a fresh instance — a reused one would carry the
  // previous story's draft into the create page (and vice versa).
  key: route => route.path,
})

const route = useRoute()
const { ok: toast_ok, error: toast_error } = useMyToast()
const time_context = useDisplayTimeContext()
const raw_id = computed(() => route.params.id as string)
const cloud_draft_id = /^draft-[a-f0-9]{32}$/.test(raw_id.value) ? raw_id.value.slice(6) : undefined
const is_edit = computed(() => ! cloud_draft_id && raw_id.value !== 'new')
const story_id = computed(() => is_edit.value ? Number(raw_id.value) : 0)
/** The draft this page instance owns; the store's key is bound to it at setup. */
const draft_story_id = is_edit.value ? story_id.value : null

const markdown_editor = ref<InstanceType<typeof MyContentMarkdownEditor>>()
const editing = useStoryEditing({
  story_id: draft_story_id,
  draft_id: cloud_draft_id,
  editor: {
    apply_reference_changes: (before, changes) => ! markdown_editor.value || markdown_editor.value.apply_reference_changes(before, changes),
    validate: text => markdown_editor.value?.validate(text) ?? null,
  },
  attachment_interaction: content_browser_navigation,
})
const { draft_leave_visible, finish_draft_leave } = editing
if (import.meta.client) {
  // Match the page key, including transitions to a different draft on the same route record.
  const editing_path = route.path
  onScopeDispose(useRouter().beforeEach((to, from) => {
    if (from.path === editing_path && to.path !== editing_path)
      return editing.before_draft_leave()
  }))
}
await editing.ready
const { user, markdown, existing_stories, stories_completion_failure, attachments_completion_failure, attachment_panel, attachment_workspace } = editing
const { referenced_paths } = attachment_panel

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

const stored_attachments = computed(() => attachment_workspace.data.value?.attachments ?? [])
const folder_names = computed(() => attachment_workspace.data.value?.folders ?? [])
const header_cover_url = computed(() => {
  const cover = header_cover.value
  return cover && ! cover.startsWith('#') && ! /^[a-z][\w+.-]*:/i.test(cover) && cover.split('/').every(Boolean)
    ? (stored_attachments.value.find(item => content_name_key(item.file_name) === content_name_key(cover))?.url ?? null)
    : null
})

const header_cover_image = computed(() => stored_attachments.value.find(item => content_name_key(item.file_name) === content_name_key(header_cover.value ?? '') && item.url === header_cover_url.value)?.image)

const { cloud, draft_phase, private_blocked, editor_session_key, draft_storage_error, draft_dirty,
  draft_status_label, save_pending, reference_rewrite_pending, tab_writable, delete_pending,
  reference_history_warning_visible, confirm_reference_history_save, confirm_abandon_draft,
  on_save_click, confirm_delete_story, delete_visible, delete_impact, delete_impact_loading, delete_story_confirmed,
  upload_picks, can_write_now, draft_open_error, retry_draft_open, recovery, dismiss_recovery } = editing

const recovery_copy_attempted = ref(false)
watch(recovery, () => {
  recovery_copy_attempted.value = false
}, { flush: 'sync' })
const recovery_visible = computed({
  get: () => Boolean(recovery.value),
  set: (value: boolean) => {
    if (! value)
      dismiss_recovery()
  },
})

async function copy_recovery() {
  recovery_copy_attempted.value = true
  try {
    await navigator.clipboard.writeText(recovery.value)
  }
  catch {
    toast_error('复制失败，请重试')
    return
  }
  toast_ok('已复制未保存内容')
}

watch(draft_phase, (phase) => {
  if (phase === 'forbidden')
    last_valid_meta.value = null
})
function on_editor_files_dropped(picks: AttachmentUploadPick[], position: number | null) {
  void upload_picks(picks, upload_insertion(position))
}

function upload_insertion(position: number | null) {
  return position === null ? null : markdown_editor.value?.track_upload_insertion(position) ?? (() => false)
}
const paste_visible = ref(false)
const paste_name = ref('')
const paste_name_suffix = ref('')
let paste_pick: { pick: AttachmentUploadPick, insert: ReturnType<typeof upload_insertion> } | null = null
watch(paste_visible, (open) => {
  if (! open)
    paste_pick = null
}, { flush: 'sync' })
watch(editor_session_key, () => {
  paste_pick = null
  paste_visible.value = false
  paste_name.value = ''
  paste_name_suffix.value = ''
}, { flush: 'sync' })
function on_editor_files_pasted(picks: AttachmentUploadPick[], position: number | null) {
  const insert = upload_insertion(position)
  if (picks.length !== 1)
    return void upload_picks(picks, insert)
  paste_pick = { pick: picks[0]!, insert }
  // Same split as the ordinary rename prompt: only the stem is editable, the
  // extension stays a fixed suffix so a paste cannot change the file type.
  // The locked suffix is filtered too: a raw clipboard name can carry illegal
  // characters past the last dot (`.png:`) and the submit must stay clean.
  const parts = split_attachment_editable_name(picks[0]!.file_name)
  paste_name.value = parts.editable
  paste_name_suffix.value = parts.locked.replace(link_file_name_illegal_chars, '_')
  paste_visible.value = true
}
function submit_paste() {
  const held = paste_pick
  if (! held || ! paste_name.value.trim())
    return
  paste_visible.value = false
  paste_pick = null
  void upload_picks([{ ... held.pick, file_name: `${paste_name.value}${paste_name_suffix.value}` }], held.insert)
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
