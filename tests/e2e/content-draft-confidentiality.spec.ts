import type { DraftResult } from '@shared/types/content-draft'
import { expect } from '@playwright/test'
import { content_mutation, create_story, login, markdown, test } from '../support/e2e-browser'

test('keeps unfinished confidential input out of SSR, browser storage and unauthorized draft responses', async ({ page, browser }) => {
  await login(page)
  const story = await create_story(page)
  const secret = `unfinished-confidential-${story.id}`
  const editor = page.getByRole('textbox', { name: /Markdown/ })
  await editor.fill(markdown(story.title, `<good>${secret}`))
  await expect.poll(async () => (await content_mutation<DraftResult>(page, 'getDraft', { story_id: Number(story.id) })).snapshot!.markdown).toContain(secret)
  const response = await page.request.post('/api/trpc/content.getDraft', { data: { story_id: Number(story.id) } })
  expect(response.headers()['cache-control']).toContain('no-store')
  const snapshot = ((await response.json()).result.data as DraftResult).snapshot!
  expect(await (await page.request.get(`/content/${story.id}/edit`)).text()).not.toContain(secret)
  expect(await (await page.request.get(`/content/${story.id}`)).text()).not.toContain(secret)
  expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain(secret)
  const other = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const anonymous = await other.request.post('/api/trpc/content.getDraft', { data: { id: snapshot.id } })
    expect(anonymous.status()).toBe(401)
    expect(anonymous.headers()['cache-control']).toContain('no-store')
    expect(await anonymous.text()).not.toContain(secret)
    const user = await other.newPage()
    await login(user, 'user')
    const forbidden = await user.request.post('/api/trpc/content.getDraft', { data: { id: snapshot.id } })
    expect(forbidden.status()).toBe(403)
    expect(forbidden.headers()['cache-control']).toContain('no-store')
    expect(await forbidden.text()).not.toContain(secret)
  }
  finally { await other.close() }
})
