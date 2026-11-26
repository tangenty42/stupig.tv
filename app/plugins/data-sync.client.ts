import { settings } from '@shared/settings'
import { invalidate_unsignalled_queries } from '~/composables/useSyncedData'

// Composition root: the transport, identity and API client are wired here so
// none of them imports another in a cycle.
export default defineNuxtPlugin((app) => {
  const transport = useDataSync()
  const { user, handle_remote_logout } = useAuth()
  const { content } = useApi()
  const { info } = useMyToast()
  const stop_reconnect_notice = watch(transport.reconnecting, (reconnecting, _previous, on_cleanup) => {
    if (! reconnecting) {
      return
    }
    const timer = setTimeout(info, settings.app.client.sync.reconnectNoticeDelayMs, '实时更新已中断，正在重连……')
    on_cleanup(() => clearTimeout(timer))
  })
  app.vueApp.onUnmount(stop_reconnect_notice)

  transport.start({
    user,
    identity_changed: () => invalidate_unsignalled_queries(app),
    handle_remote_logout,
    fetch_private_credentials: () => content.draft_sync_credentials(),
  })
})
