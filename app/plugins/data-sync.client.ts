import { invalidate_unsignalled_queries } from '~/composables/useSyncedData'

// Composition root: the transport, identity and API client are wired here so
// none of them imports another in a cycle.
export default defineNuxtPlugin((app) => {
  const transport = useDataSync()
  const { user, handle_remote_logout } = useAuth()
  const { content } = useApi()
  transport.start({
    user,
    identity_changed: () => invalidate_unsignalled_queries(app),
    handle_remote_logout,
    fetch_private_credentials: () => content.draft_sync_credentials(),
  })
})
