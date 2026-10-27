import { expect } from '@playwright/test'
import { create_story, login, markdown, ready, test } from '../support/e2e-browser'

test('creates, edits and reloads a real persisted story', async ({ page }) => {
  await login(page)
  const { id, title } = await create_story(page)
  await page.goto(`/content/${id}/edit`)
  await ready(page)
  await page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true }).fill(markdown(title, 'E2E saved after editing'))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('档案已保存', { exact: true })).toBeVisible()
  await page.goto(`/content/${id}`)
  await expect(page.getByText('E2E saved after editing', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('E2E saved after editing', { exact: true })).toBeVisible()
})
