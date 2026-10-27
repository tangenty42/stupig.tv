import { expect } from '@playwright/test'
import { create_story, login, ready, test } from '../support/e2e-browser'

test('all application pages render and dismiss the loading mask before its fallback', async ({ page }) => {
  await login(page)
  const { id } = await create_story(page)
  for (const path of ['/', '/contact', '/content', '/admin', '/u/1', `/content/${id}`, `/content/${id}/edit`, '/content/new/edit']) {
    await test.step(path, async () => {
      const response = await page.goto(path, { waitUntil: 'domcontentloaded' })
      expect(response?.status()).toBeLessThan(400)
      await ready(page)
      await expect(page.locator('main')).toContainText(/\S/)
    })
  }
})
