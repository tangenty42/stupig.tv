import { expect } from '@playwright/test'
import sharp from 'sharp'
import { create_story, local_storage, login, ready, test } from '../support/e2e-browser'

test('reports oversized image dimensions in the existing row before requesting upload admission', async ({ page }) => {
  await login(page)
  const { id } = await create_story(page)
  await page.goto(`/content/${id}/edit`)
  await ready(page)
  await local_storage(page)
  const requests: string[] = []
  page.on('request', (request) => {
    if (/content\.(?:beginUploadBatch|initializeUploadSession|signUploadSessionPart)/.test(request.url()))
      requests.push(request.url())
  })
  const bytes = await sharp({ create: { width: 4097, height: 1, channels: 3, background: '#334455' } }).png().toBuffer()
  await page.getByLabel('选择上传文件', { exact: true }).setInputFiles({ name: 'too-wide.png', mimeType: 'image/png', buffer: bytes })
  const row = page.locator('[data-row-key^="preparing:"]').filter({ hasText: 'too-wide.png' })
  await expect(row).toBeVisible()
  await expect(row.getByText(/准备失败：图片尺寸 4097×1/)).toBeVisible()
  await expect(row.locator('.animate-spin')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(requests).toEqual([])
  await row.click({ button: 'right' })
  await page.getByText('取消准备', { exact: true }).click()
  await expect(row).toHaveCount(0)
  await expect(page.getByRole('button', { name: '添加', exact: true })).toBeEnabled()
})
