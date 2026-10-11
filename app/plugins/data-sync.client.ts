import { settings } from '@shared/settings'
import { invalidate_unsignalled_queries } from '~/composables/useSyncedData'

export default defineNuxtPlugin((app) => {
  const transport = useDataSync()
  const user = useCookie(settings.app.auth.cookie.userName)
  transport.start({
    user,
    identity_changed: () => invalidate_unsignalled_queries(app),
    handle_remote_logout: () => {
      if (user.value) {
        user.value = null
        reloadNuxtApp()
      }
    },
  })
})
