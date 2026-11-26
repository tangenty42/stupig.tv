import type { DraftCommand } from '@shared/types/content-draft'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execute: vi.fn(), query: vi.fn(), update_story: vi.fn(), refresh: vi.fn() }))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ app: { auth: { jwt: { secret: 'draft-test-secret' } } } }) }))
vi.mock('@server/lib/db', () => ({ db: {
  getConnection: async () => ({ execute: mocks.execute, query: mocks.query, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }),
} }))
vi.mock('./draft-auth.service', () => ({ require_draft_actor: vi.fn() }))
vi.mock('./reference-history.service', () => ({
  lock_title_namespace: vi.fn(async () => ({ revision: 7 })),
  replay_locked_references: vi.fn(async (_c: unknown, _s: number, markdown: string) => ({ markdown, namespace_revision: 0, title_revision: 7, baseline_unavailable: { namespace: false, title: false } })),
}))
vi.mock('./story.service', () => ({ create_story: vi.fn(), delete_story: vi.fn(), update_story: mocks.update_story }))
vi.mock('./sync-outbox.repository', () => ({ enqueue_content_refresh: mocks.refresh }))

const { command_draft, create_draft, list_drafts } = await import('./draft.service')

const actor = { id: 1, session_id: 2 } as never
const id = 'a'.repeat(32)
const lease = { page_id: 'page', epoch: 3, token: 'token' }
const now = 1_000_000
let row: Record<string, unknown>
let main: { markdown: string, revision: number, namespace_revision: number }
let list_rows: Record<string, unknown>[]

const sql_calls = () => mocks.execute.mock.calls.map(call => String(call[0]))
const updates = () => mocks.execute.mock.calls.filter(call => String(call[0]).includes('UPDATE content_story_drafts SET markdown'))

function command(overrides: Partial<DraftCommand> = {}): DraftCommand {
  return { id, lease, seq: 5, kind: 'sync', base_namespace_revision: 0, base_title_revision: 7, ... overrides } as DraftCommand
}

beforeEach(() => {
  vi.clearAllMocks()
  row = {
    id, story_id: 9, markdown: 'draft', draft_revision: 4, namespace_revision: 0, title_revision: 7, published_main_revision: 2,
    unpublished_changes: 1, lease_epoch: 3, lease_actor_id: 1, lease_session_id: 2, lease_page_id: 'page',
    lease_token_hash: createHash('sha256').update('token').digest('hex'), until_ms: now + 10_000,
    last_command_seq: 4, last_command_hash: null, last_command_result: null, updated_at: '2026-11-15T00:00:00.000Z',
  }
  main = { markdown: 'main', revision: 2, namespace_revision: 1 }
  list_rows = []
  mocks.execute.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT id, story_id FROM content_story_drafts'))
      return [[{ id, story_id: row.story_id }]]
    if (sql.includes('now_ms'))
      return [[{ now_ms: now }]]
    if (sql.includes('FROM content_story_drafts d'))
      return [[{ ... row }]]
    if (sql.includes('SELECT revision FROM content_stories'))
      return [[{ revision: main.revision }]]
    if (sql.includes('SELECT markdown, revision, namespace_revision FROM content_stories'))
      return [[main]]
    if (sql.includes('LEFT(markdown, 4096)'))
      return [list_rows]
    return [[]]
  })
})

describe('create_draft', () => {
  it('creates an undated template and reuses the draft for a retried request', async () => {
    const execute = mocks.execute.getMockImplementation()!
    let created = false
    mocks.execute.mockImplementation(async (sql: string, args: unknown[] = []) => {
      if (sql.startsWith('INSERT INTO content_story_drafts')) {
        if (! created) {
          Object.assign(row, { id: args[0], story_id: null, markdown: args[2], published_main_revision: null })
          created = true
        }
        return [[]]
      }
      return execute(sql, args)
    })
    const first = await create_draft(actor, id)
    const replay = await create_draft(actor, id)
    expect(first.snapshot?.markdown).toContain('title: 新建档案')
    expect(first.snapshot?.markdown).not.toMatch(/^time:/m)
    expect(replay.snapshot?.id).toBe(first.snapshot?.id)
    expect(replay.snapshot?.markdown).toBe(first.snapshot?.markdown)
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })
})

describe('command_draft', () => {
  it('rejects a command from a page that no longer holds the lease', async () => {
    row.until_ms = now - 1
    const result = await command_draft(actor, command({ markdown: 'new' }))
    expect(result.receipt).toMatchObject({ ok: false, error: 'lease_lost' })
    expect(updates()).toHaveLength(0)
  })

  it('rejects a command whose seq skips ahead', async () => {
    const result = await command_draft(actor, command({ seq: 6, markdown: 'new' }))
    expect(result.receipt).toMatchObject({ ok: false, error: 'command_order' })
    expect(updates()).toHaveLength(0)
  })

  it('replays the stored receipt for the same seq and fingerprint without writing', async () => {
    const input = command({ seq: 4, markdown: 'new' })
    const stored = { seq: 4, kind: 'sync', ok: true, story_id: 9 }
    Object.assign(row, { last_command_hash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), last_command_result: JSON.stringify(stored) })
    const result = await command_draft(actor, input)
    expect(result.receipt).toEqual(stored)
    expect(sql_calls().some(sql => sql.startsWith('UPDATE'))).toBe(false)
  })

  it('treats the same seq with a different payload as out of order', async () => {
    Object.assign(row, { last_command_hash: 'other', last_command_result: '{}' })
    const result = await command_draft(actor, command({ seq: 4, markdown: 'new' }))
    expect(result.receipt).toMatchObject({ ok: false, error: 'command_order' })
  })

  it('refuses to publish when the draft revision changed', async () => {
    const result = await command_draft(actor, command({ kind: 'publish', expected_revision: 3 }))
    expect(result.receipt).toMatchObject({ ok: false, error: 'snapshot_changed' })
    expect(mocks.update_story).not.toHaveBeenCalled()
  })

  it('refuses to publish when the main story moved past the draft baseline', async () => {
    main.revision = 3
    const result = await command_draft(actor, command({ kind: 'publish', expected_revision: 4 }))
    expect(result.receipt).toMatchObject({ ok: false, error: 'validation_failed' })
    expect(mocks.query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT draft_effects')
    expect(mocks.update_story).not.toHaveBeenCalled()
  })

  it('resets a bound draft to the published story', async () => {
    const result = await command_draft(actor, command({ kind: 'reset', expected_revision: 4 }))
    expect(result.receipt).toMatchObject({ ok: true })
    expect(updates()).toHaveLength(1)
    expect(updates()[0]![0]).toContain('unpublished_changes = 0')
    expect(updates()[0]![1]).toEqual(['main', 2, 1, 7, 1, id])
  })
})

describe('list_drafts', () => {
  it('queries every unpublished draft in descending update order', async () => {
    list_rows = Array.from({ length: 32 }, (_, index) => ({
      id: (32 - index).toString(16).padStart(32, '0'),
      story_id: index === 0 ? 9 : null,
      prefix: '---\ntitle: 草稿标题\n---\n机密正文',
      complete: 1,
      updated_at: '2026-11-15T03:00:00.000Z',
    }))
    const result = await list_drafts(actor)
    const sql = sql_calls().find(query => query.includes('LEFT(markdown, 4096)'))!
    expect(sql).toContain('WHERE (story_id IS NULL OR unpublished_changes = 1) ORDER BY updated_at DESC, id DESC')
    expect(sql).not.toMatch(/\bLIMIT\b/)
    expect(result.items.map(item => item.id)).toEqual(list_rows.map(row => row.id))
    expect(result.items[0]).toEqual({
      id: list_rows[0]!.id,
      story_id: 9,
      title: '草稿标题',
      updated_at: '2026-11-15T03:00:00.000Z',
    })
  })

  it('returns the notification channel even when there are no drafts', async () => {
    await expect(list_drafts(actor)).resolves.toEqual({ items: [], channel: expect.stringMatching(/^content_drafts:/) })
  })
})
