import type { DraftResult } from '@shared/types/content-draft'
import { expect } from '@playwright/test'
import { content_mutation, create_story, draft_timeout, login, markdown, ready, test } from '../support/e2e-browser'

test('restores per-draft editor layout and scroll after re-entry and reload', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page)
  const story = await create_story(page)
  const editor = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  const body = Array.from({ length: 140 }, (_, i) => `Paragraph ${i}: presentation state does not contain this private draft text.`).join('\n\n')
  await editor.fill(markdown(story.title, body))
  await expect.poll(async () => (await content_mutation<DraftResult>(page, 'getDraft', { story_id: Number(story.id) })).snapshot!.markdown).toContain('Paragraph 139')
  await page.getByRole('button', { name: '全屏编辑', exact: true }).click()
  await page.getByRole('button', { name: '微服私访', exact: true }).click()
  const divider = page.locator('.editor-divider').last()
  const bounds = (await divider.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 60)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + 60)
  await page.mouse.up()
  const scroller = page.locator('.editor-fullscreen .cm-scroller')
  await scroller.hover()
  await page.mouse.wheel(0, 1300)
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(900)
  const saved = await page.evaluate(() => ({
    top: document.querySelector('.cm-scroller')!.scrollTop,
    flex: (document.querySelector('.editor-column') as HTMLElement).style.flex,
  }))

  for (const navigation of ['reenter', 'reload']) {
    if (navigation === 'reenter') {
      await page.goto('/content')
      await ready(page)
      await page.goto(`/content/${story.id}/edit`)
    }
    else {
      await page.reload()
    }
    await ready(page)
    await expect(page.locator('.editor-fullscreen')).toHaveCount(1)
    await expect(editor).toBeEditable({ timeout: draft_timeout })
    await expect(page.getByRole('button', { name: '微服私访', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => scroller.evaluate((el, top) => Math.abs(el.scrollTop - top), saved.top)).toBeLessThan(35)
    await expect.poll(() => page.locator('.editor-column').evaluate(el => (el as HTMLElement).style.flex)).toBe(saved.flex)
  }

  await page.getByRole('button', { name: '退出全屏', exact: true }).click()
  await page.getByRole('button', { name: '微服私访', exact: true }).click()
  // The surrounding height transition first grows from the inline editor.
  // Wait for a real scroll range before sending the outer-page wheel input.
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeGreaterThan(1800)
  await page.mouse.move(1200, 600)
  await page.mouse.wheel(0, 1100)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(700)
  const page_top = await page.evaluate(() => window.scrollY)
  await page.goto('/content')
  await ready(page)
  await page.goto(`/content/${story.id}/edit`)
  await ready(page)
  await expect(page.locator('.editor-fullscreen')).toHaveCount(0)
  await expect(editor).not.toBeVisible()
  await expect.poll(() => page.evaluate(top => Math.abs(window.scrollY - top), page_top)).toBeLessThan(60)

  const saved_text = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('stupig:editor-view:')).map(key => localStorage.getItem(key)).join('\n'))
  expect(saved_text).not.toContain('presentation state does not contain')
  await create_story(page)
  await expect(page.locator('.editor-fullscreen')).toHaveCount(0)
  await expect(editor).toBeVisible()
})
