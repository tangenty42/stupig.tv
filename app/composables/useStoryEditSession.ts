import type { ContentMarkdownConfig } from '@shared/content-markdown'
import type { ContentAttachmentWorkspace, ContentStoryBody } from '@shared/types/content'
import type { ContentReferenceRewriteResult } from '@shared/types/content-reference'
import type MyContentMarkdownEditor from '~/components/MyContent/Markdown/Editor.vue'
import type { ContentDraftRecord, useContentDraftStore } from '~/stores/contentDraft'
import { parse_public_api_error } from '@shared/api-error'
import { parse_story_markdown } from '@shared/content-markdown'
import { has_permission } from '@shared/permissions'
import { storeToRefs } from 'pinia'
import { create_draft_reference_bridge, reference_review_can_confirm } from '~/utils/content/draft-reference-bridge'
import { read_content_resource } from '~/utils/content/read-resource'

interface StoryEditSessionOptions {
  story_id: number | null
  draft_store: ReturnType<typeof useContentDraftStore>
  content: ReturnType<typeof useApi>['content']
  user: ReturnType<typeof useAuth>['user']
  workspace: Ref<ContentAttachmentWorkspace | null>
  title_reference_version: Ref<{ title_revision: number } | null>
  markdown_editor: Ref<InstanceType<typeof MyContentMarkdownEditor> | undefined>
  markdown_config: () => ContentMarkdownConfig
  new_markdown: () => string
  reference_sync_pending?: () => boolean
  toast: Pick<ReturnType<typeof useMyToast>, 'ok' | 'error'>
  confirm_require: ReturnType<typeof useMyConfirm>['confirm_require']
}

/**
 * One page's draft/base/reference/save lifecycle. Resource subscriptions remain
 * with the page, and delegate incoming bodies to this session's synced setter.
 */
export function useStoryEditSession(options: StoryEditSessionOptions) {
  const { content, user, draft_store, markdown_editor, title_reference_version, confirm_require } = options
  const { ok, error } = options.toast
  const is_edit = computed(() => options.story_id !== null)
  const story_id = computed(() => options.story_id ?? 0)
  const story = useState<ContentStoryBody | null>(`content_story_edit:${options.story_id ?? 'new'}`, () => null)
  const attachment_workspace = { data: options.workspace }
  const content_markdown_config = computed(options.markdown_config)
  const page_disposed = ref(false)
  let initial_markdown = ''
  let initial_revision: number | null = null
  let initialized = false
  const {
    markdown,
    base_revision,
    base_namespace_revision,
    base_title_revision,
    draft_saved_at,
    autosave_pending: draft_autosave_pending,
    storage_error: draft_storage_error,
    dirty: draft_dirty,
  } = storeToRefs(draft_store)

  // A story holding private elements is editable only with the content_private
  // permission: the server strips them for everyone else, so editing here would
  // silently delete them on save (the server save guard blocks it anyway).
  const private_blocked = computed(() =>
    is_edit.value && !! story.value?.has_private && (! story.value.private_readable || ! has_permission(user.value, 'content_private', 'read')))

  const save_pending = ref(false)
  const story_sync_pending = ref(false)
  const reference_request_pending = ref(false)
  const reference_rewrite_pending = computed(() => story_sync_pending.value || reference_request_pending.value || !! options.reference_sync_pending?.())
  const delete_pending = ref(false)
  const draft_conflict_visible = ref(false)
  const pending_conflict_draft = ref<ContentDraftRecord | null>(null)
  const discard_draft_pending = ref(false)
  const draft_status_label = computed(() => {
    if (save_pending.value)
      return is_edit.value ? '正在保存到服务器...' : '正在创建档案...'
    if (reference_rewrite_pending.value)
      return '正在更新正文引用...'
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

  async function fetch_story() {
    if (! is_edit.value)
      return null
    return await read_content_resource(() => content.get_story_body(story_id.value))
  }

  async function load() {
    try {
      story.value = await fetch_story()
    }
    catch {
      error('获取档案信息失败')
    }
  }
  const reference_review = ref<ContentReferenceRewriteResult | null>(null)
  let reference_review_snapshot = ''
  const reference_bridge = create_draft_reference_bridge({
    snapshot: () => is_edit.value && story.value && draft_store.initialized && ! private_blocked.value
      ? {
          story_id: story_id.value,
          local_revision: draft_store.edit_version,
          viewer_key: `${user.value?.id ?? 'anon'}:${story.value.viewer_key}`,
          markdown: markdown.value,
          namespace_revision: Math.max(story.value.namespace_revision ?? 0, attachment_workspace.data.value?.namespace_revision ?? 0),
          title_revision: Math.max(story.value.title_revision ?? 0, title_reference_version.value?.title_revision ?? 0),
          base_namespace_revision: base_namespace_revision.value,
          base_title_revision: base_title_revision.value,
          saving: save_pending.value,
        }
      : null,
    rewrite: snapshot => content.rewrite_draft_references(snapshot.story_id, snapshot),
    on_pending: pending => reference_request_pending.value = pending,
    apply: (snapshot, result) => {
      reference_review.value = result.diagnostics.length || result.baseline_unavailable.namespace || result.baseline_unavailable.title ? result : null
      reference_review_snapshot = snapshot.markdown
      if (result.diagnostics.some(item => item.reason === 'replaced'))
        return true
      if (markdown_editor.value && ! markdown_editor.value.apply_reference_changes(snapshot.markdown, result.changes))
        return false
      markdown.value = result.markdown
      base_namespace_revision.value = result.base_namespace_revision
      base_title_revision.value = result.base_title_revision
      return true
    },
    on_error: () => {},
  })
  function initialize() {
    if (initialized)
      return
    initial_markdown = is_edit.value ? (story.value?.markdown ?? '') : options.new_markdown()
    initial_revision = is_edit.value ? (story.value?.revision ?? null) : null
    // A missing story must not initialize an empty base and erase a stored draft
    // on the next persistence/unmount pass.
    if (! is_edit.value || story.value)
      draft_store.initialize(initial_markdown, initial_revision, attachment_workspace.data.value?.namespace_revision ?? story.value?.namespace_revision ?? null, story.value?.title_revision ?? null)
    if (private_blocked.value || (is_edit.value && ! story.value))
      draft_store.suspend()

    if (import.meta.client) {
      watch([markdown, base_namespace_revision, base_title_revision, () => story.value?.namespace_revision, () => attachment_workspace.data.value?.namespace_revision, title_reference_version, save_pending, () => user.value?.id], () => {
        void reference_bridge.request()
      }, { flush: 'sync' })
    }

    initialized = true
  }
  function confirm_reference_targets(event: Event) {
    confirm_require(event, '确认让这些引用指向当前的同名目标？', () => {
      const result = reference_review.value
      if (result && ! reference_review_can_confirm(result))
        return
      if (! result || markdown.value !== reference_review_snapshot) {
        reference_bridge.invalidate()
        void reference_bridge.request()
        return
      }
      const reviewed = result.confirmation ?? result
      if (markdown_editor.value && ! markdown_editor.value.apply_reference_changes(reference_review_snapshot, reviewed.changes))
        return
      markdown.value = reviewed.markdown
      base_namespace_revision.value = result.baseline_unavailable.namespace ? base_namespace_revision.value : result.namespace_revision
      base_title_revision.value = result.baseline_unavailable.title ? base_title_revision.value : result.title_revision
      reference_review.value = null
      draft_store.persist_now()
    })
  }

  const synced_story = useSyncedState(computed<ContentStoryBody | null>({
    get: () => story.value,
    set: (latest_story) => {
      if (! latest_story) {
        // A clean tab must not remove a draft just persisted by another tab.
        if (draft_dirty.value)
          draft_store.persist_now()
        draft_store.suspend()
        story.value = null
        reference_bridge.invalidate()
        reference_review.value = null
        return
      }
      if (story.value?.viewer_key === latest_story.viewer_key && story.value?.id === latest_story.id && latest_story.namespace_revision < story.value.namespace_revision)
        return
      if (latest_story.has_private && ! latest_story.private_readable) {
        if (draft_store.initialized)
          draft_store.persist_now()
        draft_store.initialize(latest_story.markdown, latest_story.revision, latest_story.namespace_revision, latest_story.title_revision ?? null)
        draft_store.suspend()
        story.value = latest_story
        reference_review.value = null
        return
      }
      if (! draft_store.initialized) {
        story.value = latest_story
        const draft = draft_store.read_persisted()
        draft_store.initialize(latest_story.markdown, latest_story.revision, latest_story.namespace_revision, latest_story.title_revision ?? null)
        if (draft)
          draft_store.restore(draft, latest_story.markdown)
        reference_bridge.invalidate()
        void reference_bridge.request()
        return
      }
      if (draft_dirty.value) {
        if (story.value)
          story.value = { ... story.value, namespace_revision: latest_story.namespace_revision, title_revision: latest_story.title_revision }
        return
      }
      story.value = latest_story
      draft_store.mark_saved(latest_story.markdown, latest_story.revision, latest_story.namespace_revision ?? null, latest_story.title_revision ?? null)
    },
  }))
  onMounted(() => {
    window.addEventListener('pagehide', persist_draft_on_page_hide)
    window.addEventListener('keydown', on_save_hotkey)

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
    reference_bridge.invalidate()
    void reference_bridge.request()
    ok('已恢复自动保存的本地草稿')
  })

  onBeforeUnmount(() => {
    page_disposed.value = true
    reference_bridge.stop()
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
    reference_bridge.invalidate()
    reference_review.value = null
    draft_store.discard()
    draft_store.initialize(
      story.value?.markdown ?? initial_markdown,
      story.value?.revision ?? initial_revision,
      story.value?.namespace_revision ?? null,
      story.value?.title_revision ?? null,
    )
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

  function on_save_click() {
    if (reference_rewrite_pending.value || save_pending.value)
      return
    if (is_edit.value && ! story.value)
      return
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
      const submitted = markdown.value
      const result = await content.update_story(story_id.value, {
        markdown: submitted,
        base_revision: base_revision.value,
        base_namespace_revision: base_namespace_revision.value,
        base_title_revision: base_title_revision.value,
      })

      story.value = await fetch_story()
      if (story.value) {
        if (markdown.value === submitted)
          draft_store.mark_saved(result.markdown, result.revision, result.namespace_revision, result.title_revision)
        else
          draft_store.advance_base(result.markdown, result.revision)
      }
      ok('档案已保存')
    }
    catch (ex) {
      const application_error = parse_public_api_error(ex)
      if (application_error?.code === 'REF_TARGET_REPLACED') {
        reference_bridge.invalidate()
        return
      }
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
        // The shared local draft key may now belong to another open editor.
        if (draft_dirty.value)
          draft_store.persist_now()
        draft_store.suspend()
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

  return { story, private_blocked, page_disposed, draft_storage_error, draft_dirty, draft_status_label,
    save_pending, story_sync_pending, reference_rewrite_pending, delete_pending, draft_conflict_visible, pending_conflict_draft, discard_draft_pending,
    reference_review, synced_story, fetch_story, load, initialize, confirm_reference_targets, confirm_abandon_draft,
    use_database_version, restore_conflicting_draft, on_save_click, confirm_delete_story }
}
