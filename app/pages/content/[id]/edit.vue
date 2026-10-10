<template>
  <div class="space-y-12 pb-12 pt-8">
    <div v-if="private_blocked" class="section-card-collapse py-12 text-center text-slate-500 dark:text-slate-400">
      这份档案包含机密内容，你没有机密内容的查看权限，无法编辑
    </div>

    <div v-else-if="! is_edit || story">
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
          @files-pasted="on_editor_files_pasted"
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
              v-if="is_edit"
              v-bind="file_list_props"
              layout="stack"
              class="h-full"
              v-on="file_list_handlers"
            />
            <div v-else class="py-10 text-center text-sm text-slate-400 dark:text-slate-500">
              保存档案后即可上传附件
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
        <MyContentAttachmentList
          v-if="is_edit"
          v-bind="file_list_props"
          v-on="file_list_handlers"
        />
        <div v-else class="py-10 text-center text-sm text-slate-400 dark:text-slate-500">
          保存档案后即可上传附件
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
      v-model:visible="rename_visible"
      header="重命名附件"
      :pending="rename_pending"
      :closable="! rename_pending"
    >
      <Form id="rename-attachment-form" class="space-y-2" @submit="rename_attachment">
        <label for="rename-attachment-name" class="block text-sm font-medium">文件名</label>
        <MyFilteredInput
          id="rename-attachment-name"
          ref="rename_input"
          v-model="rename_file_name"
          :filter="link_file_name_illegal_chars"
          fluid
          :maxlength="120 - attachment_extension(rename_source_name).length"
          autofocus
          :disabled="rename_pending"
        />
        <div v-if="rename_conflict && ! rename_pending" class="form-error">
          {{ rename_conflict }}
        </div>
      </Form>

      <template #footer>
        <div class="flex justify-end gap-2">
          <Button :label="rename_cancel_label" severity="secondary" text :disabled="rename_pending" @click="rename_visible = false" />
          <Button label="重命名" type="submit" form="rename-attachment-form" :loading="rename_pending" :disabled="! rename_file_name.trim() || !! rename_conflict || rename_pending">
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
        <div v-if="folder_create_conflict && ! folder_pending" class="form-error">
          {{ folder_create_conflict }}
        </div>
      </Form>

      <template #footer>
        <div class="flex justify-end gap-2">
          <Button label="取消" severity="secondary" text :disabled="folder_pending" @click="folder_visible = false" />
          <Button label="创建" type="submit" form="create-folder-form" :loading="folder_pending" :disabled="! folder_name.trim() || !! folder_create_conflict || folder_pending">
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
        <div v-if="rename_folder_conflict && ! move_attachment_pending" class="form-error">
          {{ rename_folder_conflict }}
        </div>
      </Form>

      <template #footer>
        <div class="flex justify-end gap-2">
          <Button label="取消" severity="secondary" text :disabled="!! move_attachment_pending" @click="rename_folder_visible = false" />
          <Button label="重命名" type="submit" form="rename-folder-form" :loading="!! move_attachment_pending" :disabled="! rename_folder_name.trim() || rename_folder_name.trim() === attachment_base_name(rename_folder_target ?? '') || !! rename_folder_conflict || !! move_attachment_pending">
            <template #icon>
              <MyIcon name="lucide:pencil" />
            </template>
          </Button>
        </div>
      </template>
    </MyDialog>

    <MyDialog
      v-model:visible="replace_visible"
      header="替换附件"
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
            size="small"
          />
        </p>
        <input
          ref="replace_file_input"
          type="file"
          class="hidden"
          @change="on_replace_file_picked"
        >
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <Button label="取消" severity="secondary" text @click="close_replace_dialog" />
          <Button
            label="选择新文件"
            severity="warn"
            @click="replace_file_input?.click()"
          >
            <template #icon>
              <MyIcon name="lucide:file-input" />
            </template>
          </Button>
        </div>
      </template>
    </MyDialog>

    <MyContentAttachmentRedact
      v-model:visible="redact_visible"
      :attachment="redact_target"
      :pending="redact_pending"
      @save="save_abridged_attachment"
    />

    <MyDialog
      :visible="!! skipped_notice"
      header="部分项目已跳过"
      @update:visible="skipped_notice = null"
    >
      <div v-if="skipped_notice" class="space-y-3 text-sm text-slate-600 dark:text-slate-300">
        <span>{{ skipped_notice.message }}</span>
        <ul class="max-h-48 space-y-1 overflow-y-auto rounded-sm border border-slate-200 p-2 font-mono text-xs dark:border-slate-700">
          <li
            v-for="item in skipped_notice.items"
            :key="item.name"
            class="truncate"
          >
            {{ item.name }}{{ item.reason ? ` — ${item.reason}` : '' }}
          </li>
        </ul>
      </div>

      <template #footer>
        <div class="flex justify-end">
          <Button label="OK" @click="skipped_notice = null" />
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
import type MyContentMarkdownEditor from '~/components/MyContent/Markdown/Editor.vue'
import type { ContentDraftRecord } from '~/stores/contentDraft'
import type { UploadEntry } from '~/stores/contentTasks'
import type { AttachmentListItem, AttachmentUploadPick, MyContentAttachmentRow } from '~/utils/content/attachment'
import type { PendingUploadRow } from '~/utils/content/task-row'
import { attachment_ancestor_folders, attachment_base_name, attachment_folder_of, attachment_name_conflict_message, attachment_path_join, attachment_path_taken, attachment_path_violation, compare_attachment_names, decrypted_attachment_name, encrypted_attachment_suffix, extract_attachment_names, is_encrypted_attachment, link_file_name_illegal_chars, parse_story_markdown, rename_attachment_references, split_attachment_editable_name, story_markdown_template } from '@shared/content-markdown'
import { has_permission } from '@shared/permissions'
import { settings } from '@shared/settings'
import { sync_resource } from '@shared/types/sync'
import { storeToRefs } from 'pinia'
import { useContentDraftStore } from '~/stores/contentDraft'
import { useContentTasksStore } from '~/stores/contentTasks'
import { attachment_picks_from_data_transfer } from '~/utils/content/attachment'
import { content_attachment_drag_file_names, content_attachment_drag_type, content_attachment_markdown, content_folder_drag_type, content_folder_markdown, get_content_attachment_drag_data, get_content_folder_drag_data, set_content_attachment_drag_data, set_content_folder_drag_data } from '~/utils/content/attachment-drag'
import { format_event_range } from '~/utils/content/event'
import { pending_upload_card, pending_upload_status } from '~/utils/content/task-row'
import { delete_upload_file_handle, load_upload_file_handle, save_upload_file_handle } from '~/utils/content/upload-file-handle'

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
const { ok, error } = useMyToast()
const { confirm_require } = useMyConfirm()
const upload_handle_db_name = settings.app.content.upload.handleStorageName
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
const raw_id = computed(() => route.params.id as string)
const is_edit = computed(() => raw_id.value !== 'new')
const story_id = computed(() => is_edit.value ? Number(raw_id.value) : 0)
/** The draft this page instance owns; the store's key is bound to it at setup. */
const draft_story_id = is_edit.value ? story_id.value : null

const draft_store = useContentDraftStore(draft_story_id)
/** The server-side attachment task state for this story, plus this client's drivers. */
const tasks_store = useContentTasksStore(story_id.value)
const {
  markdown,
  base_revision,
  draft_saved_at,
  autosave_pending: draft_autosave_pending,
  storage_error: draft_storage_error,
  dirty: draft_dirty,
} = storeToRefs(draft_store)

const story = useState<ContentStoryDetail | null>('content_story_detail', () => null)

// A story holding private elements is editable only with the content_private
// permission: the server strips them for everyone else, so editing here would
// silently delete them on save (the server save guard blocks it anyway).
const private_blocked = computed(() =>
  is_edit.value && !! story.value?.has_private && ! has_permission(user.value, 'content_private', 'read'))

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
  return meta ? format_event_range(meta.event_precision, meta.event_entries) : null
})

/**
 * What the rename prompt edits: a stored attachment (renamed through the API),
 * or a just-pasted upload that has no row yet (named in place, and taken along
 * by its confirm call).
 */
type AttachmentRenameTarget
  = | { kind: 'stored', attachment: ContentStoryAttachment }
    | { kind: 'pick', pick: UploadEntry }

const save_pending = ref(false)
const delete_pending = ref(false)
/** Files a batch operation had to leave behind, with the reason for each; drives the notice dialog. */
const skipped_notice = ref<{ message: string, items: { name: string, reason?: string }[] } | null>(null)
const rename_visible = ref(false)
const rename_pending = ref(false)
const rename_target = ref<AttachmentRenameTarget | null>(null)
const rename_file_name = ref('')
/** An accepted name uploads the held-back paste; cancel or dismissal drops it. */
const rename_confirmed = ref(false)
const rename_input = ref<{ $el?: HTMLInputElement } | null>(null)
const replace_visible = ref(false)
const replace_target = ref<ContentStoryAttachment | null>(null)
const replace_file_input = ref<HTMLInputElement>()
const replace_drag_over = ref(false)
const replace_name_mode = ref<'keep-name' | 'new-name'>('keep-name')
const replace_name_modes = [
  { label: '保留旧文件名', value: 'keep-name' },
  { label: '使用新文件名', value: 'new-name' },
]
/** The encrypted image the 删减版 editor is open on, plus its save state. */
const redact_visible = ref(false)
const redact_target = ref<ContentStoryAttachment | null>(null)
const redact_pending = ref(false)
/** File names with an in-flight delete; a batch marks every member, not just one. */
const delete_attachment_pending = reactive(new Set<string>())
/** File names with an in-flight encrypt/decrypt; drives the row spinner like delete. */
const encrypt_attachment_pending = reactive(new Set<string>())
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
/** A pasted file parked until its name is settled; the task is only created on accept. */
const held_pick = ref<UploadEntry | null>(null)
/** Any transfer running right now, for the controls that must not race one. */
const upload_busy = computed(() => tasks_store.transferring)
const draft_conflict_visible = ref(false)
const pending_conflict_draft = ref<ContentDraftRecord | null>(null)
const discard_draft_pending = ref(false)

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

const stored_attachments = computed(() => story.value?.attachments ?? [])

/** Plaintext names that are the 删减版 twin of an encrypted sibling. */
const abridged_twin_names = computed(() => new Set(
  stored_attachments.value.filter(attachment => attachment.is_encrypted).map(attachment => decrypted_attachment_name(attachment.file_name)),
))
/** Explicitly created folders (server rows); folders implied by file paths are derived in `folder_names`. */
const attachment_folders = computed(() => story.value?.folders ?? [])

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
        is_abridged_twin: abridged_twin_names.value.has(attachment.file_name),
      },
    })
  }
  for (const row of tasks_store.pending_rows) {
    items.push({
      key: upload_selection_key(row.item_id),
      kind: 'upload',
      row,
      card: pending_upload_card(row),
    })
  }
  // Re-sort because pending uploads are merged in above; the server only orders
  // the stored rows it knows about. Both sides share the comparator so an
  // upload lands where its final position will be.
  return items.sort((a, b) => compare_attachment_names(a.card.file_name, b.card.file_name))
})

/** The storage path of any item (stored or pending upload), so uploads nest under their folders too. */
function item_file_name(item: AttachmentListItem) {
  return item.kind === 'stored' ? item.attachment.file_name : item.row.path
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

/**
 * Every path the server already holds in this scope: files, explicitly created
 * folders, and the ancestors nested uploads imply. Rename collisions are
 * checked against this, so a destination that still has a pending upload of its
 * own is free — that upload's row lands later and is suffixed if it then
 * clashes.
 */
const stored_scope_paths = computed(() => {
  const paths = new Set(attachment_folders.value)
  for (const attachment of stored_attachments.value) {
    paths.add(attachment.file_name)
    for (const ancestor of attachment_ancestor_folders(attachment.file_name))
      paths.add(ancestor)
  }
  return [... paths]
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

function upload_selection_key(item_id: number) {
  return `upload:${item_id}`
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

const selected_upload_rows = computed(() => tasks_store.pending_rows.filter(row => selection.has(upload_selection_key(row.item_id))))

const selected_file_names = computed(() => [... selection]
  .filter(key => key.startsWith('file:'))
  .map(key => key.slice('file:'.length)))

/** Selected folder paths (files and folders share the selection, but not the actions). */
const selected_folder_paths = computed(() => [... selection]
  .filter(key => key.startsWith('folder:'))
  .map(key => key.slice('folder:'.length)))

/** The selected stored files — what a bulk encrypt/decrypt actually acts on. */
const selected_stored_attachments = computed(() => stored_attachments.value.filter(attachment => selection.has(file_selection_key(attachment.file_name))))

/** The size cap a file must fit under to be encrypted. */
const max_encrypt_bytes = settings.app.content.encrypt.maxSizeMb * 1024 * 1024

/** The state abbreviations the menus report in place of an action they cannot offer. */
const encrypted_reason = '已加密'

/** Whether encrypting or decrypting this file would land on a path the scope already holds. */
function encryption_target_taken(kind: 'encrypt' | 'decrypt', attachment: ContentStoryAttachment) {
  const target = kind === 'encrypt'
    ? `${attachment.file_name}${encrypted_attachment_suffix}`
    : decrypted_attachment_name(attachment.file_name)
  // The scope's files and folders share one path space, so a folder can be the
  // thing in the way (an existing 删减版 holds the very name a decrypt needs).
  return attachment_path_taken(stored_scope_paths.value, target)
}

/**
 * Why this file cannot take the encrypt/decrypt action, or null when it can.
 * The one place the per-file rule lives: the menu aggregates these into its
 * reasons, and the batch execution uses them to drop exactly those files.
 */
function encryption_skip_reason(kind: 'encrypt' | 'decrypt', attachment: ContentStoryAttachment) {
  if (kind === 'encrypt') {
    if (attachment.is_encrypted)
      return encrypted_reason
    if (attachment.file_size > max_encrypt_bytes)
      return '文件太大'
  }
  else if (! attachment.is_encrypted) {
    return '未加密'
  }
  return encryption_target_taken(kind, attachment) ? '文件名冲突' : null
}

/** Splits a target set into what the action can take and what it has to leave behind. */
function split_encryption_targets(kind: 'encrypt' | 'decrypt', attachments: ContentStoryAttachment[]) {
  const planned: ContentStoryAttachment[] = []
  const skipped: { name: string, reason: string }[] = []
  for (const attachment of attachments) {
    const reason = encryption_skip_reason(kind, attachment)
    if (reason)
      skipped.push({ name: attachment.file_name, reason })
    else
      planned.push(attachment)
  }
  return { planned, skipped }
}

/**
 * Why encrypt/decrypt cannot run on this target set, or empty when it can.
 *
 * The rule for a batch is "at least one item has to be able to take it": the
 * rest is skipped when it runs, so a mixed selection still does the work it
 * can. Only when nothing qualifies does the entry turn into its reasons — and
 * there can be several, because different members can be inapplicable for
 * different causes (a selection holding encrypted files and an oversized
 * plaintext one is both 已加密 and 文件太大).
 */
function encryption_blocked_reasons(kind: 'encrypt' | 'decrypt', attachments: ContentStoryAttachment[]) {
  if (! attachments.length)
    return [kind === 'encrypt' ? '无可加密的附件' : '无可解密的附件']
  const skipped: string[] = []
  for (const attachment of attachments) {
    const reason = encryption_skip_reason(kind, attachment)
    if (reason)
      skipped.push(reason)
  }
  // Anything without a reason can take the action, so it stays available.
  if (skipped.length < attachments.length)
    return []
  return [... new Set(skipped)]
}

/** A skipped delete always comes from a markdown reference: the file's own, or a folder's through a file inside it. */
const delete_reference_reason = '已被正文引用'

/** Why delete cannot run on this target set (files, plus what lives under the folders), or empty when it can. */
function delete_blocked_reasons(targets: { folders: string[], attachments: ContentStoryAttachment[] }) {
  const split = split_delete_targets(targets.attachments.map(attachment => attachment.file_name), targets.folders)
  return split.deletable.length || split.deletable_folders.length ? [] : [delete_reference_reason]
}

/**
 * The action availability for a row's menu. A row inside a multi-selection
 * reports on the whole selection, because that is what its menu acts on; any
 * other row reports on itself.
 */
function row_action_targets(item: AttachmentListItem | null, selected: boolean) {
  if (selected)
    return selected_stored_attachments.value
  return item?.kind === 'stored' ? [item.attachment] : []
}

const selection_action_targets = computed(() => selected_delete_targets())

const selection_delete_blocked_reasons = computed(() => delete_blocked_reasons(selection_action_targets.value))

/**
 * The scope's server-side operation lock. The refs above only describe this
 * tab, so a move/rename started in another tab or by another admin is invisible
 * without it — the server publishes its lock with the attachment payload and
 * this folds it into the same disabled row state.
 */
const remote_operation_lock = computed(() => story.value?.operation_lock ?? null)
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
    // structure_locked is deliberately absent: drags are already refused
    // wholesale while the scope is locked (is_attachment_drag), and folding
    // the lock in here dimmed every folder row for the whole operation.
    drop_disabled: is_folder_drop_disabled(path) || is_folder_target_disabled(path),
    moving: move_attachment_pending.value?.target === path || move_attachment_pending.value?.new_folder === path,
    dimmed: pending_dim_folders.value.has(path),
    batch_pending: move_attachment_pending.value !== null || structure_locked.value,
  } as const
}

function file_row_state(item: AttachmentListItem) {
  const selected = selection.has(item_selection_key(item))
  // A row inside a multi-selection opens the batch menu, so it reports on the
  // selection; any other row reports on itself alone.
  const bulk = selected && selection.size > 1
  const check_targets = bulk ? selected_stored_attachments.value : row_action_targets(item, false)
  return {
    selected,
    selection_edges: null,
    selection_count: selected ? selection.size : 0,
    delete_pending: item.kind === 'stored' && delete_attachment_pending.has(item.card.file_name),
    delete_disabled: delete_attachment_pending.size > 0 || encrypt_attachment_pending.size > 0 || structure_locked.value,
    delete_blocked_reasons: bulk
      ? selection_delete_blocked_reasons.value
      : item.kind === 'stored' && is_referenced(item.attachment.file_name) ? [delete_reference_reason] : [],
    encrypt_pending: item.kind === 'stored' && encrypt_attachment_pending.has(item.card.file_name),
    encrypt_blocked_reasons: encryption_blocked_reasons('encrypt', check_targets),
    decrypt_blocked_reasons: encryption_blocked_reasons('decrypt', check_targets),
    replace_blocked_reasons: item.kind === 'stored' && item.attachment.is_encrypted ? [encrypted_reason] : [],
    replace_disabled: false,
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
      const folder_selected = selection.has(folder_selection_key(folder))
      const folder_bulk = folder_selected && selection.size > 1
      rows.push({
        key: folder_selection_key(folder),
        depth,
        data: folder_row_data(folder),
        state: {
          selected: folder_selected,
          selection_edges: null,
          selection_count: folder_selected ? selection.size : 0,
          delete_pending: delete_folder_pending.has(folder),
          delete_disabled: delete_attachment_pending.size > 0 || delete_folder_pending.size > 0 || encrypt_attachment_pending.size > 0 || structure_locked.value,
          delete_blocked_reasons: folder_bulk
            ? selection_delete_blocked_reasons.value
            : folder_delete_blocked_reasons(folder),
          encrypt_pending: false,
          // Encrypt/decrypt act on files only, so a folder's menu offers them
          // for the selection it is part of, never for the folder itself.
          encrypt_blocked_reasons: folder_bulk
            ? encryption_blocked_reasons('encrypt', selected_stored_attachments.value)
            : [],
          decrypt_blocked_reasons: folder_bulk
            ? encryption_blocked_reasons('decrypt', selected_stored_attachments.value)
            : [],
          // Replacing is a file-only action, so a folder's menu never offers it.
          replace_blocked_reasons: [],
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
  story_id: story_id.value,
  upload_busy: upload_busy.value,
  move_to_root: move_attachment_pending.value?.target === null,
  root_drag_over: root_drag_over.value,
}))

const file_list_handlers = {
  'preview': preview_image,
  'copy': on_file_row_copy,
  'rename': on_file_row_rename,
  'replace': on_file_row_replace,
  'create-abridged': on_file_row_create_abridged,
  'encrypt': (event: MouseEvent, row: MyContentAttachmentRow) => on_file_row_encrypt(event, row, 'encrypt'),
  'decrypt': (event: MouseEvent, row: MyContentAttachmentRow) => on_file_row_encrypt(event, row, 'decrypt'),
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

/**
 * Opens the 删减版 editor on an encrypted image. A blocked target (an
 * unsupported format, a taken twin name) is reported by the menu itself, so
 * this only has to let the editor in.
 */
function on_file_row_create_abridged(row: MyContentAttachmentRow) {
  const item = row.item
  if (! item || item.kind !== 'stored' || redact_pending.value || structure_locked.value)
    return
  redact_target.value = item.attachment
  redact_visible.value = true
}

async function save_abridged_attachment(file: File) {
  const target = redact_target.value
  if (! target || redact_pending.value)
    return
  redact_pending.value = true
  try {
    await content.create_abridged_attachment(story_id.value, target.file_name, file)
    redact_visible.value = false
    redact_target.value = null
    story.value = await fetch_story()
    if (story.value)
      draft_store.advance_base(story.value.markdown, story.value.revision)
    ok('删减版已创建')
  }
  catch (ex) {
    report_operation_error(ex)
  }
  finally {
    redact_pending.value = false
  }
}

/** The files an encrypt/decrypt applies to: the selection's files, or the single right-clicked one. */
function on_file_row_encrypt(event: MouseEvent, row: MyContentAttachmentRow, kind: 'encrypt' | 'decrypt') {
  const item = row.item
  const from_selection = selection.size > 1 && (! item || (item.kind === 'stored' && selection.has(file_selection_key(item.attachment.file_name))))
  const targets = from_selection
    ? stored_attachments.value.filter(attachment => selected_file_names.value.includes(attachment.file_name))
    : item?.kind === 'stored' ? [item.attachment] : []
  if (! targets.length || encrypt_attachment_pending.size)
    return

  // The batch is split here, not by the server: the action is refused as a
  // whole when a single member cannot take it (an already-encrypted file, one
  // over the size cap, a taken target name), so the doable part is executed and
  // the rest is reported instead.
  const { planned, skipped } = split_encryption_targets(kind, targets)
  // Selected folders cannot take the action either, and they are part of what
  // the user selected, so they are counted and listed alongside the files.
  if (from_selection)
    skipped.push(... selected_folder_paths.value.map(name => ({ name, reason: '文件夹' })))
  const verb = kind === 'encrypt' ? '加密' : '取消加密'
  if (! planned.length) {
    show_skipped_attachments(skipped, `以下项目无法${verb}，已全部跳过：`)
    return
  }
  const message = planned.length > 1
    ? `确定要${verb}选中的 ${planned.length} 个附件吗？`
    : `确定要${verb}该附件吗？`
  confirm_require(event, skipped.length ? `${message}（另有 ${skipped.length} 个项目将跳过）` : message, () => {
    void execute_attachment_encryption(kind, planned, skipped)
  }, {
    acceptProps: { label: verb },
  })
}

async function execute_attachment_encryption(kind: 'encrypt' | 'decrypt', attachments: ContentStoryAttachment[], skipped: { name: string, reason: string }[]) {
  const names = attachments.map(attachment => attachment.file_name)
  for (const name of names)
    encrypt_attachment_pending.add(name)
  try {
    const result = kind === 'encrypt'
      ? await content.encrypt_attachments(story_id.value, names)
      : await content.decrypt_attachments(story_id.value, names)
    const succeeded = new Set(result.succeeded)
    const server_skipped = result.skipped.map(item => ({ name: item.file_name, reason: item.reason }))
    // The server renamed the rows (± .good) and, for a stored story, rewrote
    // the stored markdown; follow the rename in the local draft like a rename.
    for (const attachment of attachments.filter(attachment => succeeded.has(attachment.file_name))) {
      const new_name = kind === 'encrypt' ? `${attachment.file_name}${encrypted_attachment_suffix}` : decrypted_attachment_name(attachment.file_name)
      markdown.value = rename_attachment_references(markdown.value, attachment.file_name, new_name)
    }
    story.value = await fetch_story()
    if (story.value)
      draft_store.advance_base(story.value.markdown, story.value.revision)
    clear_selection()
    show_skipped_attachments([... skipped, ... server_skipped], `以下项目无法${kind === 'encrypt' ? '加密' : '取消加密'}，已跳过：`)
  }
  catch (ex) {
    report_operation_error(ex)
  }
  finally {
    for (const name of names)
      encrypt_attachment_pending.delete(name)
  }
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

// A new story has no attachments: uploads start only after the first save.
const initial_markdown = is_edit.value
  ? (story.value?.markdown ?? '')
  : story_markdown_template(datetime_build_string(null, '{YYYY}/{M}/{D}'))
const initial_revision = is_edit.value ? (story.value?.revision ?? null) : null

draft_store.initialize(initial_markdown, initial_revision)

// Adopt a newer DB version of this story into the editor when it changes
// elsewhere (another admin/tab editing the same story) — content only if the
// editor hasn't diverged from the last known DB base (no local unsaved edits),
// so a remote update never clobbers in-progress work; the attachment list is
// always safe to adopt.
if (import.meta.client && is_edit.value) {
  // Synced refetches land in this setter, which applies the dirty-draft merge
  // rule instead of blindly overwriting the editor state.
  const synced_story = computed<ContentStoryDetail | null>({
    get: () => story.value,
    set: (latest_story) => {
      if (! latest_story)
        return
      if (draft_dirty.value) {
        if (story.value)
          story.value = { ... story.value, attachments: latest_story.attachments, folders: latest_story.folders }
        return
      }
      story.value = latest_story
      draft_store.mark_saved(latest_story.markdown, latest_story.revision)
    },
  })
  const story_sync_loading = ref(false)
  await useSyncedData<ContentStoryDetail | null>(
    computed(() => sync_resource('content_story', story_id.value)),
    fetch_story,
    synced_story,
    story_sync_loading,
    // The setup fetch above already populated the story; this is trigger-only,
    // and a transient sync fetch failure keeps the current editor state
    // instead of toasting.
    { immediate: false, server: false, universal: false, on_error: () => {} },
  )
}

onMounted(() => {
  window.addEventListener('pagehide', persist_draft_on_page_hide)
  window.addEventListener('keydown', on_save_hotkey)
  document.addEventListener('pointerdown', on_document_pointerdown)

  if (is_edit.value && ! story.value)
    return

  // Blocked private stories never touched the editor; a local draft would
  // only risk restoring over the stripped base later.
  if (private_blocked.value)
    return

  const draft = draft_store.read_persisted()
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
  draft_store.initialize(story.value?.markdown ?? initial_markdown, story.value?.revision ?? initial_revision)
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
  const draft = draft_store.read_persisted()
  const latest_story = await fetch_story()
  if (! draft || ! latest_story)
    return false

  story.value = latest_story
  pending_conflict_draft.value = draft
  draft_conflict_visible.value = true
  return true
}

/** The IndexedDB key a pick's source handle is remembered under, so a refresh can resume without a picker. */
function upload_handle_key(path: string) {
  return `${story_id.value}:${path}`
}

/** The bytes a landed item's reference is inserted at; the caret lives here, not on the server. */
function upload_landing_handler(pick: AttachmentUploadPick, insert_position: number | null) {
  return (attachment: ContentStoryAttachment) => {
    // The story's own list arrives through the content_story refresh; merging
    // here just keeps the row visible until it does.
    if (story.value && ! story.value.attachments.some(item => item.file_name === attachment.file_name))
      story.value = { ... story.value, attachments: [... story.value.attachments, attachment] }
    if (insert_position !== null)
      insert_attachment_markdown(attachment.file_name, attachment.is_image, insert_position)
    void delete_upload_file_handle(upload_handle_db_name, upload_handle_key(pick.file_name)).catch(() => {})
  }
}

/**
 * Hands a batch of picked files to the task queue. The queue owns the transfer,
 * the name arbitration and the progress; this only does what the server cannot:
 * reject the shared-name rules early, remember resumable handles, and report
 * whichever entries the preflight refused.
 */
async function upload_picks(picks: AttachmentUploadPick[], insert_position: number | null) {
  // The orphan staging pool is gone: uploads start only after the story exists.
  if (! is_edit.value) {
    if (picks.length)
      error('请先保存档案，再上传附件')
    return
  }
  if (! picks.length)
    return

  const bad_suffix = picks.filter(pick => is_encrypted_attachment(pick.file_name))
  if (bad_suffix.length)
    error('文件名中包含非法字段')
  const accepted = picks.filter(pick => ! is_encrypted_attachment(pick.file_name))
  if (! accepted.length)
    return

  for (const pick of accepted)
    expand_folder(attachment_folder_of(pick.file_name))

  const entries: UploadEntry[] = accepted.map(pick => ({
    file: pick.file,
    file_name: pick.file_name,
    insert_position,
    on_landed: upload_landing_handler(pick, insert_position),
  }))
  const result = await tasks_store.start_uploads(entries)
  for (const refusal of result.rejected)
    error(`${attachment_base_name(refusal.path)}：${refusal.reason}`)

  // The handle is stored under the picked path; a name the server had to suffix
  // simply loses the hint and asks for the file again on a later resume.
  for (const pick of accepted) {
    if (! pick.handle)
      continue
    void save_upload_file_handle(upload_handle_db_name, upload_handle_key(pick.file_name), {
      file_name: pick.file.name,
      file_size: pick.file.size,
      handle: pick.handle,
    })
  }
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
  void upload_picks(picks, null)
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
  void upload_picks(await attachment_picks_from_data_transfer(event.dataTransfer), null)
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
  void upload_picks(picks, position)
}

function on_editor_files_pasted(picks: AttachmentUploadPick[], position: number | null) {
  // Only a lone paste is worth naming; a batch keeps the names it came with.
  if (picks.length !== 1) {
    void upload_picks(picks, position)
    return
  }
  // Held back until the name is settled: the task is created with the final
  // name, so a name arriving later would take a second, server-side rename.
  const pick: UploadEntry = { ... picks[0]!, insert_position: position }
  held_pick.value = pick
  open_rename_dialog({ kind: 'pick', pick })
}

/**
 * The bytes a row needs, preferring what this client already holds: the picked
 * File, then the remembered File System Access handle, then a picker. Returns
 * null when the user declines or picks a different file.
 */
async function resolve_upload_file(row: PendingUploadRow): Promise<File | null> {
  const record = await load_upload_file_handle(upload_handle_db_name, upload_handle_key(row.path)).catch(() => null)
  if (record) {
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
    }
  }
  const expected_name = record?.file_name ?? attachment_base_name(row.path)
  const expected_size = record?.file_size ?? row.bytes_total
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

/**
 * Continues a row: drives it from the bytes this client holds, or asks for them
 * again. The uploader skips the parts the server already has, so re-running a
 * partly finished transfer is the resume.
 */
async function continue_upload(row: PendingUploadRow) {
  const entry = tasks_store.tasks.find(candidate => candidate.task.id === row.task_id)
  // Only an item the server has prepared can be driven: a queued one is still
  // waiting for its turn, and the runner flips it to active when it gets it.
  if (entry?.items.find(candidate => candidate.id === row.item_id)?.status !== 'active')
    return

  const local = tasks_store.local_item(row.item_id)
  if (local) {
    await tasks_store.resume_item(row.item_id, local)
    return
  }

  const file = await resolve_upload_file(row)
  if (! file)
    return
  await tasks_store.resume_item(row.item_id, {
    file,
    // The caret is long gone after a refresh, so a resumed landing only refreshes.
    insert_position: null,
    on_landed: upload_landing_handler({ file, file_name: row.path }, null),
  })
}

/** The card's 暂停/继续 toggle: abort the local transfer, or start it again. */
async function toggle_upload(row: PendingUploadRow) {
  if (row.is_driving) {
    tasks_store.pause_item(row.item_id)
    return
  }
  await continue_upload(row)
}

/**
 * Retries a failed row: an item the server still holds open continues from where
 * it stopped, while one it already finished with (refused, or reaped by the
 * sweeper) needs a task of its own — driven again it would only 409.
 */
async function retry_upload(row: PendingUploadRow) {
  const entry = tasks_store.tasks.find(candidate => candidate.task.id === row.task_id)
  const item = entry?.items.find(candidate => candidate.id === row.item_id)
  if (item && item.status !== 'active' && item.status !== 'pending') {
    const local = tasks_store.local_item(row.item_id)
    await tasks_store.remove(row.task_id)
    if (local)
      await upload_picks([{ file: local.file, file_name: row.path }], local.insert_position)
    return
  }
  await continue_upload(row)
}

/** Batch-resume every selected paused upload (continues the multipart where it left off). */
function batch_start_selected_uploads() {
  for (const row of selected_upload_rows.value) {
    if (pending_upload_status(row) !== 'paused')
      continue
    void continue_upload(row).catch(report_operation_error)
  }
}

/** Batch-pause every selected actively uploading task. */
function batch_pause_selected_uploads() {
  for (const row of selected_upload_rows.value) {
    if (row.is_driving)
      tasks_store.pause_item(row.item_id)
  }
}

/** Batch-remove every selected upload row, cancelling the ones still live. */
function batch_delete_selected_uploads(event: MouseEvent) {
  const rows = [... selected_upload_rows.value]
  if (! rows.length)
    return
  confirm_require(event, `确定要删除选中的 ${rows.length} 个上传任务吗？`, () => {
    for (const row of rows)
      void tasks_store.remove(row.task_id).catch(report_operation_error)
    clear_selection()
  }, {
    acceptProps: { label: '删除', severity: 'danger' },
  })
}

/**
 * Live progress for this scope's tasks: the event carries the state itself, so
 * it is applied straight to the store — the periodic `sync` refresh stays for
 * membership changes, which need a fetch.
 */
if (import.meta.client && is_edit.value) {
  const unsubscribe_tasks = useDataSync().subscribe(sync_resource('content_story_tasks', story_id.value), (event) => {
    if (event?.type !== 'task_progress' || ! event.task_snapshot)
      return
    tasks_store.apply_snapshot(event.task_snapshot)
  })
  onBeforeUnmount(unsubscribe_tasks)
  onMounted(() => void tasks_store.load().catch(report_operation_error))
}

function on_attachment_copy(item: AttachmentListItem) {
  if (item.kind === 'stored')
    copy_attachment_code(item.attachment)
}

function on_attachment_rename(item: AttachmentListItem) {
  if (item.kind === 'stored')
    open_rename_dialog({ kind: 'stored', attachment: item.attachment })
}

function on_attachment_replace(item: AttachmentListItem) {
  if (item.kind === 'stored')
    open_replace_dialog(item.attachment)
}

function on_attachment_delete(event: MouseEvent, item: AttachmentListItem) {
  if (item.kind === 'stored')
    confirm_delete_attachment(event, item.attachment)
}

function on_attachment_retry(item: AttachmentListItem) {
  if (item.kind === 'upload')
    void retry_upload(item.row).catch(report_operation_error)
}

function on_attachment_pause(item: AttachmentListItem) {
  if (item.kind === 'upload')
    void toggle_upload(item.row).catch(report_operation_error)
}

function on_attachment_cancel(event: MouseEvent, item: AttachmentListItem) {
  if (item.kind !== 'upload')
    return
  confirm_require(event, '确定要取消该文件的上传吗？', () => {
    void tasks_store.cancel(item.row.task_id).catch(report_operation_error)
  }, {
    acceptProps: { label: '取消上传', severity: 'danger' },
  })
}

function on_attachment_remove(event: MouseEvent, item: AttachmentListItem) {
  if (item.kind !== 'upload')
    return
  confirm_require(event, '确定要移除该上传任务吗？', () => {
    void tasks_store.remove(item.row.task_id).catch(report_operation_error)
  }, {
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
  return split_attachment_editable_name(file_name).editable
}

function attachment_extension(file_name: string) {
  return split_attachment_editable_name(file_name).locked
}

function rename_target_name(target: AttachmentRenameTarget) {
  return target.kind === 'pick' ? target.pick.file_name : target.attachment.file_name
}

/** The name the prompt is editing, for the byte cap on the field. */
const rename_source_name = computed(() => rename_target.value ? rename_target_name(rename_target.value) : '')

/** The prompt holds a pasted upload rather than a stored file: "cancel" drops that paste. */
const rename_cancel_label = computed(() => rename_target.value?.kind === 'pick' ? '取消上传' : '取消')

/** Storage path the prompt's current text would apply; null while the field is empty. */
function rename_target_path(target: AttachmentRenameTarget) {
  const name = rename_target_name(target)
  const stem = rename_file_name.value.trim()
  return stem ? attachment_path_join(attachment_folder_of(name), `${stem}${attachment_extension(name)}`) : null
}

/**
 * Why the prompt cannot be submitted (null when the name is submittable).
 * Mirrors the server's guard: the shared name rules first, then the scope's own
 * name space — its files and folders share one path space, so the new name may
 * not be one a folder (or the folder implied by a deeper file) already answers
 * to. A pasted upload takes the same checks — the server would silently suffix
 * a collision at confirm time, so the prompt is the only place the name the
 * author typed and the name the file ends up with can be kept from diverging.
 *
 * Only the editable stem is the author's, so legality is judged on the name with
 * its locked tail stripped: an encrypted file keeps the `.good` marker the row
 * already carries (see `split_attachment_editable_name`), and the server judges
 * it the same way.
 */
const rename_conflict = computed(() => {
  const target = rename_target.value
  if (! target)
    return null
  const current_name = rename_target_name(target)
  const file_name = rename_target_path(target)
  if (! file_name)
    return null
  // Re-submitting a stored file's own name is a no-op, not a conflict.
  if (target.kind === 'stored' && file_name === current_name)
    return null
  const violation = attachment_path_violation(decrypted_attachment_name(file_name))
  if (violation)
    return violation
  const taken = [... stored_scope_paths.value]
  // A pending upload elsewhere in the list is a name this one cannot take
  // either — the first to finalize wins and the rest get suffixed.
  if (target.kind === 'pick') {
    for (const row of tasks_store.pending_rows)
      taken.push(row.path)
  }
  // A stored file is being renamed, so its own row does not count against it;
  // a paste has no row yet, and the uploads it must not land on were just added.
  const ignore = target.kind === 'stored' ? current_name : null
  return attachment_path_taken(taken, file_name, ignore) ? '已有同名附件' : null
})

/** The only way the rename prompt is opened; both flows go through it. */
function open_rename_dialog(target: AttachmentRenameTarget) {
  rename_target.value = target
  rename_confirmed.value = false
  rename_file_name.value = attachment_stem(attachment_base_name(rename_target_name(target)))
  rename_visible.value = true
  // Preselect the stem: typing replaces the name instead of appending to it.
  void nextTick(() => rename_input.value?.$el?.select())
}

// The prompt's exit releases the paste it was holding, so it can never be lost
// unnamed: an accepted name uploads it, cancel or dismissal drops it.
watch(rename_visible, (visible) => {
  if (visible)
    return
  const target = rename_target.value
  const confirmed = rename_confirmed.value
  const path = target ? rename_target_path(target) : null
  rename_target.value = null
  held_pick.value = null
  rename_confirmed.value = false
  if (target?.kind !== 'pick' || ! confirmed)
    return
  void upload_picks([{ ... target.pick, file_name: path ?? target.pick.file_name }], target.pick.insert_position ?? null)
})

async function rename_attachment() {
  const target = rename_target.value
  const file_name = target ? rename_target_path(target) : null
  if (! target || ! file_name || rename_pending.value || rename_conflict.value)
    return

  const current_name = rename_target_name(target)

  // A held-back paste has no row yet, so the name only has to reach the task
  // that this paste is about to create. The flag is what tells the watch's
  // release that this name was accepted.
  if (target.kind === 'pick') {
    rename_confirmed.value = true
    rename_visible.value = false
    return
  }

  if (file_name === current_name) {
    rename_visible.value = false
    return
  }

  rename_pending.value = true
  try {
    // The server owns the stored name: it normalizes the extension, so the
    // reference rewrite has to use the name that was actually stored rather
    // than the one the prompt produced — otherwise the draft would reference a
    // path no row answers to and the save would treat it as unreferenced.
    const renamed = await content.rename_attachment(story_id.value, current_name, file_name)
    markdown.value = rename_attachment_references(markdown.value, current_name, renamed.file_name)
    story.value = await fetch_story()
    if (story.value) {
      draft_store.advance_base(story.value.markdown, story.value.revision)
    }
    rename_visible.value = false
  }
  catch (ex) {
    // The dialog stays open so the name can be corrected and retried.
    report_operation_error(ex)
  }
  finally {
    rename_pending.value = false
  }
}

/**
 * Attachment operations fail quietly by design — the state stays as it was and
 * a dialog, if one is open, waits for a retry. A rejected request is different:
 * the input itself was refused (markdown that no longer parses, a name taken
 * meanwhile, a folder that is not empty, an attachment someone else deleted),
 * and staying silent would read as the operation having done nothing.
 */
function report_operation_error(ex: unknown) {
  if (is_client_error(ex))
    error(ex)
}

/** Adopt a folder/file operation's scope payload into the local state. */
function apply_scope_payload(payload: ContentAttachmentScope) {
  if (story.value)
    story.value = { ... story.value, attachments: payload.attachments, folders: payload.folders }
}

function on_attachment_create_folder(parent: string | null) {
  folder_parent.value = parent
  folder_name.value = ''
  folder_visible.value = true
}

/**
 * Why the folder cannot be created (null when the name is free). Mirrors the
 * server: the shared name rules first, then the scope's own path space — a name
 * is one path for both kinds, so a file answering to it (or a stored path
 * beneath it, which already makes the name a folder) is refused rather than
 * silently dropped.
 */
const folder_create_conflict = computed(() => {
  const name = folder_name.value.trim()
  if (! name)
    return null
  const path = attachment_path_join(folder_parent.value, name)
  const violation = attachment_path_violation(path)
  if (violation)
    return violation
  return attachment_path_taken(stored_scope_paths.value, path) ? '已有同名文件或文件夹' : null
})

async function create_folder() {
  const name = folder_name.value.trim()
  if (! name || folder_pending.value || folder_create_conflict.value)
    return

  const path = attachment_path_join(folder_parent.value, name)

  folder_pending.value = true
  try {
    apply_scope_payload(await content.create_folder(story_id.value, path))
    expand_folder(path)
    folder_visible.value = false
  }
  catch (ex) {
    report_operation_error(ex)
  }
  finally {
    folder_pending.value = false
  }
}

/**
 * Why the folder rename cannot be submitted (null when the name is submittable).
 * Runs the shared name rules first (so a `.good` folder is refused here rather
 * than by a server round-trip), then the scope's path space: a folder shares it
 * with the files, so a file holding the destination name collides just like
 * another folder would.
 */
const rename_folder_conflict = computed(() => {
  const source = rename_folder_target.value
  const name = rename_folder_name.value.trim()
  if (! source || ! name)
    return null
  const new_folder = attachment_path_join(attachment_folder_of(source), name)
  if (new_folder === source)
    return null
  const violation = attachment_path_violation(new_folder)
  if (violation)
    return violation
  return attachment_path_taken(stored_scope_paths.value, new_folder) ? '目标位置已有同名文件或文件夹' : null
})

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
  if (rename_folder_conflict.value)
    return

  rename_folder_visible.value = false
  await move_folder_to(source, new_folder)
}

function folder_attachment_names(folder: string) {
  return stored_attachments.value
    .filter(attachment => attachment.file_name.startsWith(`${folder}/`))
    .map(attachment => attachment.file_name)
}

/**
 * Reports the files a batch had to leave behind. Everything else in the batch
 * goes through regardless, so the user sees what was kept rather than a batch
 * that quietly did nothing — and rather than one the server refuses whole.
 */
function show_skipped_attachments(items: { name: string, reason?: string }[], message: string) {
  const unique = [... new Map(items.map(item => [item.name, item])).values()]
    .sort((left, right) => compare_attachment_names(left.name, right.name))
  if (! unique.length)
    return
  skipped_notice.value = { message, items: unique }
}
/** Reports a delete's leftovers, files and folders alike. */
function show_delete_skipped(names: string[]) {
  show_skipped_attachments(
    names.map(name => ({ name, reason: delete_reference_reason })),
    '以下项目仍被正文引用，无法删除。请先移除对这些项目的引用！',
  )
}

/** Splits delete targets into the ones that can go and the ones still referenced. */
function split_referenced(names: string[]) {
  const blocked: string[] = []
  const deletable: string[] = []
  for (const name of names) {
    if (is_referenced(name))
      blocked.push(name)
    else
      deletable.push(name)
  }
  return { blocked, deletable }
}

/** A folder can only go when nothing under it survives the delete. */
function folder_deletable(folder: string, blocked: Set<string>) {
  return ! folder_attachment_names(folder).some(name => blocked.has(name))
}

/**
 * Splits a delete target set into what can go and what has to stay: the files
 * the markdown still references, and the folders a surviving file keeps alive
 * (a folder cannot be removed while anything under it stays). `skipped_names`
 * covers both kinds in one reported list, so the count matches the selection.
 */
function split_delete_targets(files: string[], folders: string[]) {
  const { blocked, deletable } = split_referenced(files)
  const blocked_names = new Set(blocked)
  const deletable_folders = folders.filter(folder => folder_deletable(folder, blocked_names))
  const kept_folders = folders.filter(folder => ! deletable_folders.includes(folder))
  return {
    deletable,
    blocked,
    deletable_folders,
    skipped_names: [... blocked, ... kept_folders],
  }
}

/** Why a folder row's own delete cannot run, or empty when it can. */
function folder_delete_blocked_reasons(folder: string) {
  const split = split_delete_targets(folder_attachment_names(folder), [folder])
  return split.deletable_folders.length ? [] : [delete_reference_reason]
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
    confirm_require(event, '确定要删除该空文件夹吗？', () => {
      void delete_folder(folder)
    }, {
      acceptProps: { label: '删除', severity: 'danger' },
    })
    return
  }
  const split = split_delete_targets(names, [folder])
  // Nothing at all can go: skip the prompt, the warning says why.
  if (! split.deletable.length) {
    show_delete_skipped(split.skipped_names)
    return
  }
  // A surviving file keeps the folder itself alive, so only the attachments go.
  const message = split.blocked.length
    ? `确定要永久删除该文件夹中可删除的 ${split.deletable.length} 个附件吗？（另有 ${split.skipped_names.length} 个项目将跳过）`
    : `确定要永久删除该文件夹及其 ${names.length} 个附件吗？`
  confirm_require(event, message, () => {
    void delete_folder_with_attachments(folder, names)
  }, {
    acceptProps: { label: '删除', severity: 'danger' },
  })
}

function selected_delete_targets() {
  const folders = selected_folder_paths.value
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
  if (! folders.length && ! attachments.length)
    return
  const split = split_delete_targets(attachments.map(attachment => attachment.file_name), folders)
  // Nothing at all can go: skip the prompt, the warning says why.
  if (! split.deletable.length && ! split.deletable_folders.length) {
    show_delete_skipped(split.skipped_names)
    return
  }
  const folder_label = split.deletable_folders.length ? ` ${split.deletable_folders.length} 个文件夹` : ''
  const attachment_label = split.deletable.length ? ` ${split.deletable.length} 个附件` : ''
  const target_label = [folder_label, attachment_label].filter(Boolean).join('及')
  const skip_hint = split.skipped_names.length ? `（另有 ${split.skipped_names.length} 个项目将跳过）` : ''
  confirm_require(event, `确定要永久删除所选${target_label}吗？${skip_hint}`, () => {
    void delete_selected_attachments(folders, attachments)
  }, {
    acceptProps: { label: '删除', severity: 'danger' },
  })
}

async function delete_folder(folder: string) {
  delete_folder_pending.add(folder)
  try {
    apply_scope_payload(await content.delete_folder(story_id.value, folder))
  }
  catch (ex) {
    report_operation_error(ex)
  }
  finally {
    delete_folder_pending.delete(folder)
  }
}

async function delete_folder_with_attachments(folder: string, requested: string[]) {
  // The markdown can change while the confirmation is open (a synced edit, or a
  // reference typed into the editor), so the split is redone against the state
  // being submitted: a name that became referenced is reported instead of
  // failing the whole batch server-side.
  const split = split_delete_targets(requested, [folder])
  if (! split.deletable.length) {
    show_delete_skipped(split.skipped_names)
    return
  }
  delete_folder_pending.add(folder)
  let server_skipped: { name: string, reason: string }[] = []
  try {
    if (! base_revision.value)
      throw new Error('缺少档案基础版本，请刷新页面后重试')
    for (const name of split.deletable)
      delete_attachment_pending.add(name)
    const result = await content.update_story(story_id.value, {
      markdown: markdown.value,
      base_revision: base_revision.value,
      delete_files: split.deletable,
    })
    server_skipped = result.skipped.map(item => ({ name: item.file_name, reason: item.reason }))
    story.value = await fetch_story()
    if (story.value)
      draft_store.advance_base(story.value.markdown, story.value.revision)
    // A file that survived keeps the folder alive; deleting it would be a 409.
    if (! split.blocked.length)
      apply_scope_payload(await content.delete_folder(story_id.value, folder))
  }
  catch (ex) {
    if (get_error_status(ex) === 409 && await show_save_conflict())
      return
    report_operation_error(ex)
  }
  finally {
    for (const name of split.deletable)
      delete_attachment_pending.delete(name)
    delete_folder_pending.delete(folder)
  }
  show_skipped_attachments([
    ... split.skipped_names.map(name => ({ name, reason: delete_reference_reason })),
    ... server_skipped,
  ], '以下项目无法删除，已跳过：')
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

/** Splits a move batch into the moves that can land and the ones a taken destination blocks. */
function split_move_targets(moves: { file_name: string, target_folder: string | null }[]) {
  // Destinations are checked against everything that survives the batch plus the
  // moves already accepted, mirroring the server: the batch's own sources are
  // excluded (a chained move frees the name it vacates) and two moves must not
  // land on the same path.
  const sources = new Set(moves.map(move => move.file_name.toLowerCase()))
  const remaining = stored_scope_paths.value.filter(path => ! sources.has(path.toLowerCase()))
  const planned: { file_name: string, target_folder: string | null }[] = []
  const skipped: { name: string, reason?: string }[] = []
  for (const move of moves) {
    const target = attachment_path_join(move.target_folder, attachment_base_name(move.file_name))
    // Already in the target folder: nothing to do, and nothing to report.
    if (target === move.file_name)
      continue
    if (attachment_path_taken([... remaining, ... planned.map(item => attachment_path_join(item.target_folder, attachment_base_name(item.file_name)))], target))
      skipped.push({ name: move.file_name, reason: attachment_name_conflict_message })
    else
      planned.push(move)
  }
  return { planned, skipped }
}

async function execute_attachment_moves(
  moves: { file_name: string, target_folder: string | null }[],
  pending: Omit<NonNullable<typeof move_attachment_pending.value>, 'moves'>,
) {
  // One move batch at a time; the list blocks further drops while this is set.
  if (move_attachment_pending.value || ! moves.length)
    return false
  // The server refuses a batch whole for one taken destination, so the moves
  // that can land are given to it and the blocked ones are reported instead.
  const { planned, skipped } = split_move_targets(moves)
  if (! planned.length) {
    show_skipped_attachments(skipped, '以下附件无法移动，已全部跳过：')
    return false
  }
  move_attachment_pending.value = { ... pending, moves: planned }
  try {
    const result = await content.move_attachments(story_id.value, planned)
    const succeeded = new Set(result.succeeded)
    const server_skipped = result.skipped.map(item => ({ name: item.file_name, reason: item.reason }))
    // Follow the rename in the local markdown whether or not the draft is
    // dirty: the server rewrote the stored markdown, so leaving the editor on
    // the old names would make the tab dirty against the new base and its next
    // save would revert the rename.
    apply_local_attachment_moves(planned.filter(move => succeeded.has(move.file_name)))
    story.value = await fetch_story()
    if (story.value)
      draft_store.advance_base(story.value.markdown, story.value.revision)
    show_skipped_attachments([... skipped, ... server_skipped], '以下附件无法移动，已跳过：')
    return true
  }
  catch (ex) {
    report_operation_error(ex)
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
    await content.move_folder(story_id.value, source_folder, new_folder)
    apply_local_attachment_moves(moves)
    story.value = await fetch_story()
    if (story.value)
      draft_store.advance_base(story.value.markdown, story.value.revision)
    return true
  }
  catch (ex) {
    report_operation_error(ex)
    return false
  }
  finally {
    move_attachment_pending.value = null
  }
}

function open_replace_dialog(attachment: ContentStoryAttachment) {
  replace_target.value = attachment
  replace_name_mode.value = 'keep-name'
  replace_drag_over.value = false
  if (replace_file_input.value) {
    replace_file_input.value.value = ''
  }
  replace_visible.value = true
}

function close_replace_dialog() {
  replace_visible.value = false
  replace_target.value = null
  replace_drag_over.value = false
}

function on_replace_file_picked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  if (file)
    void start_replace_upload(file)
}

function on_replace_drop(event: DragEvent) {
  replace_drag_over.value = false
  const file = event.dataTransfer?.files?.[0] ?? null
  if (file)
    void start_replace_upload(file)
}

function on_replace_paste(event: ClipboardEvent) {
  const file = event.clipboardData?.files?.[0] ?? null
  if (file) {
    event.preventDefault()
    void start_replace_upload(file)
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

/**
 * Queues the replacement as a transfer task: it rides the same pipeline as any
 * upload (multipart, pause/resume, refresh recovery), and the staged object only
 * becomes the file's content when the task's finalize lands the mutation.
 */
async function start_replace_upload(file: File) {
  const target = replace_target.value
  if (! target)
    return
  const mode = replace_name_mode.value
  close_replace_dialog()
  if (replace_file_input.value)
    replace_file_input.value.value = ''
  if (is_encrypted_attachment(file.name)) {
    error('文件名中包含非法字段')
    return
  }

  const result = await tasks_store.start_replace({
    file,
    old_file_name: target.file_name,
    mode,
    on_landed: async (attachment) => {
      // A new-name replacement renames the row, so the draft's references have
      // to follow it; a keep-name one only swaps the bytes behind the name.
      if (attachment.file_name !== target.file_name)
        markdown.value = rename_attachment_references(markdown.value, target.file_name, attachment.file_name)
      story.value = await fetch_story()
      if (story.value)
        draft_store.advance_base(story.value.markdown, story.value.revision)
    },
  })
  for (const refusal of result.rejected)
    error(refusal.reason)
}

function confirm_delete_attachment(event: Event, attachment: ContentStoryAttachment) {
  // The menu reports a referenced file as 已被正文引用; report it here instead of no-oping.
  if (is_referenced(attachment.file_name)) {
    show_delete_skipped([attachment.file_name])
    return
  }

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
    report_operation_error(ex)
  }
  finally {
    delete_attachment_pending.delete(attachment.file_name)
  }
}

async function delete_selected_attachments(folders: string[], attachments: ContentStoryAttachment[]) {
  // Same re-split as delete_folder_with_attachments: the authoritative pass runs
  // against the state being submitted, and whatever it has to skip is reported.
  const split = split_delete_targets(attachments.map(attachment => attachment.file_name), folders)
  const deletable_names = new Set(split.deletable)
  const deletable_attachments = attachments.filter(attachment => deletable_names.has(attachment.file_name))
  if (! deletable_attachments.length && ! split.deletable_folders.length) {
    show_delete_skipped(split.skipped_names)
    return
  }
  for (const folder of split.deletable_folders)
    delete_folder_pending.add(folder)
  let result = { deleted: 0, skipped: [] as { file_name: string, reason: string }[] }
  try {
    result = await delete_attachments(deletable_attachments)
    if (result.deleted === deletable_attachments.length) {
      for (const folder of split.deletable_folders)
        apply_scope_payload(await content.delete_folder(story_id.value, folder))
      clear_selection()
    }
  }
  finally {
    for (const folder of split.deletable_folders)
      delete_folder_pending.delete(folder)
  }
  show_skipped_attachments([
    ... split.skipped_names.map(name => ({ name, reason: delete_reference_reason })),
    ... result.skipped.map(item => ({ name: item.file_name, reason: item.reason })),
  ], '以下项目无法删除，已跳过：')
}

// Sequential deletes: each pass refetches the story and advances the base revision.
async function delete_attachments(attachments: ContentStoryAttachment[]) {
  let deleted = 0
  const skipped: { file_name: string, reason: string }[] = []
  for (const attachment of attachments)
    delete_attachment_pending.add(attachment.file_name)
  try {
    if (! base_revision.value)
      throw new Error('缺少档案基础版本，请刷新页面后重试')
    const result = await content.update_story(story_id.value, {
      markdown: markdown.value,
      base_revision: base_revision.value,
      delete_files: attachments.map(attachment => attachment.file_name),
    })
    skipped.push(... result.skipped)
    story.value = await fetch_story()
    if (story.value)
      draft_store.advance_base(story.value.markdown, story.value.revision)
    deleted = attachments.length
  }
  catch (ex) {
    if (get_error_status(ex) === 409 && await show_save_conflict())
      return { deleted: 0, skipped }
    report_operation_error(ex)
  }
  finally {
    for (const attachment of attachments)
      delete_attachment_pending.delete(attachment.file_name)
  }
  return { deleted, skipped }
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
