import type { ContentAttachmentWorkspace } from '@shared/types/content'
import type { ContentUploadSession } from '@shared/types/content-upload'
import { expect } from '@playwright/test'
import { content_query, create_story, draft_timeout, local_storage, login, ready, test } from '../support/e2e-browser'

test('rejects a mismatched resumed file and continues the original without retransmitting its confirmed first part', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page)
  const story = await create_story(page)
  await local_storage(page)
  const file = { name: 'resumable.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(9 * 1024 ** 2, 42) }
  let entered = false
  let hold = true
  let release!: () => void
  const held = new Promise<void>(resolve => release = resolve)
  const sent: number[] = []
  await page.route('https://e2e.oss.invalid/**', async (route) => {
    if (route.request().method() !== 'PUT')
      return route.fallback()
    const number = Number(new URL(route.request().url()).searchParams.get('partNumber'))
    sent.push(number)
    if (number === 2 && hold) {
      entered = true
      await held
      await route.abort().catch(() => {})
      return
    }
    await route.fallback()
  })
  try {
    await page.getByLabel('选择上传文件', { exact: true }).setInputFiles(file)
    await expect.poll(() => entered).toBe(true)
    await page.getByText(file.name, { exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '暂停', exact: true }).click()
  }
  finally {
    hold = false
    release()
  }
  expect(sent).toEqual([1, 2])
  await page.reload()
  await ready(page)
  await expect(page.getByText(file.name, { exact: true })).toBeVisible({ timeout: draft_timeout })
  await page.getByText(file.name, { exact: true }).click({ button: 'right' })
  const wrong_picker = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: '继续', exact: true }).click()
  const wrong = Buffer.from(file.buffer)
  wrong[0] = 0
  await (await wrong_picker).setFiles({ ... file, buffer: wrong })
  await expect(page.getByText(/请选择内容一致的原文件/)).toBeVisible()
  expect(sent).toEqual([1, 2])
  const sessions = await content_query<{ sessions: ContentUploadSession[] }>(page, 'listUploadSessions', { id: Number(story.id) })
  expect(sessions.sessions[0]?.parts.map(part => part.part_number)).toEqual([1])
  await page.getByText(file.name, { exact: true }).click({ button: 'right' })
  const correct_picker = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: '继续', exact: true }).click()
  await (await correct_picker).setFiles(file)
  await expect.poll(async () => (await content_query<ContentAttachmentWorkspace>(page, 'getAttachmentWorkspace', { id: Number(story.id) })).attachments.some(item => item.file_name === file.name && item.file_size === file.buffer.length)).toBe(true)
  expect(sent).toEqual([1, 2, 2])
})
