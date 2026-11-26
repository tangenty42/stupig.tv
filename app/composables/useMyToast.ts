import { useToast } from 'primevue/usetoast'

const TOAST_LIFE = 3000

interface ToastDetailWithBadge {
  before: string
  badge: string
  after: string
}

export function useMyToast() {
  const toast = useToast()
  const muted = useState('toast-muted', () => false)

  function show_error(detail: string | readonly ToastDetailWithBadge[]) {
    if (muted.value || ! detail.length) {
      return
    }

    onNuxtReady(() => toast.add({
      detail,
      life: TOAST_LIFE,
      severity: 'warn',
      summary: '出错了',
    }))
  }

  function error(title_or_error: unknown) {
    show_error(error_message(title_or_error))
  }

  function grouped_error(details: readonly ToastDetailWithBadge[]) {
    show_error(details)
  }

  function ok(detail: string | ToastDetailWithBadge) {
    if (muted.value) {
      return
    }

    onNuxtReady(() => toast.add({
      detail,
      life: TOAST_LIFE,
      severity: 'success',
      summary: '搞定',
    }))
  }

  function info(title: string) {
    if (muted.value) {
      return
    }

    onNuxtReady(() => toast.add({
      detail: title,
      life: TOAST_LIFE,
      severity: 'info',
      summary: '提示',
    }))
  }

  function dead() {
    muted.value = true
  }

  function clear() {
    toast.removeAllGroups()
  }

  return {
    error,
    grouped_error,
    ok,
    info,
    dead,
    clear,
  }
}
