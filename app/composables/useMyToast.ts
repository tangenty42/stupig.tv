import { useToast } from 'primevue/usetoast'

const TOAST_LIFE = 3000
let deadly = false

export function useMyToast() {
  const toast = useToast()

  function error(title_or_error: unknown) {
    const msg = error_message(title_or_error)
    if (deadly || ! msg) {
      return
    }

    onNuxtReady(() => toast.add({
      detail: msg,
      life: TOAST_LIFE,
      severity: 'warn',
      summary: '出错了',
    }))
  }

  function ok(title: string) {
    if (deadly) {
      return
    }

    onNuxtReady(() => toast.add({
      detail: title,
      life: TOAST_LIFE,
      severity: 'success',
      summary: '搞定',
    }))
  }

  function info(title: string) {
    if (deadly) {
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
    deadly = true
  }

  function clear() {
    toast.removeAllGroups()
  }

  return {
    error,
    ok,
    info,
    dead,
    clear,
  }
}
