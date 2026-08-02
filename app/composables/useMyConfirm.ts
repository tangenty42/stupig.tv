import type { ConfirmationOptions } from 'primevue/confirmationoptions'
import { useConfirm } from 'primevue/useconfirm'

export function useMyConfirm() {
  const confirm = useConfirm()

  function confirm_require(event: Event, message: string, accept: () => void, options: ConfirmationOptions = {}) {
    confirm.require({
      target: event.currentTarget as HTMLElement,
      ... options,
      message,
      rejectProps: { severity: 'secondary', outlined: true, ... options.rejectProps },
      acceptProps: { severity: 'contrast', ... options.acceptProps },
      accept,
    })
  }

  return { confirm_require }
}
