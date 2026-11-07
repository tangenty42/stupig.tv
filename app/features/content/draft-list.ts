import { settings } from '@shared/settings'

/** The current viewer's unpublished drafts, paged by cursor and kept alive by polling. */
export function useContentDraftList() {
  const { content } = useApi()
  const { user } = useAuth()
  const after = ref('')
  const viewer = computed(() => JSON.stringify([user.value?.id, user.value?.is_admin, user.value?.permissions]))
  const data = ref<Awaited<ReturnType<typeof content.list_drafts>> | null>(null)
  const loading = ref(false)
  const ready = useSyncedData(computed(() => data.value?.channel ?? null), () => content.list_drafts(after.value), data, loading, {
    server: false, share: false, fetch_without_resource: true, query_key: computed(() => `draft-list:${viewer.value}:${after.value}`), polling_interval: settings.app.content.draft.keepaliveIntervalMs,
  }).then(() => undefined)
  watch([viewer, after], () => {
    data.value = null
  }, { flush: 'sync' })
  return { data, loading, after, ready }
}
