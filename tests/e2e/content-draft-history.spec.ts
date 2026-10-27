import { expect } from '@playwright/test'
import { settings } from '@shared/settings'
import { create_story, login, markdown, ready, test } from '../support/e2e-browser'

test('unavailable reference history stays responsive and prompts only on save', async ({ page }) => {
  await login(page)
  const { id, title } = await create_story(page)
  await page.goto(`/content/${id}`)
  await page.evaluate(({ id, draft, prefix, schema }) => {
    localStorage.setItem(`${prefix}${id}`, JSON.stringify({
      schema_version: schema, story_id: Number(id), markdown: draft,
      base_revision: 1, base_namespace_revision: null, base_title_revision: null,
      saved_at: new Date().toISOString(),
    }))
  }, { id, draft: markdown(title, 'unsaved draft'), prefix: settings.app.content.draft.storagePrefix, schema: settings.app.content.draft.schemaVersion })
  await page.goto(`/content/${id}/edit`)
  await ready(page)
  const editor = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  await expect(editor).toBeEditable()
  await expect(page.getByText('这份草稿的部分引用历史不可用，请核对所有引用目标后确认。')).toHaveCount(0)
  const requests: string[] = []
  const saves: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('rewriteDraftReferences'))
      requests.push(request.url())
    if (request.url().includes('updateStory'))
      saves.push(request.postData() ?? '')
  })
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' typing', { delay: 50 })
  await page.waitForTimeout(500)
  await expect(editor).toBeEditable()
  expect(requests).toHaveLength(0)

  await page.getByRole('button', { name: '保存', exact: true }).click()
  const warning = page.getByRole('dialog', { name: '引用历史不可用' })
  await expect(warning).toBeVisible()
  expect(saves).toHaveLength(1)
  expect(saves[0]).not.toContain('confirm_reference_history')
  await warning.getByRole('button', { name: '继续保存' }).click()
  await expect(page.getByText('档案已保存', { exact: true })).toBeVisible()
  expect(saves).toHaveLength(2)
  expect(saves[1]).toContain('"confirm_reference_history":true')
})
