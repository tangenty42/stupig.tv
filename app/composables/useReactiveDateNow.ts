import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'

interface ReactiveDateNow {
  now: Ref<Dayjs>
  interval_id: NodeJS.Timeout
  /** Mounted callers sharing this clock; the interval stops when it reaches zero. */
  refs: number
}

// Module scope rather than useState. useState hands back a reactive proxy, and a
// proxy unwraps the Ref held inside it, so `entry.now.value = dayjs()` wrote to a
// dead property and the clock never advanced. This clock is client-only (the
// server returns above), so it needs no payload involvement either.
const clocks = new Map<number, ReactiveDateNow>()

export function useReactiveDateNow(interval_ms = 1000) {
  if (import.meta.server) {
    // Remember to set the timezone in the server-side rendering context.
    return ref(localize_date(dayjs()))
  }

  let entry = clocks.get(interval_ms)
  if (! entry) {
    // The interval closes over this entry's ref rather than re-reading the map,
    // so a later clock for the same interval can never be written by this one.
    const now = ref(dayjs())
    entry = {
      now,
      interval_id: setInterval(() => {
        now.value = dayjs()
      }, interval_ms),
      refs: 0,
    }
    clocks.set(interval_ms, entry)
  }

  entry.refs ++
  const acquired = entry

  // Every caller releases, not just the one that created the clock: with a
  // single releaser, the first component to unmount took the interval away from
  // the components still mounted on it.
  onUnmounted(() => {
    acquired.refs --
    if (acquired.refs > 0)
      return
    clearInterval(acquired.interval_id)
    // Only drop the entry still registered under this interval; a recreated
    // clock for the same interval belongs to other callers.
    if (clocks.get(interval_ms) === acquired) {
      clocks.delete(interval_ms)
    }
  })

  return acquired.now
}
