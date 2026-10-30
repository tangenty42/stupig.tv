import type { DraftResult } from '@shared/types/content-draft'
import { expect } from '@playwright/test'
import { content_mutation, content_query, create_story, draft_timeout, login, markdown, ready, test } from '../support/e2e-browser'

test('a draft keeps same-title references while checking the latest publish snapshot', async ({ page, context, browser }) => {
  await login(page)
  const target = await create_story(page)
  const source = await create_story(page)
  const editor = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  const draft = markdown(source.title, `[引用](content://${target.title})`)
  await editor.fill(draft)
  await expect.poll(async () => (await content_mutation<DraftResult>(page, 'getDraft', { story_id: Number(source.id) })).snapshot!.markdown).toBe(draft)

  const actor_context = await browser.newContext({ storageState: await context.storageState(), baseURL: new URL(page.url()).origin })
  try {
    const actor = await actor_context.newPage()
    await actor.goto(`/content/${target.id}/edit`)
    await ready(actor)
    await actor.getByRole('button', { name: '删除', exact: true }).click()
    const confirmation = actor.getByRole('dialog', { name: '空城计？' })
    await expect(confirmation.getByText('有云端草稿正在引用。')).toBeVisible()
    await confirmation.getByRole('button', { name: '仍然删除' }).click()
    await expect(actor).toHaveURL(/\/content$/)
    await actor.goto('/content/new/edit')
    await ready(actor)
    await actor.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true }).fill(markdown(target.title, 'replacement'))
    await actor.getByRole('button', { name: '创建', exact: true }).click()
    await expect(actor).toHaveURL(/\/content\/\d+\/edit$/, { timeout: draft_timeout })

    await page.bringToFront()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(editor).toBeEditable()
    await expect(page.getByText('以下档案已被删除并同名重建，保存前需要确认：')).toHaveCount(0)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    const changed = page.getByText('云端草稿已变化，请重新核对后操作', { exact: true })
    const main = async () => (await content_query<{ markdown: string }>(page, 'getStoryBody', { id: Number(source.id) })).markdown
    // Creation advances all stored baselines. If its notification has not yet
    // arrived, the first publish must return the fresh snapshot for review.
    await expect.poll(async () => (await main()).includes(`content://${target.title}`) || await changed.isVisible(), { timeout: draft_timeout }).toBe(true)
    if (await changed.isVisible()) {
      await expect(editor).toContainText(`content://${target.title}`)
      await page.getByRole('button', { name: '保存', exact: true }).click()
    }
    await expect.poll(async () => (await content_query<{ markdown: string }>(page, 'getStoryBody', { id: Number(source.id) })).markdown, { timeout: draft_timeout }).toContain(`content://${target.title}`)
    await page.reload()
    await ready(page)
    await expect(editor).toContainText(target.title)
  }
  finally { await actor_context.close() }
})
