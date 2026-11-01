import type { ContentAttachmentWorkspace } from '@shared/types/content'
import { expect } from '@playwright/test'
import { content_query, create_story, editor_text, local_storage, login, test } from '../support/e2e-browser'

declare global {
  interface Window { __upload_reads: number }
}

test('admits a large file without reading its bytes and displays only file-row status', async ({ page }) => {
  await page.addInitScript(() => {
    window.__upload_reads = 0
    const slice = Blob.prototype.slice
    Blob.prototype.slice = function (... args) {
      if (this instanceof File && this.name === 'large-preparation.bin')
        window.__upload_reads ++
      return Reflect.apply(slice, this, args)
    }
  })
  await login(page)
  const story = await create_story(page)
  await local_storage(page)
  let entered = false
  let reads = - 1
  let input: unknown
  let release!: () => void
  const held = new Promise<void>(resolve => release = resolve)
  await page.route('**/api/trpc/content.beginUploadBatch*', async (route) => {
    input = route.request().postDataJSON()
    reads = await page.evaluate(() => window.__upload_reads)
    entered = true
    await held
    await route.fallback()
  })
  const large = { name: 'large-preparation.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(9 * 1024 ** 2, 42) }
  try {
    await page.getByLabel('选择上传文件', { exact: true }).setInputFiles(large)
    await expect.poll(() => entered).toBe(true)
    expect(reads).toBe(0)
    expect(JSON.stringify(input)).toContain(large.name)
    expect(JSON.stringify(input)).not.toContain('sha256')
    await expect(page.getByText(large.name, { exact: true })).toBeVisible()
    await expect(page.getByText('正在确认上传', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '取消准备', exact: true })).toHaveCount(0)
    const editor = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
    await expect(editor).toBeEditable()
    await editor.press('Control+End')
    await editor.pressSequentially(' admission stays editable')
    expect(await editor_text(page)).toContain('admission stays editable')
    await page.getByText(large.name, { exact: true }).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: '取消准备', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
  }
  finally { release() }
  await expect.poll(async () => (await content_query<ContentAttachmentWorkspace>(page, 'getAttachmentWorkspace', { id: Number(story.id) })).attachments.some(file => file.file_name === large.name && file.file_size === large.buffer.length)).toBe(true)
})
