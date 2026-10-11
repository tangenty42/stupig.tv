import { computed } from 'vue'
import { localize_date } from '~/utils/time'
import { useDisplayTimeContext } from './useDisplayTimeContext'

export function useReactiveDateNow() {
  const time_context = useDisplayTimeContext()
  return computed(() => localize_date(time_context.value.now_ms, false, time_context.value.timezone))
}
