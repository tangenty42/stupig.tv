import type { ContentDeleteImpact } from '@shared/types/content-delete-impact'
import type { ContentReferenceRewriteResult } from '@shared/types/content-reference'
import type { AttachmentPanelInteraction } from './attachments/panel'
import type { CompletionSourceFailure } from './markdown/editor/completions'
import type { LintListItem } from './markdown/editor/lint'
import type { UploadEntry } from './uploads/admission'
import type { AttachmentUploadPick } from './uploads/picks'
import { has_permission } from '@shared/permissions'
import { settings } from '@shared/settings'
import { storeToRefs } from 'pinia'
import { get_error_status } from '~/composables/useApi'
import { content_attachment_markdown } from './attachments/drag'
import { useAttachmentPanel } from './attachments/panel'
import { watch_draft_beforeunload } from './draft-leave'
import { draft_random_id, useContentDraftStore } from './draft.store'
import { useContentStories } from './stories'

export interface StoryEditorActions {
  apply_reference_changes: (before: string, changes: ContentReferenceRewriteResult['changes']) => boolean
  /** Check the publish snapshot synchronously, even while the editor view is catching up. */
  validate: (markdown: string) => readonly LintListItem[] | null
}

interface StoryEditSessionOptions {
  story_id: number | null
  draft_id?: string
  draft_store: ReturnType<typeof useContentDraftStore>
  content: ReturnType<typeof useApi>['content']
  user: ReturnType<typeof useAuth>['user']
  editor: StoryEditorActions
  start_uploads: (entries: UploadEntry[]) => Promise<void>
  toast: Pick<ReturnType<typeof useMyToast>, 'ok' | 'error' | 'info'>
  confirm_require: ReturnType<typeof useMyConfirm>['confirm_require']
}

const upload_insert_failure_message = '附件已上传，但自动插入正文失败，请手动插入~'

/** Page adapter; the store owns the cloud session, command order and recovery text. */
export function useStoryEditSession(options: StoryEditSessionOptions) {
  const { draft_store: store, content, editor, user } = options
  const page_disposed = ref(false)
  let closing = false
  const editor_session_key = ref(0)
  const access_key = () => JSON.stringify([user.value?.id, user.value?.is_admin, user.value?.permissions])
  const identity = access_key()
  const owner = import.meta.client
    ? store.configure({
        get: content.get_draft, acquire: content.acquire_draft, command: content.command_draft,
        rewrite: (id, input) => content.rewrite_draft_references(id, input),
      }, () => (! page_disposed.value || closing) && access_key() === identity,
      (before, result) => editor.apply_reference_changes(before, result.changes))
    : - 1
  const current = () => ! page_disposed.value && access_key() === identity && store.owns(owner)
  const { cloud, phase, markdown, writable: tab_writable, action_pending: save_pending, unpublished_changes: draft_dirty, reference_pending, recovery, review } = storeToRefs(store)
  const private_blocked = computed(() => ! has_permission(user.value, 'content_access', 'full'))
  const draft_storage_error = computed(() => phase.value === 'uncertain' || phase.value === 'forbidden')
  const dismissed_recovery_revision = ref<number>()
  const reference_history_warning_visible = computed({ get: () => !! review.value, set: (value) => {
    if (! value)
      store.review = null
  } })
  const draft_status_label = computed(() => {
    if (recovery.value)
      return '编辑权已变更，恢复区可用'
    if (phase.value === 'uncertain' && store.initialized && store.unconfirmed_changes)
      return '连接中断，修改尚未保存'
    if (store.message)
      return store.message
    if (phase.value === 'acquiring')
      return '正在取得编辑权……'
    if (phase.value === 'forbidden')
      return '云端草稿不可用'
    if (phase.value === 'uncertain')
      return '连接中断'
    if (phase.value === 'releasing')
      return '正在保存并让出编辑权……'
    if (! cloud.value)
      return '正在连接云端草稿……'
    if (save_pending.value)
      return '正在处理草稿……'
    if (reference_pending.value)
      return '正在更新引用……'
    if (dismissed_recovery_revision.value === cloud.value.draft_revision && ! store.unconfirmed_changes)
      return '草稿与云端一致'
    if (! tab_writable.value) {
      if (phase.value === 'readonly' && cloud.value.occupied)
        return '其他页面正在编辑'
      return '正在取得编辑权……'
    }
    if (store.unconfirmed_changes)
      return '修改待保存……'
    return cloud.value.story_id === null || cloud.value.unpublished_changes
      ? '草稿已保存，尚未发布'
      : '与已发布版本一致'
  })
  const delete_pending = save_pending
  const delete_visible = ref(false)
  const delete_impact = ref<ContentDeleteImpact | null>(null)
  const delete_impact_loading = ref(false)
  const draft_open_error = ref<'failed' | 'forbidden' | 'missing' | null>(null)
  const opening_existing = Boolean(options.story_id || options.draft_id)
  let creation_id = ''
  let initial_load: Promise<void> | null = null
  async function load() {
    if (! import.meta.client || ! current() || private_blocked.value
      || draft_open_error.value === 'forbidden' || draft_open_error.value === 'missing') {
      return
    }
    if (initial_load)
      return initial_load
    initial_load = (async () => {
      if (! opening_existing) {
        creation_id ||= draft_random_id()
        const result = await content.create_draft(creation_id)
        if (current() && result.snapshot)
          await navigateTo(`/content/draft-${result.snapshot.id}/edit`, { replace: true })
      }
      else {
        await store.open(options.draft_id ? { id: options.draft_id } : { story_id: options.story_id! })
      }
      if (current())
        draft_open_error.value = null
    })().catch(async (error: unknown) => {
      if (! current() || cloud.value || (error instanceof Error && error.name === 'AbortError'))
        return
      const status = get_error_status(error)
      if (status === 401)
        return
      if (status === 404 && opening_existing) {
        draft_open_error.value = 'missing'
        await navigateTo('/content')
        return
      }
      if (status === 403) {
        draft_open_error.value = 'forbidden'
        return
      }
      if (draft_open_error.value !== 'failed') {
        draft_open_error.value = 'failed'
        options.toast.error(opening_existing ? '云端草稿加载失败，请重试' : '新建草稿失败，请重试')
      }
    }).finally(() => { initial_load = null })
    return initial_load
  }
  let refresh: () => Promise<void> = async () => {}
  let ready = Promise.resolve()
  if (import.meta.client) {
    ready = useSyncedData(computed(() => current() ? cloud.value?.channel ?? null : null), async () => {
      if (! current() || private_blocked.value)
        return null
      if (! cloud.value)
        await load()
      if (current() && cloud.value)
        await store.cycle()
      return cloud.value?.draft_revision ?? null
    }, { immediate: false, server: false, share: false, fetch_without_resource: true, refresh_policy: 'latest',
      query_key: 'draft-keepalive', polling_interval: settings.app.content.draft.keepaliveIntervalMs, on_error: () => {} })
      .then((query) => {
        refresh = query.refresh
        if (current())
          store.set_cycle_trigger(refresh)
      })
  }
  async function retry_draft_open() {
    if (draft_open_error.value === 'failed' && current() && ! private_blocked.value) {
      draft_open_error.value = null
      await refresh()
    }
  }
  let upload_insert_notice_pending = false
  let stop_beforeunload: (() => void) | undefined
  let leave_attempt: Promise<boolean> | null = null
  const resolve_leave = shallowRef<((leave: boolean) => void) | null>(null)
  const draft_leave_visible = computed({
    get: () => resolve_leave.value !== null,
    set: (visible: boolean) => {
      if (! visible)
        finish_draft_leave(false)
    },
  })
  function has_unconfirmed_changes() {
    return current() && ((store.initialized && store.unconfirmed_changes) || !! store.recovery)
  }
  function finish_draft_leave(leave: boolean) {
    const resolve = resolve_leave.value
    resolve_leave.value = null
    resolve?.(leave)
  }
  function before_draft_leave() {
    if (! current())
      return true
    if (leave_attempt)
      return leave_attempt
    if (! has_unconfirmed_changes())
      return true
    leave_attempt = (async () => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          store.flush_changes(controller.signal),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, settings.app.content.draft.requestTimeoutMs)
          }),
        ])
      }
      catch {
        // The guard uses the current draft state even when a request fails.
      }
      finally {
        clearTimeout(timer)
        // Stop sending later snapshots. An in-flight receipt can still confirm its own text.
        controller.abort()
      }
      if (! has_unconfirmed_changes())
        return true
      return new Promise<boolean>((resolve) => {
        resolve_leave.value = resolve
      })
    })().finally(() => { leave_attempt = null })
    return leave_attempt
  }
  function visibility() {
    if (! current())
      return
    store.set_visible(document.visibilityState === 'visible')
    if (upload_insert_notice_pending && store.visible) {
      upload_insert_notice_pending = false
      options.toast.info(upload_insert_failure_message)
    }
  }
  function save_hotkey(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      on_save_click()
    }
  }
  onMounted(() => {
    if (! current())
      return
    stop_beforeunload = watch_draft_beforeunload(has_unconfirmed_changes)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('online', refresh)
    window.addEventListener('pagehide', hidden)
    window.addEventListener('keydown', save_hotkey)
    visibility()
    void refresh()
  })
  function hidden() {
    if (current())
      store.set_visible(false)
  }
  watch(access_key, () => {
    if (store.owns(owner))
      store.clear()
    finish_draft_leave(false)
    draft_open_error.value = null
    editor_session_key.value ++
    delete_visible.value = false
  }, { flush: 'sync' })
  watch(cloud, (snapshot, previous) => {
    if (! previous)
      return
    // Only a different writer's lease invalidates an open same-draft interaction.
    if (! snapshot || snapshot.id !== previous.id || (snapshot.lease_epoch !== previous.lease_epoch && ! snapshot.owned))
      editor_session_key.value ++
  }, { flush: 'sync' })
  watch(() => store.removed, (removed) => {
    if (removed && ! page_disposed.value && access_key() === identity)
      void navigateTo('/content')
  }, { flush: 'sync' })
  watch(() => cloud.value?.story_id, (id) => {
    if (id && ! options.story_id && current())
      void navigateTo(`/content/${id}/edit`, { replace: true })
  })
  onBeforeUnmount(() => {
    stop_beforeunload?.()
    finish_draft_leave(false)
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('online', refresh)
    window.removeEventListener('pagehide', hidden)
    window.removeEventListener('keydown', save_hotkey)
    if (current()) {
      closing = true
      store.set_visible(false)
      // Finish the bounded release before clearing the store; no callback can
      // unlock a disposed page, and a replacement session invalidates it.
      const task = store.cycle()
      void task.finally(() => {
        if (store.owns(owner))
          store.clear()
        closing = false
      }).catch(() => {})
    }
    page_disposed.value = true
  })
  let publish_review_intent: { draft: string, epoch: number, text: string, token: string } | null = null
  watch(review, (value) => {
    if (! value)
      publish_review_intent = null
  }, { flush: 'sync' })
  function validate_publish(text: string) {
    if (! current())
      return false
    const diagnostics = editor.validate(text)
    if (diagnostics === null) {
      options.toast.error('代码编辑器尚未就绪，请稍后再保存')
      return false
    }
    if (diagnostics.some(item => item.severity === 'error')) {
      options.toast.error('请先修正 Markdown 中的错误，再保存档案')
      return false
    }
    return current()
  }
  async function perform(kind: 'publish' | 'reset' | 'delete', expected?: number) {
    if (! current() || ! store.check_writable())
      return
    const requested = kind === 'publish' && cloud.value
      ? { draft: cloud.value.id, epoch: cloud.value.lease_epoch, text: markdown.value }
      : null
    publish_review_intent = null
    try {
      const completed = await store.action(kind, expected, kind === 'publish' ? validate_publish : undefined)
      if (! current())
        return
      if (! completed) {
        if (requested && review.value?.text === requested.text && markdown.value === requested.text
          && cloud.value?.id === requested.draft && cloud.value.lease_epoch === requested.epoch) {
          publish_review_intent = { ... requested, token: review.value.token }
        }
        return
      }
      if (kind === 'publish' && ! store.message && cloud.value?.story_id) {
        options.toast.ok('档案已保存')
        if (! options.story_id)
          await navigateTo(`/content/${cloud.value.story_id}/edit`, { replace: true })
      }
      if (kind === 'reset' && ! store.message)
        editor_session_key.value ++
    }
    catch (error) {
      if (current())
        options.toast.error(error)
    }
  }
  function on_save_click() {
    return perform('publish')
  }
  async function confirm_reference_history_save() {
    if (! current() || ! review.value || ! store.check_writable())
      return
    const intent = publish_review_intent
    const approval = review.value
    const resume_publish = intent && intent.token === approval.token && intent.text === approval.text
      && markdown.value === intent.text && cloud.value?.id === intent.draft && cloud.value.lease_epoch === intent.epoch
    publish_review_intent = null
    try {
      const confirmed = await store.confirm_review()
      // An autosave review only saves the draft. A prior explicit publish may
      // resume only after this exact review succeeds without changing its text.
      if (confirmed && resume_publish && current() && ! review.value && markdown.value === intent.text
        && cloud.value?.id === intent.draft && cloud.value.lease_epoch === intent.epoch) {
        await perform('publish')
      }
    }
    catch (error) {
      if (current())
        options.toast.error(error)
    }
  }
  function confirm_abandon_draft(event: Event) {
    if (! current() || ! cloud.value || ! store.check_writable())
      return
    const revision = cloud.value.draft_revision
    const text = markdown.value
    options.confirm_require(event, '确定要舍弃草稿吗？', () => {
      if (current() && cloud.value?.draft_revision === revision && markdown.value === text)
        void perform('reset', revision)
    })
  }
  async function confirm_delete_story() {
    if (! options.story_id || delete_impact_loading.value || delete_visible.value || ! current() || ! store.check_writable())
      return
    const can_confirm = store.capture_write_permit()
    delete_impact_loading.value = true
    try {
      const impact = await content.get_delete_impact({ kind: 'story', id: options.story_id })
      if (current() && can_confirm()) {
        delete_impact.value = impact
        delete_visible.value = true
      }
    }
    catch {
      if (current())
        options.toast.error('引用检查失败，请重试后再删除')
    }
    finally {
      delete_impact_loading.value = false
    }
  }
  function delete_story_confirmed() {
    if (delete_visible.value && delete_impact.value)
      void perform('delete')
  }
  const after_save: (() => void)[] = []
  watch(save_pending, (pending) => {
    if (! pending) {
      for (const insert of after_save.splice(0))
        insert()
    }
  }, { flush: 'post' })
  async function upload_picks(picks: AttachmentUploadPick[], insert: ((markdown: string) => boolean) | null) {
    if (! options.story_id)
      return options.toast.error('请先保存档案')
    const session_key = editor_session_key.value
    const may_insert = store.capture_write_permit()
    let notified = false
    await options.start_uploads(picks.map(pick => ({
      ... pick,
      on_landed(file) {
        if (! insert || ! current())
          return
        const land = () => {
          if (! current())
            return
          if (session_key === editor_session_key.value && may_insert() && insert(content_attachment_markdown(file)))
            return
          if (notified)
            return
          notified = true
          if (store.visible)
            options.toast.info(upload_insert_failure_message)
          else
            upload_insert_notice_pending = true
        }
        if (save_pending.value)
          after_save.push(land)
        else
          land()
      },
    })))
  }
  function dismiss_recovery() {
    if (recovery.value)
      dismissed_recovery_revision.value = cloud.value?.draft_revision
    recovery.value = ''
  }
  return { cloud, markdown, draft_phase: phase, private_blocked, editor_session_key, draft_storage_error, draft_dirty, draft_status_label,
    save_pending, reference_rewrite_pending: reference_pending, tab_writable,
    reference_history_warning_visible, confirm_reference_history_save, confirm_abandon_draft,
    on_save_click, confirm_delete_story, delete_pending, delete_visible, delete_impact, delete_impact_loading,
    delete_story_confirmed, upload_picks, can_write_now: store.can_write_now, load, ready, draft_open_error, retry_draft_open, recovery, dismiss_recovery,
    before_draft_leave, draft_leave_visible, finish_draft_leave }
}

interface StoryEditingOptions {
  story_id: number | null
  draft_id?: string
  editor: StoryEditorActions
  attachment_interaction: AttachmentPanelInteraction
}

/** Complete editing-page business entry; callers bind the returned state to UI. */
export function useStoryEditing(options: StoryEditingOptions) {
  const { content } = useApi()
  const { user } = useAuth()
  const toast = useMyToast()
  const { confirm_require } = useMyConfirm()
  const story_query = useContentStories()
  const draft_store = useContentDraftStore(options.draft_id ?? options.story_id)
  const { markdown, unconfirmed_changes } = storeToRefs(draft_store)
  const attachment_panel = useAttachmentPanel({
    scope: options.story_id ?? 0,
    markdown: () => unconfirmed_changes.value ? markdown.value : '',
    reference_source: () => ({ markdown: markdown.value }),
    interaction: options.attachment_interaction,
  })
  const session = useStoryEditSession({
    ... options,
    draft_store,
    content,
    user,
    start_uploads: attachment_panel.start,
    toast,
    confirm_require,
  })
  const ready = Promise.all([story_query.ready, attachment_panel.ready, session.ready]).then(() => undefined)
  const catalog = attachment_panel.catalog
  const stories_completion_failure = computed<CompletionSourceFailure | undefined>(() => {
    if (story_query.error.value && ! story_query.loading.value)
      return story_query.stories.value === null ? 'load' : 'refresh'
  })
  const attachments_completion_failure = computed<CompletionSourceFailure | undefined>(() => {
    if (catalog.active && catalog.error.value && ! catalog.loading.value)
      return catalog.data.value === null ? 'load' : 'refresh'
  })

  return {
    ... session,
    ready,
    user,
    existing_stories: story_query.stories,
    stories_completion_failure,
    attachments_completion_failure,
    attachment_panel,
    attachment_workspace: catalog,
  }
}
