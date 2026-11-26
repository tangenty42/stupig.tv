import { expect } from '@playwright/test'
import { test } from '../support/e2e-browser'

test('the first-paint cover eventually releases the page when hydration never starts', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'))
  await page.route('**/*', route => route.request().resourceType() === 'script'
    ? route.fulfill({ contentType: 'application/javascript', body: '' })
    : route.continue())
  await page.goto('/contact')
  const mask = page.locator('#app-loading-mask')
  await expect(mask).toBeVisible()
  await page.clock.runFor(14_999)
  await expect(mask).toBeVisible()
  await page.clock.runFor(1_001)
  await expect(mask).toHaveCount(0)
})
