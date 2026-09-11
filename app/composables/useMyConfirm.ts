import type { ConfirmationOptions } from 'primevue/confirmationoptions'
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
        rejectProps: { severity: 'secondary', outlined: true, ... options.rejectProps },
        acceptProps: { severity: 'contrast', ... options.acceptProps },
        accept,
      })
      void nextTick(() => requestAnimationFrame(() => align_confirm_popup(target)))
    }, 0)
  }

  return { confirm_require }
}

// PrimeVue 4.5 ConfirmPopup never aligns itself on open (alignOverlay only runs
// from its outside-click handler), leaving the popup at the document top-left.
function align_confirm_popup(target: HTMLElement) {
  const popup = document.querySelector<HTMLElement>('.p-confirmpopup')
  if (! popup || ! target.isConnected)
    return

  const target_rect = target.getBoundingClientRect()
  const viewport_width = document.documentElement.clientWidth
  const viewport_height = window.innerHeight

  let left = target_rect.left
  if (left + popup.offsetWidth > viewport_width)
    left = Math.max(0, viewport_width - popup.offsetWidth)

  const below = target_rect.bottom + popup.offsetHeight <= viewport_height
  const top = below ? target_rect.bottom : Math.max(0, target_rect.top - popup.offsetHeight)

  popup.style.left = `${left + window.scrollX}px`
  popup.style.top = `${top + window.scrollY}px`
  popup.classList.toggle('p-confirmpopup-flipped', ! below)
}
