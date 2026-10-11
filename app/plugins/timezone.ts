import { settings } from '@shared/settings'

export default defineNuxtPlugin((nuxt_app) => {
  const timezone_cookie = useCookie<string | null>(settings.app.client.timezone.cookieName)
  const time_context = useDisplayTimeContext()

  if (import.meta.server) {
    time_context.value.timezone = timezone_cookie.value || 'UTC'
  }

  if (import.meta.client) {
    nuxt_app.hook('app:suspense:resolve', () => {
      const timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone
      timezone_cookie.value = timezone
      time_context.value = {
        now_ms: Date.now(),
        timezone,
      }
      const clock_interval = setInterval(() => {
        time_context.value.now_ms = Date.now()
      }, 1000)
      nuxt_app.vueApp.onUnmount(() => clearInterval(clock_interval))
    })
  }
})
