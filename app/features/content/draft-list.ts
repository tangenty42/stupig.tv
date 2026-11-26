import { settings } from '@shared/settings'

/** The current viewer's unpublished drafts, kept up to date by polling and notifications. */
export function useContentDraftList() {
  const { content } = useApi()
  const { user } = useAuth()
  const { error: toast_error } = useMyToast()
  const viewer = computed(() => JSON.stringify([user.value?.id, user.value?.is_admin, user.value?.permissions]))
  type DraftList = Awaited<ReturnType<typeof content.list_drafts>>
  const data = useSyncedState(ref<DraftList | null>(null))
  // No server request is made, so SSR still needs the same pending skeleton
  // that the client shows until its first request settles.
  const loading = ref(true)
  const error = ref<unknown>(null)
  watch(viewer, () => {
    data.value = null
    error.value = null
  }, { flush: 'sync' })
  const ready = useSyncedData<DraftList>(computed(() => data.value?.channel ?? null), content.list_drafts, data, loading, {
    server: false, share: false, fetch_without_resource: true, query_key: computed(() => `draft-list:${viewer.value}`), polling_interval: settings.app.content.draft.keepaliveIntervalMs,
    on_data: () => { error.value = null },
    on_error: (failure) => {
      const notify = error.value === null
      error.value = failure || new Error('草稿加载失败')
      if (notify)
        toast_error(data.value === null ? '草稿列表加载失败，请重试' : '草稿列表更新失败')
    },
  })
  async function refresh() {
    error.value = null
    await (await ready).refresh()
  }
  return { data, loading, error, ready, refresh }
}
