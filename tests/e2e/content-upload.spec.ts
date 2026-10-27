import { expect } from '@playwright/test'
import { create_story, local_storage, login, ready, test } from '../support/e2e-browser'

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
