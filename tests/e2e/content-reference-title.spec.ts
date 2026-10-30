import { randomUUID } from 'node:crypto'
import { expect } from '@playwright/test'
import { content_query, create_story, editor_text, login, markdown, ready, test } from '../support/e2e-browser'

test('title changes update saved references and another browser draft, and deletion warns without blocking', async ({ page, context, browser }) => {
  test.setTimeout(180_000)
  await login(page)
  const source = await create_story(page)
  const original = `E2ETarget${randomUUID().slice(0, 8)}`
  const renamed = `${original}New`
  const editor = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  const earlier_links = Array.from({ length: 205 }, (_, index) => `[x](content://Missing${index})`).join(' ')
  await editor.fill(markdown(source.title, `${earlier_links}\n[custom](CONTENT://${original.toUpperCase()}?view=card#top)`))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('档案已保存', { exact: true })).toBeVisible()

  const actor_context = await browser.newContext({ storageState: await context.storageState(), baseURL: new URL(page.url()).origin })
  try {
    const actor = await actor_context.newPage()
    await actor.goto('/content/new/edit')
    await ready(actor)
    const actor_editor = actor.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
    await actor_editor.fill(markdown(original, 'target body'))
    await actor.getByRole('button', { name: '创建', exact: true }).click()
    await expect(actor).toHaveURL(/\/content\/\d+\/edit$/)
    await expect(actor.getByRole('button', { name: '保存', exact: true })).toBeVisible()
    await ready(actor)
    await expect(actor.getByRole('heading', { name: original, exact: true })).toBeVisible()
    await expect.poll(() => editor_text(actor)).toBe(markdown(original, 'target body').trimEnd())
    const target_id = Number(/\/content\/(\d+)/.exec(actor.url())![1])
    await page.bringToFront()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(editor).toBeEditable()
    await editor.fill(markdown(source.title, `draft survives\n[custom](content://${original}?view=card#top)`))

    await actor.bringToFront()
    await actor.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(actor_editor).toBeEditable()
    await actor_editor.fill(markdown(renamed, 'target body'))
    await expect(actor.getByRole('heading', { name: renamed, exact: true })).toBeVisible()
    await expect.poll(() => editor_text(actor)).toBe(markdown(renamed, 'target body').trimEnd())
    await actor.getByRole('button', { name: '保存', exact: true }).click()
    await expect(actor.getByText('档案已保存', { exact: true })).toBeVisible()
    await expect.poll(async () => (await content_query<{ markdown: string }>(page, 'getStoryBody', { id: Number(source.id) })).markdown)
      .toContain(`[custom](content://${renamed}?view=card#top)`)
    await page.bringToFront()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => editor_text(page)).toContain(`[custom](content://${renamed}?view=card#top)`)
    expect(await editor_text(page)).toContain('draft survives')

    await actor.bringToFront()
    await actor.getByRole('button', { name: '删除', exact: true }).click()
    const dialog = actor.getByRole('dialog', { name: '空城计？' })
    await expect(dialog.getByText('有正文正在引用。')).toBeVisible()
    await expect(dialog.getByText(source.title)).toHaveCount(0)
    await dialog.getByRole('button', { name: '仍然删除' }).click()
    await expect(actor).toHaveURL(/\/content$/)
    await page.bringToFront()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByText(`档案『${renamed}』不可引用`)).toBeVisible()
    await expect.poll(() => editor_text(page)).toContain(`content://${renamed}?view=card#top`)
    await expect(editor).toBeEditable()
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByText('档案已保存', { exact: true })).toBeVisible()
    const saved = await content_query<{ markdown: string }>(page, 'getStoryBody', { id: Number(source.id) })
    expect(saved.markdown).toContain(`content://${renamed}?view=card#top`)
    expect(target_id).toBeGreaterThan(0)
  }
  finally {
    await actor_context.close()
  }
})
