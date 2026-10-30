import type { DraftResult } from '@shared/types/content-draft'
import { randomUUID } from 'node:crypto'
import { expect } from '@playwright/test'
import { content_mutation, create_story, login, markdown, ready, test } from '../support/e2e-browser'

test('switches between published stories and cards for both kinds of draft', async ({ page, browser }) => {
  test.setTimeout(120_000)
  await login(page)
  const story = await create_story(page)
  const editor = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  await editor.fill(markdown(story.title, 'unpublished change'))
  await expect.poll(async () => (await content_mutation<DraftResult>(page, 'getDraft', { story_id: Number(story.id) })).snapshot!.markdown).toContain('unpublished change')

  await page.goto('/content')
  await ready(page)
  await page.getByRole('button', { name: '未发布草稿', exact: true }).click()
  const changed = page.getByRole('link', { name: new RegExp(`${story.title}.*修改草稿`) })
  await expect(changed).toBeVisible()
  await expect(page.getByText('事件日历', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '已发布', exact: true }).click()
  await expect(page.getByRole('link', { name: new RegExp(story.title) }).first()).toBeVisible()
  await expect(page.getByText('事件日历', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '新建', exact: true }).click()
  await expect(page).toHaveURL(/\/content\/draft-[a-f0-9]{32}\/edit/)
  const title = `DraftCard${randomUUID().slice(0, 8)}`
  const draft_id = /draft-([a-f0-9]{32})/.exec(page.url())![1]
  await expect(editor).toBeEditable()
  await editor.fill(markdown(title, 'unfinished new draft'))
  await expect.poll(async () => (await content_mutation<DraftResult>(page, 'getDraft', { id: draft_id })).snapshot!.markdown).toContain(title)
  await page.goto('/content/drafts')
  await ready(page)
  await expect(page).toHaveURL(/\/content\?view=drafts/)
  const draft_card = page.getByRole('link', { name: new RegExp(`${title}.*未发布`) })
  await expect(draft_card).toBeVisible()
  await expect(changed).toBeVisible()
  await draft_card.click()
  await expect(page).toHaveURL(new RegExp(`/content/draft-${draft_id}/edit`))
  await expect(editor).toContainText('unfinished new draft')

  const anonymous = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const response = await anonymous.request.get('/content?view=drafts')
    expect(await response.text()).not.toContain(title)
    const other = await anonymous.newPage()
    await other.goto('/content?view=drafts')
    await ready(other)
    await expect(other.getByRole('button', { name: '未发布草稿', exact: true })).toHaveCount(0)
    await expect(other.getByRole('link', { name: new RegExp(title) })).toHaveCount(0)
  }
  finally { await anonymous.close() }
})
