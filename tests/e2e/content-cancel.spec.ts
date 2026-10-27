import { expect } from '@playwright/test'
import { create_story, local_storage, login, ready, test } from '../support/e2e-browser'

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
