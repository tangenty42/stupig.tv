import { expect } from '@playwright/test'
import { create_story, local_storage, login, ready, test } from '../support/e2e-browser'

test('publishes a small attachment through the actual upload API', async ({ page }) => {
  await login(page)
  const { id } = await create_story(page)
  await page.goto(`/content/${id}/edit`)
  await ready(page)
  await local_storage(page)
  const [admission_response] = await Promise.all([
    page.waitForResponse(response => response.url().includes('content.beginUploadBatch')),
    page.getByLabel('选择上传文件', { exact: true }).setInputFiles({ name: 'e2e-note.txt', mimeType: 'text/plain', buffer: Buffer.from('E2E attachment bytes') }),
  ])
  const admitted = await admission_response.json()
  const session_id = (Array.isArray(admitted) ? admitted : [admitted]).find(item => item.result?.data?.accepted)?.result.data.accepted[0].session_id as string
  expect(session_id).toMatch(/^[\da-f]{32}$/)
  await expect(page.getByText('e2e-note.txt', { exact: true }).first()).toBeVisible()
  await expect.poll(async () => {
    const response = await page.request.get(`/api/trpc/content.getAttachmentWorkspace?input=${encodeURIComponent(JSON.stringify({ id: Number(id) }))}`)
    const payload = await response.json()
    return payload.result?.data?.attachments?.some((file: { file_name: string }) => file.file_name === 'e2e-note.txt') ?? false
  }).toBe(true)
  const observed_stages = () => page.evaluate(() => performance.getEntriesByType('measure')
    .filter(entry => entry.name.startsWith('content.upload.')).map(entry => entry.name.split('.').slice(- 2).join('.')))
  await expect.poll(observed_stages).toEqual(expect.arrayContaining(['bytes.returned', 'seal.returned', 'adopt.returned', 'dom_update.returned', 'total.returned']))
  const completed = await page.request.get(`/api/trpc/content.getUploadSession?input=${encodeURIComponent(JSON.stringify({ session_id }))}`)
  expect(completed.ok()).toBe(true)
  const state = (await completed.json()).result.data
  expect(state.status).toBe('completed')
  expect(state.completion.attachment_id).toBe(state.attachment_id)
  expect(state.completion.attachment.file_name).toBe('e2e-note.txt')
  expect(state.completion.workspace.attachments).toEqual(expect.arrayContaining([expect.objectContaining({ id: state.attachment_id, file_name: 'e2e-note.txt' })]))
  expect(state).toMatchObject({ key: null, upload_id: null, parts: [] })
  await page.reload()
  await expect(page.getByText('e2e-note.txt', { exact: true }).first()).toBeVisible()
})
