import { expect } from '@playwright/test'
import { create_story, login, markdown, ready, test } from '../support/e2e-browser'

test('a second browser context observes a saved body through the real sync transport', async ({ page, context, browser }) => {
  await login(page)
  const { id, title } = await create_story(page)
  // A separate context cannot receive the writer's BroadcastChannel messages.
  // This makes the scenario exercise server outbox -> MQTT -> reader refresh.
  const reader_context = await browser.newContext({ storageState: await context.storageState(), baseURL: new URL(page.url()).origin })
  const reader = await reader_context.newPage()
  let subscribed = false
  let received = false
  reader.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    if (Buffer.isBuffer(payload) && payload[0] === 0x90)
      subscribed = true
    if (Buffer.isBuffer(payload) && (payload[0]! & 0xF0) === 0x30 && payload.includes(Buffer.from(`content_story:${id}`)))
      received = true
  }))
  await reader.goto(`/content/${id}`)
  await ready(reader)
  await expect(reader.getByText('E2E initial body', { exact: true })).toBeVisible()
  await expect.poll(() => subscribed).toBe(true)
  await page.goto(`/content/${id}/edit`)
  await ready(page)
  await page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true }).fill(markdown(title, 'E2E synchronized body'))
  received = false
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => received).toBe(true)
  await expect(reader.getByText('E2E synchronized body', { exact: true })).toBeVisible()
  await reader_context.close()
})
