import { expect } from '@playwright/test'
import { login, test } from '../support/e2e-browser'

test('password login remains authenticated after a page reload', async ({ page }) => {
  await login(page)
  await page.reload()
  await expect(page.getByRole('button', { name: '新建', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '登录 / 注册', exact: true })).toHaveCount(0)
})
