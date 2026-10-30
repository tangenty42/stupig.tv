import { expect } from '@playwright/test'
import { create_story, login, markdown, ready, set_page_visibility, test } from '../support/e2e-browser'

test('hands the latest unsaved draft between editor tabs', async ({ page, context }) => {
  await login(page)
  const { id, title } = await create_story(page)
  const first = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  await expect(first).toBeEditable()
  await first.fill(markdown(title, 'first tab text'))
  await set_page_visibility(page, 'hidden')

  const other = await context.newPage()
  await other.goto(`/content/${id}/edit`)
  await other.bringToFront()
  await ready(other)
  const second = other.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  await expect(second).toBeEditable()
  await expect(first).not.toBeEditable()
  await expect.poll(async () => (await second.locator('.cm-line').allTextContents()).join('\n').trimEnd()).toBe(markdown(title, 'first tab text').trimEnd())
  await second.fill(markdown(title, 'second tab text'))
  await set_page_visibility(other, 'hidden')

  await page.bringToFront()
  await set_page_visibility(page, 'visible')
  await expect(first).toBeEditable()
  await expect(second).not.toBeEditable()
  await expect.poll(async () => (await first.locator('.cm-line').allTextContents()).join('\n').trimEnd()).toBe(markdown(title, 'second tab text').trimEnd())
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('档案已保存', { exact: true })).toBeVisible()
  await expect.poll(async () => (await second.locator('.cm-line').allTextContents()).join('\n').trimEnd()).toBe(markdown(title, 'second tab text').trimEnd())
  await other.close()
})
