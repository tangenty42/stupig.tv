// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { confirm_popup_transition, useMyConfirm } from './useMyConfirm'

const confirmation = vi.hoisted(() => ({ require: vi.fn() }))
vi.mock('primevue/useconfirm', () => ({ useConfirm: () => confirmation }))

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('waits for the triggering click to finish and retains its button and accept action', () => {
  vi.useFakeTimers()
  const button = document.createElement('button')
  const icon = document.createElement('span')
  button.append(icon)
  document.body.append(button)
  const accept = vi.fn()
  const { confirm_require } = useMyConfirm()
  button.addEventListener('click', event => confirm_require(event, 'Continue?', accept))
  icon.click()
  expect(confirmation.require).not.toHaveBeenCalled()
  vi.runAllTimers()
  expect(confirmation.require).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ target: button, accept }))
  expect(accept).not.toHaveBeenCalled()
})

it('positions through public PT state and transition DOM after layout and focus settle', async () => {
  vi.stubGlobal('nextTick', nextTick)
  const target = document.createElement('button')
  const popup = document.createElement('div')
  popup.style.marginTop = '2px'
  document.body.append(target, popup)
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 80, 30))
  vi.spyOn(popup, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 2, 200, 100))
  const state = { visible: true, confirmation: { target } }
  const transition = confirm_popup_transition({ state })
  transition.onEnter(popup)
  expect(popup.style.top).toBe('')
  await nextTick()
  expect(popup.style.top).toBe('80px')
  expect(popup.style.left).toBe('100px')
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(120, 70, 80, 30))
  transition.onAfterEnter(popup)
  await nextTick()
  expect(popup.style.top).toBe('100px')
  expect(popup.style.left).toBe('120px')
  transition.onEnter(popup)
  state.visible = false
  await nextTick()
  expect(popup.style.top).toBe('100px')
  state.visible = true
  target.remove()
  transition.onEnter(popup)
  await nextTick()
  expect(popup.style.top).toBe('100px')
})
