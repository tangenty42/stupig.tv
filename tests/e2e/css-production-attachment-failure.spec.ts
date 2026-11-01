import type { ContentAttachmentWorkspace } from '@shared/types/content'
import { expect } from '@playwright/test'
import { content_query, create_story, local_storage, login, test } from '../support/e2e-browser'

test('attachment request failures use a modal and reconcile the same upload after closing and reopening', async ({ page }, info) => {
  await login(page)
  const story = await create_story(page)
  await local_storage(page)
  await page.setViewportSize({ width: 480, height: 850 })
  const requests: string[] = []
  let release!: () => void
  const held = new Promise<void>(resolve => release = resolve)
  await page.route('**/api/trpc/content.beginUploadBatch*', async (route) => {
    const input = route.request().postDataJSON() as Record<string, { request_id: string }>
    requests.push(input['0']!.request_id)
    if (requests.length === 1) {
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify([{ error: { message: '请求参数不合法！', code: - 32600, data: { code: 'BAD_REQUEST', httpStatus: 400, path: 'content.beginUploadBatch' } } }]) })
      return
    }
    await held
    await route.fallback()
  })
  try {
    await page.getByLabel('选择上传文件', { exact: true }).setInputFiles({ name: 'dialog-retry.txt', mimeType: 'text/plain', buffer: Buffer.from('retry the same admission') })
    const dialog = page.getByRole('dialog', { name: '上传请求失败', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('请求参数不合法！', { exact: true })).toBeVisible()
    await expect(page.getByText('请求参数不合法！', { exact: true })).toHaveCount(1)
    await expect(page.getByText('正在确认上传', { exact: true })).toHaveCount(0)
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme)
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const screenshot = await dialog.screenshot({ path: info.outputPath(`attachment-request-failure-${theme}.png`) })
      await info.attach(`attachment-request-failure-${theme}`, { body: screenshot, contentType: 'image/png' })
    }
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click()
    await expect(dialog).toBeHidden()
    await page.getByText('dialog-retry.txt', { exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '查看上传失败原因', exact: true }).click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '重试', exact: true }).click()
    await expect.poll(() => requests.length).toBe(2)
    expect(requests[0]).toBeTruthy()
    expect(requests[1]).toBe(requests[0])
    await expect(dialog.getByRole('button', { name: '重试', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '关闭', exact: true }).last()).toBeDisabled()
    await expect(dialog.getByText('请求参数不合法！', { exact: true })).toBeVisible()
  }
  finally { release() }
  await expect(page.getByRole('dialog', { name: '上传请求失败', exact: true })).toBeHidden()
  await expect.poll(async () => (await content_query<ContentAttachmentWorkspace>(page, 'getAttachmentWorkspace', { id: Number(story.id) })).attachments.some(file => file.file_name === 'dialog-retry.txt')).toBe(true)
})
