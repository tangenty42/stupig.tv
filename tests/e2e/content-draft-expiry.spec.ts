import { expect } from '@playwright/test'
import { settings } from '@shared/settings'
import { create_story, login, markdown, ready, test } from '../support/e2e-browser'

test('takes over after lease expiry when a closed page cannot deliver its release', async ({ page, context, browser }) => {
  test.setTimeout(90000)
  await login(page)
  const story = await create_story(page)
  const other = await browser.newContext({ storageState: await context.storageState(), baseURL: new URL(page.url()).origin })
  try {
    const second = await other.newPage()
    await second.goto(`/content/${story.id}/edit`)
    await ready(second)
    const editor = second.getByRole('textbox', { name: /Markdown/ })
    await expect(editor).not.toBeEditable()
    // Actual transport failure; a local focus/offline event would leave the
    // server's active lease unchanged and would not verify expiry fallback.
    await page.route('**/api/trpc/**commandDraft**', route => route.abort('internetdisconnected'))
    await page.close()
    const timing = settings.app.content.draft
    await expect(editor).toBeEditable({ timeout: 2 * timing.keepaliveIntervalMs + 3 * timing.requestTimeoutMs + timing.leaseMarginMs + 5000 })
    await editor.fill(markdown(story.title, 'new owner after expiry'))
    await second.getByRole('button', { name: '保存', exact: true }).click()
    await expect(second.getByText('档案已保存', { exact: true })).toBeVisible()
  }
  finally { await other.close() }
})
