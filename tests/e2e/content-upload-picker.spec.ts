import type { ContentAttachmentWorkspace } from '@shared/types/content'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { content_query, create_story, draft_timeout, local_storage, login, set_page_visibility, test } from '../support/e2e-browser'

test('retries the directory chooser from the fullscreen sidebar and retains the folder paths', async ({ page }, test_info) => {
  await page.addInitScript(() => {
    const show = HTMLInputElement.prototype.showPicker
    HTMLInputElement.prototype.showPicker = function () {
      if (this.webkitdirectory) {
        HTMLInputElement.prototype.showPicker = show
        throw new DOMException('Picker permission denied', 'NotAllowedError')
      }
      show.call(this)
    }
  })
  await login(page)
  const story = await create_story(page)
  await local_storage(page)
  await page.getByRole('button', { name: '全屏编辑', exact: true }).click()
  await page.locator('.editor-attachments-pane').getByRole('button', { name: '添加', exact: true }).click()
  await page.getByRole('menuitem', { name: '上传文件夹', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '未能添加附件', exact: true })
  await expect(dialog).toBeVisible()
  const directory = test_info.outputPath('slides')
  await mkdir(join(directory, 'week-1'), { recursive: true })
  await writeFile(join(directory, 'week-1', 'intro.pptx'), 'Disposable E2E upload bytes')
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    dialog.getByRole('button', { name: '重新选择', exact: true }).click(),
  ])
  await Promise.all([
    page.waitForResponse(response => response.url().includes('content.adoptUploadSession') && response.ok()),
    chooser.setFiles(directory),
  ])
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await content_query<ContentAttachmentWorkspace>(page, 'getAttachmentWorkspace', { id: Number(story.id) })).attachments.filter(file => file.file_name === 'slides/week-1/intro.pptx').length).toBe(1)
})

test('uploads the selected file when the system picker returns before the editor regains write access', async ({ page }) => {
  await login(page)
  const story = await create_story(page)
  await local_storage(page)
  const name = 'picker-return.txt'
  await page.getByRole('button', { name: '添加', exact: true }).click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('menuitem', { name: '上传', exact: true }).click(),
  ])
  const editor = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  await set_page_visibility(page, 'hidden')
  await expect(editor).not.toBeEditable({ timeout: draft_timeout })
  const lease = Promise.withResolvers<void>()
  await page.route('**/api/trpc/*acquireDraft*', async (route) => {
    await lease.promise
    await route.continue()
  })
  try {
    await Promise.all([
      page.waitForRequest(request => request.url().includes('content.acquireDraft')),
      set_page_visibility(page, 'visible'),
    ])
    await chooser.setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('Selected while the draft is temporarily read-only') })
    await expect(editor).not.toBeEditable()
  }
  finally {
    lease.resolve()
  }
  await expect(editor).toBeEditable({ timeout: draft_timeout })
  const attachment = page.locator('[data-row-key^="node:"]').getByText(name, { exact: true })
  await expect(attachment).toBeVisible()
  await expect.poll(async () => (await content_query<ContentAttachmentWorkspace>(page, 'getAttachmentWorkspace', { id: Number(story.id) })).attachments.filter(file => file.file_name === name).length).toBe(1)
})
