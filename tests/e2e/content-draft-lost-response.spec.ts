import type { DraftResult } from '@shared/types/content-draft'
import { createHash } from 'node:crypto'
import { expect } from '@playwright/test'
import { content_mutation, create_story, login, markdown, test } from '../support/e2e-browser'

test('reconciles an actually committed save whose response was lost before sending newer commands', async ({ page }) => {
  await login(page)
  const story = await create_story(page)
  const attempts: { seq: number, hash: string }[] = []
  let release_replay!: () => void
  const replay = new Promise<void>((resolve) => {
    release_replay = resolve
  })
  await page.route('**/api/trpc/**commandDraft**', async (route) => {
    const input = route.request().postDataJSON()
    if (input.markdown?.includes('lost response text')) {
      attempts.push({ seq: input.seq, hash: createHash('sha256').update(route.request().postData()!).digest('hex') })
      if (attempts.length === 1) {
        const response = await route.fetch()
        expect(response.ok()).toBe(true)
        await route.abort('connectionreset')
        return
      }
      // Hold the replay until the uncertain state has actually been observed;
      // a fast successful replay can otherwise hide it between DOM assertions.
      if (attempts.length === 2)
        await replay
    }
    await route.continue()
  })
  const editor = page.getByRole('textbox', { name: /Markdown/ })
  await editor.fill(markdown(story.title, 'lost response text'))
  try {
    await expect.poll(() => attempts.length).toBe(2)
    await expect(editor).not.toBeEditable()
    await expect.poll(async () => (await content_mutation<DraftResult>(page, 'getDraft', { story_id: Number(story.id) })).snapshot!.markdown).toContain('lost response text')
  }
  finally { release_replay() }
  await expect(editor).toBeEditable({ timeout: 20000 })
  expect(attempts.length).toBeGreaterThanOrEqual(2)
  expect(attempts[1]).toEqual(attempts[0])
  await editor.fill(markdown(story.title, 'newer acknowledged text'))
  await expect.poll(async () => (await content_mutation<DraftResult>(page, 'getDraft', { story_id: Number(story.id) })).snapshot!.markdown).toContain('newer acknowledged text')
})
