import { expect } from '@playwright/test'
import { login, test } from '../support/e2e-browser'

test('waits for a position-stable login dialog to finish entering before typing', async ({ page }) => {
  await page.addInitScript(() => {
    const early_input: string[] = []
    Object.assign(window, { __STUPIG_E2E_EARLY_LOGIN_INPUT__: early_input })
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style')
      // Opacity changes keep the input's box stable for Playwright clicks while
      // Dialog's after-enter focus is still pending.
      style.textContent = `
        @keyframes e2e-login-enter { from { opacity: 0.2; } to { opacity: 1; } }
        .p-dialog.p-dialog-enter-active { animation: e2e-login-enter 1s linear both !important; }
      `
      document.head.append(style)
    }, { once: true })
    document.addEventListener('input', (event) => {
      const input = event.target
      if (! (input instanceof HTMLInputElement) || ! input.closest('#login-password-form'))
        return
      const dialog = input.closest('[role="dialog"]')
      if (dialog?.getAnimations().some(animation => animation.playState === 'running'))
        early_input.push(input.name)
    }, true)
  })
  await login(page)
  const early_input = await page.evaluate(() => (window as Window & { __STUPIG_E2E_EARLY_LOGIN_INPUT__?: string[] }).__STUPIG_E2E_EARLY_LOGIN_INPUT__)
  expect(early_input).toEqual([])
})
