import type { DraftResult } from '@shared/types/content-draft'
import { expect } from '@playwright/test'
import { content_mutation, create_story, login, markdown, test } from '../support/e2e-browser'

test('an automatic save with unavailable history waits for snapshot-bound review', async ({ page }) => {
  await login(page)
  const story = await create_story(page)
  const drafts: { seq: number, confirm?: string }[] = []
  await page.route('**/api/trpc/**commandDraft**', async (route) => {
    const body = route.request().postDataJSON()
    const inputs = body.kind ? [body] : Object.values(body)
    for (const value of inputs) {
      const input = value as { kind: string, markdown?: string, seq: number, base_title_revision: number | null, confirm_reference_history?: string }
      if (input.kind === 'sync' && input.markdown !== undefined) {
        // A transport fixture emulates an in-flight snapshot whose history is
        // unknown; validation, review tokens, receipts and persistence are real.
        input.base_title_revision = null
        drafts.push({ seq: input.seq, confirm: input.confirm_reference_history })
      }
    }
    await route.continue({ postData: JSON.stringify(body) })
  })
  const editor = page.getByRole('textbox', { name: /Markdown/ })
  await editor.fill(markdown(story.title, 'reviewed cloud text'))
  const warning = page.getByRole('dialog', { name: /history|引用历史/ })
  await expect(warning).toBeVisible()
  expect(drafts).toHaveLength(1)
  expect(drafts[0]!.confirm).toBeUndefined()
  await warning.getByRole('button', { name: /继续保存/ }).click()
  await expect(warning).not.toBeVisible()
  await expect.poll(async () => (await content_mutation<DraftResult>(page, 'getDraft', { story_id: Number(story.id) })).snapshot!.markdown).toContain('reviewed cloud text')
  expect(drafts[1]!.seq).toBeGreaterThan(drafts[0]!.seq)
  expect(drafts[1]!.confirm).toMatch(/^[a-f0-9]{64}$/)
})
