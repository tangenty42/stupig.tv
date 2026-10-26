import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { create_story, login, markdown, ready, test } from '../support/e2e-browser'

async function local_storage(page: Page) {
  // Preserve the production HTTPS bucket/key/part grant checks. Only the OSS
  // network boundary is redirected to the local fixture's byte receiver.
  await page.route('https://e2e.oss.invalid/**', async (route) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Content-MD5', 'Access-Control-Expose-Headers': 'ETag' }
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors })
      return
    }
    const url = new URL(route.request().url())
    const response = await page.request.put(`/api/e2e-oss/${url.searchParams.get('uploadId')}?part=${url.searchParams.get('partNumber')}`, {
      data: route.request().postDataBuffer()!,
    })
    await route.fulfill({ response, headers: { ... response.headers(), ... cors } })
  })
}

test('password login remains authenticated after a page reload', async ({ page }) => {
  await login(page)
  await page.reload()
  await expect(page.getByRole('button', { name: '新建', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '登录 / 注册', exact: true })).toHaveCount(0)
})

test('creates, edits and reloads a real persisted story', async ({ page }) => {
  await login(page)
  const { id, title } = await create_story(page)
  await page.goto(`/content/${id}/edit`)
  await ready(page)
  await page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true }).fill(markdown(title, 'E2E saved after editing'))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('档案已保存', { exact: true })).toBeVisible()
  await page.goto(`/content/${id}`)
  await expect(page.getByText('E2E saved after editing', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('E2E saved after editing', { exact: true })).toBeVisible()
})

test('publishes a small attachment through the actual upload API', async ({ page }) => {
  await login(page)
  const { id } = await create_story(page)
  await page.goto(`/content/${id}/edit`)
  await ready(page)
  await local_storage(page)
  await page.getByLabel('选择上传文件', { exact: true }).setInputFiles({ name: 'e2e-note.txt', mimeType: 'text/plain', buffer: Buffer.from('E2E attachment bytes') })
  await expect(page.getByText('e2e-note.txt', { exact: true }).first()).toBeVisible()
  await expect.poll(async () => {
    const response = await page.request.get(`/api/trpc/content.getAttachmentWorkspace?input=${encodeURIComponent(JSON.stringify({ id: Number(id) }))}`)
    const payload = await response.json()
    return payload.result?.data?.attachments?.some((file: { file_name: string }) => file.file_name === 'e2e-note.txt') ?? false
  }).toBe(true)
  await page.reload()
  await expect(page.getByText('e2e-note.txt', { exact: true }).first()).toBeVisible()
})

test('cancels an in-flight attachment and receives server confirmation', async ({ page }) => {
  await login(page)
  const { id } = await create_story(page)
  await page.goto(`/content/${id}/edit`)
  await ready(page)
  await local_storage(page)
  let entered = false
  let release!: () => void
  const held = new Promise<void>(resolve => release = resolve)
  await page.route('https://e2e.oss.invalid/**', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.fallback()
      return
    }
    entered = true
    await held
    await route.abort().catch(() => {})
  })
  try {
    await page.getByLabel('选择上传文件', { exact: true }).setInputFiles({ name: 'e2e-cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('cancel these bytes') })
    await expect.poll(() => entered).toBe(true)
    await page.getByText('e2e-cancel.txt', { exact: true }).first().click({ button: 'right' })
    const confirmed = page.waitForResponse(response => response.url().includes('content.cancelUploadSession') && response.request().method() === 'POST')
    await page.getByRole('menuitem', { name: '取消', exact: true }).click()
    const response = await confirmed
    const payload = await response.json()
    expect((Array.isArray(payload) ? payload : [payload]).some(item => item.result?.data?.status === 'cancelled')).toBe(true)
    await expect(page.getByText('e2e-cancel.txt', { exact: true })).toHaveCount(0)
  }
  finally {
    release()
  }
})

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
