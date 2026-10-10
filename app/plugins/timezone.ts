import { settings } from '@shared/settings'

export default defineNuxtPlugin(() => {
  const timezone_cookie = useCookie<string | null>(settings.app.client.timezone.cookieName)
  if (import.meta.client) {
    timezone_cookie.value = new Intl.DateTimeFormat().resolvedOptions().timeZone
  }
  set_display_timezone(timezone_cookie.value)
  watch(timezone_cookie, tz => set_display_timezone(tz))
})
