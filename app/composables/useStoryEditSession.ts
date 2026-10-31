import type { ContentMarkdownConfig } from '@shared/content-markdown'
import type { ContentAttachmentWorkspace } from '@shared/types/content'
import type { ContentDeleteImpact } from '@shared/types/content-delete-impact'
import type MyContentMarkdownEditor from '~/components/MyContent/Markdown/Editor.vue'
import type { useContentDraftStore } from '~/stores/contentDraft'
import { has_permission } from '@shared/permissions'
import { settings } from '@shared/settings'
import { storeToRefs } from 'pinia'
import { draft_random_id } from '~/stores/contentDraft'

interface StoryEditSessionOptions {
  story_id: number | null
  draft_id?: string
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

/** Page adapter; the store owns the cloud session, command order and recovery text. */
export function useStoryEditSession(options: StoryEditSessionOptions) {
  const { draft_store: store, content, user, markdown_editor } = options
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
      (before, result) => ! markdown_editor.value || markdown_editor.value.apply_reference_changes(before, result.changes))
    : - 1
  const current = () => ! page_disposed.value && access_key() === identity && store.owns(owner)
  const { cloud, phase, markdown, writable: tab_writable, action_pending: save_pending, unpublished_changes: draft_dirty, reference_pending, recovery, review } = storeToRefs(store)
  const private_blocked = computed(() => ! has_permission(user.value, 'content_manage', 'full') || ! has_permission(user.value, 'content_private', 'read'))
  const reference_rewrite_pending = computed(() => reference_pending.value || !! options.reference_sync_pending?.())
  const draft_storage_error = computed(() => phase.value === 'uncertain' || phase.value === 'forbidden')
  const tab_lock_unavailable = ref(false)
  const discard_draft_pending = save_pending
  const reference_history_warning_visible = computed({ get: () => !! review.value, set: (value) => {
    if (! value)
      store.review = null
  } })
  const draft_status_label = computed(() => {
    if (private_blocked.value)
      return '没有草稿访问权限'
    if (store.message)
      return store.message
    if (phase.value === 'acquiring')
      return '正在取得编辑权…'
    if (phase.value === 'forbidden')
      return '云端草稿不可用'
    if (phase.value === 'uncertain')
      return '连接中断'
    if (phase.value === 'releasing')
      return '正在保存并让出编辑权…'
    if (! cloud.value)
      return '正在连接云端草稿…'
    if (save_pending.value)
      return '正在处理草稿…'
    if (reference_rewrite_pending.value)
      return '正在更新引用…'
    if (! tab_writable.value) {
      if (phase.value === 'readonly' && cloud.value.occupied)
        return '其他页面正在编辑'
      return '正在取得编辑权…'
    }
    if (store.unconfirmed_changes)
      return '修改待上传…'
    return cloud.value.unpublished_changes ? '草稿已自动保存' : '草稿与云端一致'
  })
  const delete_pending = save_pending
  const delete_visible = ref(false)
  const delete_impact = ref<ContentDeleteImpact | null>(null)
  const delete_impact_loading = ref(false)
  const delete_impact_failure = ref(false)
  let delete_generation = 0
  let creation_id = ''
  let initial_load: Promise<void> | null = null
  async function load() {
    if (! import.meta.client || ! current() || private_blocked.value)
      return
    if (initial_load)
      return initial_load
    initial_load = (async () => {
      if (! options.story_id && ! options.draft_id) {
        creation_id ||= draft_random_id()
        const result = await content.create_draft(creation_id)
        if (current() && result.snapshot)
          await navigateTo(`/content/draft-${result.snapshot.id}/edit`, { replace: true })
      }
      else {
        await store.open(options.draft_id ? { id: options.draft_id } : { story_id: options.story_id! })
      }
    })().finally(() => { initial_load = null })
    return initial_load
  }
  let refresh: () => Promise<void> = async () => {}
  if (import.meta.client) {
    void useSyncedData(computed(() => current() ? cloud.value?.channel ?? null : null), async () => {
      if (! current() || private_blocked.value)
        return null
      if (! cloud.value)
        await load()
      if (current())
        await store.cycle()
      return cloud.value?.draft_revision ?? null
    }, { immediate: false, server: false, universal: false, fetch_without_resource: true,
      query_key: `draft-page:${draft_random_id()}`, polling_interval: settings.app.content.draft.keepaliveIntervalMs, on_error: () => {} })
      .then((query) => {
        refresh = query.refresh
        if (current())
          store.set_cycle_trigger(refresh)
      })
  }
  function visibility() {
    if (current())
      store.set_visible(document.visibilityState === 'visible')
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
    editor_session_key.value ++
    delete_visible.value = false
  }, { flush: 'sync' })
  watch(() => cloud.value?.lease_epoch, (epoch, previous) => {
    if (epoch !== previous)
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
  async function perform(kind: 'publish' | 'reset' | 'delete', expected?: number) {
    if (! current() || ! store.check_writable())
      return
    try {
      const completed = await store.action(kind, expected)
      if (! completed)
        return
      if (! current())
        return
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
    void perform('publish')
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
  async function load_delete_impact() {
    const generation = ++ delete_generation
    delete_impact_loading.value = true
    delete_impact_failure.value = false
    try {
      const impact = options.story_id ? await content.get_delete_impact({ kind: 'story', id: options.story_id }) : { targets: [], sources: [] }
      if (current() && generation === delete_generation)
        delete_impact.value = impact
    }
    catch {
      if (current() && generation === delete_generation)
        delete_impact_failure.value = true
    }
    finally {
      if (current() && generation === delete_generation)
        delete_impact_loading.value = false
    }
  }
  function confirm_delete_story() {
    if (! current() || ! store.check_writable())
      return
    delete_visible.value = true
    void load_delete_impact()
  }
  function delete_story_confirmed() {
    if (delete_visible.value && delete_impact.value && ! delete_impact_loading.value && ! delete_impact_failure.value)
      void perform('delete')
  }
  return { cloud, markdown, private_blocked, page_disposed, editor_session_key, draft_storage_error, draft_dirty, draft_status_label,
    save_pending, reference_rewrite_pending, tab_writable, tab_lock_unavailable, discard_draft_pending,
    reference_history_warning_visible, confirm_reference_history_save: () => store.confirm_review(), confirm_abandon_draft,
    on_save_click, confirm_delete_story, delete_pending, delete_visible, delete_impact, delete_impact_loading, delete_impact_failure,
    load_delete_impact, delete_story_confirmed, load, recovery }
}
