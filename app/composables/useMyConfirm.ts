import type { ConfirmationOptions } from 'primevue/confirmationoptions'
import type { ConfirmPopupPassThroughMethodOptions } from 'primevue/confirmpopup'
import { useConfirm } from 'primevue/useconfirm'
import { confirm_popup_position } from '~/utils/confirm-popup'

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
// Position the public transition element after content and focus have settled.
export function confirm_popup_transition({ state }: Pick<ConfirmPopupPassThroughMethodOptions, 'state'>) {
  // PT state and the Vue transition element are public; component methods are not.
  const align = (element: Element) => {
    const target = state.confirmation?.target
    if (! state.visible || ! target?.isConnected || ! (element instanceof HTMLElement) || ! element.isConnected)
      return
    const document = element.ownerDocument
    const view = document.defaultView
    if (! view)
      return
    const style = view.getComputedStyle(element)
    const margin_top = Number.parseFloat(style.marginTop) || 0
    const margin_left = Number.parseFloat(style.marginLeft) || 0
    const position = confirm_popup_position(target.getBoundingClientRect(), element.getBoundingClientRect(), {
      width: document.documentElement.clientWidth || view.innerWidth,
      height: document.documentElement.clientHeight || view.innerHeight,
    }, Math.abs(margin_top), style.direction === 'rtl')
    element.style.top = `${position.top + view.scrollY - margin_top}px`
    element.style.left = `${position.left + view.scrollX - margin_left}px`
  }
  return {
    onEnter: (element: Element) => { void nextTick(() => align(element)) },
    onAfterEnter: (element: Element) => { void nextTick(() => align(element)) },
  }
}
