import type { ConfirmPopupPassThroughMethodOptions } from 'primevue/confirmpopup'
import { afterEach, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { confirm_popup_transition } from './useMyConfirm'

afterEach(() => vi.unstubAllGlobals())

it('uses the popup own alignment after enter layout and after focus settles', async () => {
  vi.stubGlobal('nextTick', nextTick)
  const instance = { visible: true, container: {}, target: { isConnected: true }, alignOverlay: vi.fn() }
  const transition = confirm_popup_transition({ instance } as ConfirmPopupPassThroughMethodOptions)
  transition.onEnter()
  expect(instance.alignOverlay).not.toHaveBeenCalled()
  await nextTick()
  expect(instance.alignOverlay).toHaveBeenCalledOnce()
  transition.onAfterEnter()
  await nextTick()
  expect(instance.alignOverlay).toHaveBeenCalledTimes(2)
  transition.onEnter()
  instance.visible = false
  await nextTick()
  expect(instance.alignOverlay).toHaveBeenCalledTimes(2)
})
