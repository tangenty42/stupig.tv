import type { ConfirmationOptions } from 'primevue/confirmationoptions'
import type { ConfirmPopupPassThroughMethodOptions } from 'primevue/confirmpopup'
import { useConfirm } from 'primevue/useconfirm'

export function useMyConfirm() {
  const confirm = useConfirm()

  function confirm_require(event: Event, message: string, accept: () => void, options: ConfirmationOptions = {}) {
    const target = event.currentTarget as HTMLElement
    // Defer past the current click dispatch: PrimeVue 4.5 ConfirmPopup renders and
    // binds its document-level outside-click listener while the triggering click is
    // still bubbling, so that same click would instantly close the popup.
    setTimeout(() => {
      confirm.require({
        target,
        ... options,
        message,
        rejectProps: { severity: 'secondary', text: true, ... options.rejectProps },
        acceptProps: { severity: 'contrast', ... options.acceptProps },
        accept,
      })
    }, 0)
  }

  return { confirm_require }
}

// PrimeVue 4.5 only calls alignOverlay from its document-click listener.
// Use that same positioning on enter, after the content and focus have settled.
export function confirm_popup_transition({ instance }: ConfirmPopupPassThroughMethodOptions) {
  const align = () => {
    if (! instance.visible || ! instance.container || ! instance.target?.isConnected)
      return
    instance.alignOverlay()
  }
  return {
    onEnter: () => { void nextTick(align) },
    onAfterEnter: () => { void nextTick(align) },
  }
}
