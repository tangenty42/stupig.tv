import type { DraftResult } from '@shared/types/content-draft'
import { expect } from '@playwright/test'
import { content_mutation, create_story, draft_timeout, editor_text, login, markdown, ready, test } from '../support/e2e-browser'

test('keeps the viewport through cloud replacements and clamps shorter content to its edge', async ({ page, context, browser }) => {
  test.setTimeout(180_000)
  await login(page)
  const story = await create_story(page)
  const editor = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  const body = Array.from({ length: 130 }, (_, i) => `Paragraph ${i} with enough text for editor and preview scrolling.`).join('\n\n')
  await editor.fill(markdown(story.title, body))
  await expect.poll(async () => (await content_mutation<DraftResult>(page, 'getDraft', { story_id: Number(story.id) })).snapshot!.markdown).toContain('Paragraph 129')
  const other = await browser.newContext({ storageState: await context.storageState(), baseURL: new URL(page.url()).origin })
  try {
    const observer = await other.newPage()
    await observer.goto(`/content/${story.id}/edit`)
    await ready(observer)
    const observed_editor = observer.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
    await expect(observed_editor).toBeVisible({ timeout: draft_timeout })
    await expect(observed_editor).not.toBeEditable()
    await observer.getByRole('button', { name: '全屏编辑', exact: true }).click()
    const scroller = observer.locator('.editor-fullscreen .cm-scroller')
    await scroller.hover()
    await observer.mouse.wheel(0, 1400)
    await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(900)
    const top = await scroller.evaluate((el) => {
      el.dataset.viewportOwner = 'same-instance'
      return el.scrollTop
    })
    await editor.fill(markdown(story.title, body.replaceAll('Paragraph', 'Updated paragraph')))
    // CodeMirror virtualizes off-screen lines; check the complete preview and
    // the currently rendered editor lines rather than demanding the tail DOM.
    await expect(observer.locator('.editor-fullscreen .story-body')).toContainText('Updated paragraph 129')
    await expect.poll(() => editor_text(observer)).toContain('Updated paragraph')
    await expect(scroller).toHaveAttribute('data-viewport-owner', 'same-instance')
    await expect.poll(() => scroller.evaluate((el, before) => Math.abs(el.scrollTop - before), top)).toBeLessThan(35)

    await editor.fill(markdown(story.title, 'Short cloud replacement'))
    await expect.poll(() => editor_text(observer)).toContain('Short cloud replacement')
    await expect.poll(() => scroller.evaluate(el => Math.abs(el.scrollTop - Math.max(0, el.scrollHeight - el.clientHeight)))).toBeLessThan(5)
    await expect(observer.locator('.editor-fullscreen')).toHaveCount(1)
    await expect(observed_editor).not.toBeEditable()
  }
  finally { await other.close() }
})
