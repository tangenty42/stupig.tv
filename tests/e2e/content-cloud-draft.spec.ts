import type { DraftResult } from '@shared/types/content-draft'
import { expect } from '@playwright/test'
import { settings } from '@shared/settings'
import { content_mutation, content_query, create_story, editor_text, login, markdown, ready, test } from '../support/e2e-browser'

test('autosaves one shared cloud draft, keeps main unchanged, and hands editing to another page', async ({ page, context, browser }) => {
  test.setTimeout(120_000)
  await login(page)
  const story = await create_story(page)
  const editor = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  await expect(editor).toBeEditable()
  const draft = markdown(story.title, 'shared cloud text <good>unfinished')
  const legacy_key = `stupig_content_draft_${story.id}`
  await page.evaluate(key => localStorage.setItem(key, 'legacy data owned by the user'), legacy_key)
  await editor.fill(draft)
  await expect.poll(async () => (await content_mutation<DraftResult>(page, 'getDraft', { story_id: Number(story.id) })).snapshot!.markdown).toBe(draft)
  expect((await content_query<{ markdown: string }>(page, 'getStoryBody', { id: Number(story.id) })).markdown).not.toContain('shared cloud text')
  expect(await page.evaluate(key => localStorage.getItem(key), legacy_key)).toBe('legacy data owned by the user')
  const other = await browser.newContext({ storageState: await context.storageState(), baseURL: new URL(page.url()).origin })
  try {
    const second = await other.newPage()
    await second.goto(`/content/${story.id}/edit`)
    await ready(second)
    const second_editor = second.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
    // A failed initial read is retried through M; the page stays read only.
    const timing = settings.app.content.draft
    await expect(second_editor).toBeVisible({ timeout: 2 * timing.keepaliveIntervalMs + 2 * timing.requestTimeoutMs + timing.leaseMarginMs })
    await expect(second_editor).not.toBeEditable()
    await expect.poll(() => editor_text(second)).toContain('shared cloud text')
    await page.locator('a[href="/content"]').first().click()
    // If the final in-flight request failed, release is best effort and the
    // successor waits L + M + T; it must remain read only until then.
    await expect(second_editor).toBeEditable({ timeout: 2 * timing.keepaliveIntervalMs + 3 * timing.requestTimeoutMs + timing.leaseMarginMs })
    await second_editor.fill(markdown(story.title, 'published from the second page'))
    await second.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => (await content_query<{ markdown: string }>(second, 'getStoryBody', { id: Number(story.id) })).markdown).toContain('published from the second page')
    await second.goto('/content')
    await ready(second)
    await second.getByRole('button', { name: '未发布草稿', exact: true }).click()
    await expect(second).toHaveURL(/view=drafts/)
    await expect(second.getByRole('heading', { name: /蠢猪档案/ })).toBeVisible()
  }
  finally { await other.close() }
})
