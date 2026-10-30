import { randomUUID } from 'node:crypto'
import { expect } from '@playwright/test'
import { content_mutation, content_query, create_story, editor_text, local_storage, login, markdown, ready, test } from '../support/e2e-browser'

interface Workspace {
  root_id: number
  nodes: { id: number, path: string, version: string }[]
  attachments: { file_name: string }[]
}

test('a folder rename replays main and draft; deleting it shows impact and leaves warnings', async ({ page, context, browser }) => {
  test.setTimeout(180_000)
  await login(page)
  const story = await create_story(page)
  await local_storage(page)
  await page.getByLabel('选择上传文件', { exact: true }).first().setInputFiles({ name: 'e2e-note.txt', mimeType: 'text/plain', buffer: Buffer.from('reference test') })
  const id = Number(story.id)
  await expect.poll(async () => (await content_query<Workspace>(page, 'getAttachmentWorkspace', { id })).attachments.some(file => file.file_name === 'e2e-note.txt')).toBe(true)
  let workspace = await content_query<Workspace>(page, 'getAttachmentWorkspace', { id })
  await content_mutation(page, 'executeWorkspaceCommand', { operation: 'create_folder', scope_id: id, request_id: randomUUID(), parent_id: workspace.root_id, name: 'docs' })
  workspace = await content_query<Workspace>(page, 'getAttachmentWorkspace', { id })
  const folder = workspace.nodes.find(node => node.path === 'docs')!
  const file = workspace.nodes.find(node => node.path === 'e2e-note.txt')!
  await content_mutation(page, 'executeWorkspaceCommand', { operation: 'move', scope_id: id, request_id: randomUUID(), parent_id: folder.id, targets: [{ id: file.id, version: file.version }] })

  const editor = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  const saved = '[label](att://docs/e2e-note.txt?download=1#part) [folder](att://docs)'
  await editor.fill(markdown(story.title, saved))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('档案已保存', { exact: true })).toBeVisible()
  await expect(editor).toBeEditable()
  await editor.fill(markdown(story.title, `draft survives\n${saved}`))

  const actor_context = await browser.newContext({ storageState: await context.storageState(), baseURL: new URL(page.url()).origin })
  try {
    const actor = await actor_context.newPage()
    await actor.goto(`/content/${id}/edit`)
    await ready(actor)
    const folder_row = () => actor.locator('.folder-row:visible').filter({ hasText: 'docs' }).first()
    await folder_row().click({ button: 'right' })
    await actor.getByRole('menuitem', { name: '重命名', exact: true }).click()
    const rename = actor.getByRole('dialog', { name: '重命名' })
    await rename.getByLabel('名称').fill('renamed')
    await rename.getByRole('button', { name: '确定' }).click()
    await expect.poll(async () => (await content_query<{ markdown: string }>(page, 'getStoryBody', { id })).markdown)
      .toContain('[label](att://renamed/e2e-note.txt?download=1#part)')
    await page.bringToFront()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => editor_text(page)).toContain('[label](att://renamed/e2e-note.txt?download=1#part)')
    expect(await editor_text(page)).toContain('draft survives')

    await actor.bringToFront()
    await expect.poll(() => editor_text(actor)).toContain('att://renamed/e2e-note.txt')
    await actor.locator('.folder-row:visible').filter({ hasText: 'renamed' }).first().click({ button: 'right' })
    await actor.getByRole('menuitem', { name: '删除', exact: true }).click()
    const dialog = actor.getByRole('dialog', { name: '空城计？' })
    await expect(dialog.getByText('有正文正在引用。')).toBeVisible()
    await expect(dialog.getByText('有云端草稿正在引用。')).toBeVisible()
    await expect(dialog.getByText('renamed', { exact: false })).toHaveCount(0)
    await dialog.getByRole('button', { name: '仍然删除' }).click()
    await expect.poll(async () => (await content_query<Workspace>(page, 'getAttachmentWorkspace', { id })).nodes.some(node => node.path === 'renamed')).toBe(false)
    await page.bringToFront()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByText('附件『renamed/e2e-note.txt』不存在')).toBeVisible()
    await expect.poll(() => editor_text(page)).toContain('att://renamed/e2e-note.txt?download=1#part')
    await expect(editor).toBeEditable()
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => (await content_query<{ markdown: string }>(page, 'getStoryBody', { id })).markdown).toContain('draft survives')
    expect(await editor_text(actor)).toContain('att://renamed/e2e-note.txt')
  }
  finally {
    await actor_context.close()
  }
})
