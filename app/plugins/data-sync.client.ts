import { invalidate_unsignalled_queries } from '~/composables/useSyncedData'

export default defineNuxtPlugin((app) => {
  const transport = useDataSync()
  const { user, handle_remote_logout } = useAuth()
  transport.start({
    user,
    identity_changed: () => invalidate_unsignalled_queries(app),
    handle_remote_logout,
  })
})
