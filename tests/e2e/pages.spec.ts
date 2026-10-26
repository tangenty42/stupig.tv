import { expect } from '@playwright/test'
import { create_story, login, logout, ready, test } from '../support/e2e-browser'

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

test('anonymous and ordinary users cannot enter restricted pages or edit another profile', async ({ page }) => {
  await login(page)
  const { id } = await create_story(page)
  await logout(page)
  for (const identity of ['anonymous', 'user']) {
    await test.step(identity, async () => {
      if (identity === 'user')
        await login(page, 'user')
      for (const path of ['/admin', '/content/new/edit', `/content/${id}/edit`]) {
        await page.goto(path)
        await ready(page)
        await expect(page).toHaveURL(new URL('/', page.url()).href)
        await expect(page.locator('main')).toContainText(/\S/)
      }
      const denied_status = identity === 'anonymous' ? 401 : 403
      expect((await page.request.get('/api/trpc/admin.getSelf')).status()).toBe(denied_status)
      expect((await page.request.post('/api/trpc/profile.updateBirthday', {
        data: { operate_for: 1, birthday: '2000-01-01T00:00:00.000Z' },
      })).status()).toBe(denied_status)
      await page.goto('/u/1')
      await ready(page)
      await expect(page.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0)
      await expect(page.locator('input[name="old_password"]')).toHaveCount(0)
    })
  }
})
