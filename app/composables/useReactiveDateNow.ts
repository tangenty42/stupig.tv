import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'

let clock_interval: ReturnType<typeof setInterval> | null = null

export function useReactiveDateNow(interval_ms = 1000) {
  if (import.meta.server) {
    // Remember to set the timezone in the server-side rendering context.
    return ref(localize_date(dayjs()))
  }

  const clock = useState<Dayjs>('reactive_date_now', () => dayjs())

  if (clock_interval !== null) {
    return clock
  }

  clock_interval = setInterval(() => {
    clock.value = dayjs()
  }, interval_ms)

  onUnmounted(() => {
    if (clock_interval !== null) {
      clearInterval(clock_interval)
      clock_interval = null
    }
  })

  return clock
}
