import { randomUUID } from 'node:crypto'
import { expect } from '@playwright/test'
import { content_query, create_story, draft_timeout, editor_text, login, markdown, ready, test } from '../support/e2e-browser'

test('a new unsaved story follows a global title rename before creation', async ({ page, context, browser }) => {
  await login(page)
  const target = await create_story(page)
  const replacement = `${target.title}New`
  const new_title = `E2EDraft${randomUUID().slice(0, 8)}`
  await page.goto('/content/new/edit')
  await ready(page)
  const editor = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  await editor.fill(markdown(new_title, `[draft](CONTENT://${target.title.toUpperCase()}#top)`))
  const actor_context = await browser.newContext({ storageState: await context.storageState(), baseURL: new URL(page.url()).origin })
  try {
    const actor = await actor_context.newPage()
    await actor.goto(`/content/${target.id}/edit`)
    await ready(actor)
    await actor.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true }).fill(markdown(replacement, 'renamed'))
    await actor.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => (await content_query<{ markdown: string }>(actor, 'getStoryBody', { id: Number(target.id) })).markdown, { timeout: draft_timeout }).toContain(`title: ${replacement}`)
    await page.bringToFront()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => editor_text(page)).toContain(`[draft](content://${replacement}#top)`)
    await expect(editor).toBeEditable()
    await page.getByRole('button', { name: '创建', exact: true }).click()
    await expect(page).toHaveURL(/\/content\/\d+\/edit$/, { timeout: draft_timeout })
    await expect.poll(() => editor_text(page)).toContain(`content://${replacement}#top`)
  }
  finally {
    await actor_context.close()
  }
})
