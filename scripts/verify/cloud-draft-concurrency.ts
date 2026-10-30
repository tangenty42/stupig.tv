import type { AuthUser } from '@server/types/auth'
import type { DraftCommand } from '@shared/types/content-draft'
import type { Connection, RowDataPacket } from 'mysql2/promise'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { db } from '@server/lib/db'
import { acquire_draft, command_draft, create_draft, get_draft } from '@server/services/content/draft.service'
import { begin_namespace_change, finish_namespace_change, lock_title_namespace, with_namespace_change } from '@server/services/content/reference-history.service'
import { ensure_workspace_root } from '@server/services/content/workspace.repository'

/** Observe real InnoDB waits instead of assuming a sleep establishes ordering. */
async function waiting_on(blocker_id: number, count = 1) {
  const deadline = performance.now() + 5000
  while (performance.now() < deadline) {
    const [rows] = await db.execute<RowDataPacket[]>(`SELECT DISTINCT requester.PROCESSLIST_ID AS id
      FROM performance_schema.data_lock_waits w
      JOIN performance_schema.threads blocker ON blocker.THREAD_ID = w.BLOCKING_THREAD_ID
      JOIN performance_schema.threads requester ON requester.THREAD_ID = w.REQUESTING_THREAD_ID
      WHERE blocker.PROCESSLIST_ID = ?`, [blocker_id])
    if (rows.length >= count)
      return Number(rows[0]!.id)
    await delay(10)
  }
  throw new Error('Expected the concurrent operation to wait on its database lock')
}

/** Called only after cloud-drafts.ts switches the pool to its disposable QA DB. */
export async function verify_draft_concurrency(actor: AuthUser) {
  const draft = (await create_draft(actor, randomBytes(16).toString('hex'))).snapshot!
  const page_id = randomBytes(16).toString('hex')
  const token = randomBytes(32).toString('hex')
  const owned = (await acquire_draft(actor, { id: draft.id, expected_epoch: draft.lease_epoch, page_id, token })).snapshot!
  const lease = { page_id, token, epoch: owned.lease_epoch }
  let seq = 0
  const command = async (rest: Partial<DraftCommand> = {}) => {
    const current = (await get_draft(actor, { id: draft.id, lease })).snapshot!
    return { id: draft.id, lease, kind: 'sync' as const, seq: seq + 1, base_namespace_revision: current.namespace_revision, base_title_revision: current.title_revision, ... rest }
  }
  const send = async (input: DraftCommand) => {
    const result = await command_draft(actor, input)
    assert(result.receipt?.ok, result.receipt?.message ?? 'Draft command failed')
    seq = input.seq
    return result.snapshot!
  }
  const text = `---\ntitle: Concurrency-${draft.id}\ntime: 2026/10/30\n---\n[](att://old)`
  const saved = await send(await command({ markdown: text }))

  // Publication queues first, then the reader locates the still-unbound draft.
  // Once publication commits, the reader must retry with the new story binding.
  const title_blocker = await db.getConnection()
  const publishing = await command({ kind: 'publish', expected_revision: saved.draft_revision })
  const pending: Promise<unknown>[] = []
  let story_id: number
  try {
    await title_blocker.beginTransaction()
    await lock_title_namespace(title_blocker, true)
    const publication = send(publishing)
    pending.push(publication)
    void publication.catch(() => {})
    await waiting_on(title_blocker.threadId)
    const read = get_draft(actor, { id: draft.id, lease })
    pending.push(read)
    void read.catch(() => {})
    await waiting_on(title_blocker.threadId, 2)
    await title_blocker.commit()
    const published = await publication
    story_id = published.story_id!
    assert(story_id)
    assert.equal((await read).snapshot!.story_id, story_id)
  }
  finally {
    await title_blocker.rollback()
    title_blocker.release()
    await Promise.allSettled(pending)
  }

  await with_namespace_change(story_id, async (connection) => {
    const root_id = await ensure_workspace_root(connection, story_id)
    await connection.execute(`INSERT INTO content_story_attachments (story_id, parent_id, name, name_key, file_name, is_folder, version, storage_provider)
      VALUES (?, ?, 'old', 'old', 'old', 1, '', 'aliyun')`, [story_id, root_id])
  })
  const rename = (connection: Connection, from: string, to: string) => connection.execute('UPDATE content_story_attachments SET file_name = ?, name = ?, name_key = ? WHERE story_id = ? AND file_name = ?', [to, to, to, story_id, from])

  // Rename wins the story lock. Saving must read the newly committed journal,
  // not combine its old routing snapshot with the new namespace revision.
  const rename_blocker = await db.getConnection()
  const input = await command({ markdown: `${text}\ninput before rename` })
  let saving: Promise<unknown> | undefined
  try {
    await rename_blocker.beginTransaction()
    const before = await begin_namespace_change(rename_blocker, story_id)
    await rename(rename_blocker, 'old', 'new')
    const result = send(input)
    saving = result
    void result.catch(() => {})
    await waiting_on(rename_blocker.threadId)
    await finish_namespace_change(rename_blocker, before)
    await rename_blocker.commit()
    const after = await result
    assert.equal(after.markdown, `${text.replace('att://old', 'att://new')}\ninput before rename`)
    assert.equal(after.namespace_revision, before.revision + 1)
  }
  finally {
    await rename_blocker.rollback()
    rename_blocker.release()
    await Promise.allSettled(saving ? [saving] : [])
  }

  // Saving wins the story lock and waits on authorization. The rename must
  // wait for that save, then rewrite both main and the newly saved draft.
  const token_blocker = await db.getConnection()
  const next_input = await command({ markdown: `${text.replace('att://old', 'att://new')}\ninput before second rename` })
  const overlapping: Promise<unknown>[] = []
  try {
    await token_blocker.beginTransaction()
    await token_blocker.execute('SELECT id FROM user_login_session_tokens WHERE id = ? FOR UPDATE', [actor.token_generation_id!])
    const result = send(next_input)
    overlapping.push(result)
    void result.catch(() => {})
    const saving_id = await waiting_on(token_blocker.threadId)
    const renamed = with_namespace_change(story_id, connection => rename(connection, 'new', 'latest'))
    overlapping.push(renamed)
    void renamed.catch(() => {})
    await waiting_on(saving_id)
    await token_blocker.commit()
    await result
    await renamed
    const current = (await get_draft(actor, { id: draft.id, lease })).snapshot!
    assert.equal(current.markdown, `${text.replace('att://old', 'att://latest')}\ninput before second rename`)
    const [mains] = await db.execute<RowDataPacket[]>('SELECT markdown, namespace_revision FROM content_stories WHERE id = ?', [story_id])
    assert.equal(mains[0]!.markdown, text.replace('att://old', 'att://latest'))
    assert.equal(current.namespace_revision, Number(mains[0]!.namespace_revision))
  }
  finally {
    await token_blocker.rollback()
    token_blocker.release()
    await Promise.allSettled(overlapping)
  }

  // A missing batch must not acknowledge the input or advance its baseline.
  const [before] = await db.execute<RowDataPacket[]>('SELECT markdown, draft_revision, namespace_revision, last_command_seq, last_command_result, lease_until FROM content_story_drafts WHERE id = ?', [draft.id])
  const revision = Number(before[0]!.namespace_revision)
  await db.execute('DELETE FROM content_reference_journals WHERE scope_id = ? AND revision = ?', [story_id, revision])
  const invalid = await command({ markdown: `${text}\nmissing history`, base_namespace_revision: revision - 1 })
  await assert.rejects(command_draft(actor, invalid), (error: unknown) => (error as { statusCode?: number }).statusCode === 503)
  const [after] = await db.execute<RowDataPacket[]>('SELECT markdown, draft_revision, namespace_revision, last_command_seq, last_command_result, lease_until FROM content_story_drafts WHERE id = ?', [draft.id])
  assert.deepEqual(after, before)
  await send(await command({ kind: 'delete' }))
  console.log('cloud-draft concurrency QA: publication binding retry, both rename/save orders and missing-history rollback passed')
}
