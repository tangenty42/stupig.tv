import { randomUUID } from 'node:crypto'
import { expect } from '@playwright/test'
import { append_reference_journal } from '@server/services/content/reference-journal.repository'
import mysql from 'mysql2/promise'
import { content_mutation, content_query, create_story, draft_timeout, login, markdown, ready, test } from '../support/e2e-browser'

interface StoryBody { markdown: string, title_revision: number }

test('global title history keeps 200 batches and warns an expired new draft', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page)
  const target = await create_story(page)
  const id = Number(target.id)
  const body = await content_query<StoryBody>(page, 'getStoryBody', { id })
  const base = body.title_revision
  const new_title = `${target.title}New`
  const draft_title = `E2EOldDraft${randomUUID().slice(0, 8)}`
  const database = process.env.MYSQL_DATABASE ?? ''
  expect(database).toMatch(/^stupig_e2e_[a-f\d]{32}$/)
  expect(['127.0.0.1', 'localhost']).toContain(process.env.MYSQL_HOST)
  const connection = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT), user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD, database, timezone: 'Z' })
  try {
    await connection.beginTransaction()
    await connection.execute('SELECT id FROM content_title_namespace WHERE id = 1 FOR UPDATE')
    for (let batch = 1; batch <= 200; batch ++) {
      const changes = Array.from({ length: batch === 2 ? 250 : 1 }, (_, index) => ({
        node_id: index + 1, from: `content://unused${batch}-${index}`, to: `content://moved${batch}-${index}`,
      }))
      await append_reference_journal(connection, 0, base + batch, changes)
    }
    await connection.execute('UPDATE content_title_namespace SET revision = ? WHERE id = 1', [base + 200])
    await connection.execute('UPDATE content_story_drafts SET title_revision = ?, draft_revision = draft_revision + 200', [base + 200])
    await connection.commit()

    await page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true }).fill(markdown(new_title, 'target renamed'))
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => (await content_query<StoryBody>(page, 'getStoryBody', { id })).markdown, { timeout: draft_timeout }).toContain(`title: ${new_title}`)
    const [[counts]] = await connection.execute<mysql.RowDataPacket[]>('SELECT COUNT(DISTINCT revision) AS batches, MIN(revision) AS oldest, SUM(revision = ?) AS big_batch FROM content_reference_journals WHERE scope_id = 0', [base + 2])
    expect(Number(counts!.batches)).toBe(200)
    expect(Number(counts!.oldest)).toBe(base + 2)
    expect(Number(counts!.big_batch)).toBe(250)
    const [[floor]] = await connection.execute<mysql.RowDataPacket[]>('SELECT revision_floor FROM content_title_namespace WHERE id = 1')
    expect(Number(floor!.revision_floor)).toBe(base + 1)
    const replay = await content_mutation<{ markdown: string, baseline_unavailable: { title: boolean } }>(page, 'rewriteDraftReferences', {
      id: 0, markdown: `[x](CONTENT://${target.title.toUpperCase()}#top)`, base_namespace_revision: 0, base_title_revision: base + 1,
    })
    expect(replay.baseline_unavailable.title).toBe(false)
    expect(replay.markdown).toBe(`[x](content://${new_title}#top)`)
  }
  finally {
    await connection.end()
  }

  await page.locator('a[href="/content"]').first().click()
  await page.route('**/api/trpc/**commandDraft**', async (route) => {
    const input = route.request().postDataJSON()
    if (input.kind === 'sync' && input.markdown !== undefined)
      input.base_title_revision = base
    await route.continue({ postData: JSON.stringify(input) })
  })
  await page.goto('/content/new/edit')
  await ready(page)
  await page.getByRole('textbox', { name: /Markdown/ }).fill(markdown(draft_title, `[old](content://${target.title})`))
  const warning = page.getByRole('dialog', { name: '引用历史不可用' })
  await expect(warning).toBeVisible()
  await warning.getByRole('button', { name: '继续保存' }).click()
  await expect(warning).not.toBeVisible()
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page).toHaveURL(/\/content\/\d+\/edit$/, { timeout: draft_timeout })
  const created_id = Number(/\/content\/(\d+)/.exec(page.url())![1])
  expect((await content_query<StoryBody>(page, 'getStoryBody', { id: created_id })).markdown).toContain(`[old](content://${target.title})`)
})
