import { randomUUID } from 'node:crypto'
import { expect } from '@playwright/test'
import { append_reference_journal } from '@server/services/content/reference-journal.repository'
import mysql from 'mysql2/promise'
import { content_mutation, content_query, create_story, draft_timeout, local_storage, login, markdown, test } from '../support/e2e-browser'

interface StoryBody { markdown: string, revision: number, namespace_revision: number, title_revision: number }
interface Workspace { nodes: { id: number, path: string, version: string }[], attachments: { file_name: string }[] }

test('whole-batch retention rejects an expired draft while the floor remains replayable', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page)
  const story = await create_story(page)
  const id = Number(story.id)
  await local_storage(page)
  await page.getByLabel('选择上传文件', { exact: true }).first().setInputFiles({ name: 'old.txt', mimeType: 'text/plain', buffer: Buffer.from('history') })
  await expect.poll(async () => (await content_query<Workspace>(page, 'getAttachmentWorkspace', { id })).attachments.some(file => file.file_name === 'old.txt')).toBe(true)
  const body = await content_query<StoryBody>(page, 'getStoryBody', { id })
  const base = body.namespace_revision

  // Only the randomly named database created by the Playwright global setup is writable.
  const database = process.env.MYSQL_DATABASE ?? ''
  expect(database).toMatch(/^stupig_e2e_[a-f\d]{32}$/)
  expect(['127.0.0.1', 'localhost']).toContain(process.env.MYSQL_HOST)
  const connection = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT), user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD, database, timezone: 'Z' })
  try {
    await connection.beginTransaction()
    await connection.execute('SELECT id FROM content_stories WHERE id = ? FOR UPDATE', [id])
    for (let batch = 1; batch <= 200; batch ++) {
      const changes = Array.from({ length: batch === 2 ? 250 : 1 }, (_, index) => ({
        node_id: index + 1, from: `att://unused${batch}-${index}`, to: `att://moved${batch}-${index}`,
      }))
      await append_reference_journal(connection, id, base + batch, changes)
    }
    await connection.execute('UPDATE content_stories SET namespace_revision = ?, updated_at = updated_at WHERE id = ?', [base + 200, id])
    // These synthetic unrelated mappings were consumed without changing text.
    await connection.execute('UPDATE content_story_drafts SET namespace_revision = ?, draft_revision = draft_revision + 200 WHERE story_id = ?', [base + 200, id])
    await connection.commit()

    const workspace = await content_query<Workspace>(page, 'getAttachmentWorkspace', { id })
    const file = workspace.nodes.find(node => node.path === 'old.txt')!
    await content_mutation(page, 'executeWorkspaceCommand', { operation: 'rename', scope_id: id, request_id: randomUUID(), target: { id: file.id, version: file.version }, name: 'new.txt' })
    const [[counts]] = await connection.execute<mysql.RowDataPacket[]>('SELECT COUNT(DISTINCT revision) AS batches, MIN(revision) AS oldest, SUM(revision = ?) AS big_batch FROM content_reference_journals WHERE scope_id = ?', [base + 2, id])
    expect(Number(counts!.batches)).toBe(200)
    expect(Number(counts!.oldest)).toBe(base + 2)
    expect(Number(counts!.big_batch)).toBe(250)
    const [[floor]] = await connection.execute<mysql.RowDataPacket[]>('SELECT namespace_floor FROM content_stories WHERE id = ?', [id])
    expect(Number(floor!.namespace_floor)).toBe(base + 1)

    const replay = await content_mutation<{ markdown: string, baseline_unavailable: { namespace: boolean } }>(page, 'rewriteDraftReferences', {
      id, markdown: '[x](ATT://OLD.TXT?download=1#top)', base_namespace_revision: base + 1, base_title_revision: body.title_revision,
    })
    expect(replay.baseline_unavailable.namespace).toBe(false)
    expect(replay.markdown).toBe('[x](att://new.txt?download=1#top)')
  }
  finally {
    await connection.end()
  }

  // Emulate input captured before the retained history window. The real cloud
  // draft remains current; only this in-flight command has an expired baseline.
  await page.route('**/api/trpc/**commandDraft**', async (route) => {
    const input = route.request().postDataJSON()
    if (input.kind === 'sync' && input.markdown !== undefined)
      input.base_namespace_revision = base
    await route.continue({ postData: JSON.stringify(input) })
  })
  const editor = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  await expect(editor).toBeEditable()
  await editor.fill(markdown(story.title, 'draft [old](att://old.txt)'))
  const warning = page.getByRole('dialog', { name: '引用历史不可用' })
  await expect(warning).toBeVisible()
  await warning.getByRole('button', { name: '继续保存' }).click()
  await expect(warning).not.toBeVisible()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(async () => (await content_query<StoryBody>(page, 'getStoryBody', { id })).markdown, { timeout: draft_timeout }).toContain('draft [old](att://old.txt)')
})
