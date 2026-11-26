import { expect } from '@playwright/test'
import { create_story, local_storage, login, test } from '../support/e2e-browser'

test('inserts a renamed pasted attachment and keeps the editor writable until publication', async ({ page }) => {
  await login(page)
  const { id } = await create_story(page)
  await local_storage(page)
  const editor = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  await expect(editor).toBeEditable()
  await editor.press('Control+End')
  await editor.evaluate((element) => {
    const data = new DataTransfer()
    data.items.add(new File(['E2E attachment bytes'], 'pasted.txt', { type: 'text/plain' }))
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
  })
  const dialog = page.getByRole('dialog', { name: '命名' })
  await dialog.getByLabel('附件名称').fill('e2e-note.txt')
  let continue_seal!: () => void
  const gate = new Promise<void>((resolve) => {
    continue_seal = resolve
  })
  await page.route('**/api/trpc/*sealUploadSession*', async (route) => {
    await gate
    await route.continue()
  })
  const [admission_response] = await Promise.all([
    page.waitForResponse(response => response.url().includes('content.beginUploadBatch')),
    page.waitForRequest(request => request.url().includes('content.sealUploadSession')),
    dialog.getByRole('button', { name: '上传', exact: true }).click(),
  ])
  try {
    await expect(editor).toBeEditable()
    await editor.press('Control+End')
    await page.keyboard.insertText('continued while uploading')
  }
  finally {
    continue_seal()
  }
  const adoption_response = await page.waitForResponse(response => response.url().includes('content.adoptUploadSession') && response.ok())
  const admitted = await admission_response.json()
  const session_id = (Array.isArray(admitted) ? admitted : [admitted]).find(item => item.result?.data?.accepted)?.result.data.accepted[0].session_id as string
  expect(session_id).toMatch(/^[\da-f]{32}$/)
  const adopted = await adoption_response.json()
  const receipt = (Array.isArray(adopted) ? adopted : [adopted]).find(item => item.result?.data?.attachment)?.result.data
  expect(receipt).toMatchObject({ attachment_id: expect.any(Number), attachment: { file_name: 'e2e-note.txt' } })
  await expect(editor).toContainText(/\[\]\(att:\/\/e2e-note\.txt\)\s*continued while uploading/)
  const file_row = page.locator('[data-row-key^="node:"]:visible').getByText('e2e-note.txt', { exact: true })
  await expect(file_row).toBeVisible()
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
  expect(state.attachment_id).toBe(receipt.attachment_id)
  expect(state.completion.attachment_id).toBe(state.attachment_id)
  expect(state.completion.attachment.file_name).toBe('e2e-note.txt')
  expect(state.completion.workspace.attachments).toEqual(expect.arrayContaining([expect.objectContaining({ id: state.attachment_id, file_name: 'e2e-note.txt' })]))
  expect(state).toMatchObject({ key: null, upload_id: null, parts: [] })
  await page.reload()
  await expect(file_row).toBeVisible()
})
