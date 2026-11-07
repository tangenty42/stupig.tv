import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), transaction_execute: vi.fn(), begin: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), get_connection: vi.fn(),
}))
vi.mock('@server/lib/db', () => ({ db: { execute: mocks.execute, getConnection: mocks.get_connection } }))
const { migrate_content_references } = await import('./reference-migration.service')

beforeEach(() => {
  vi.resetAllMocks()
  mocks.execute.mockResolvedValue([[{ id: 2, markdown: '[](old.png)' }]])
  mocks.get_connection.mockResolvedValue({ execute: mocks.transaction_execute, beginTransaction: mocks.begin, commit: mocks.commit, rollback: mocks.rollback, release: mocks.release })
  mocks.transaction_execute.mockImplementation(async (sql: string) => sql.startsWith('SELECT') ? [[{ id: 2, markdown: '[](latest.png)' }]] : [{ affectedRows: 1 }])
})

describe('reference data migration', () => {
  it('reports in dry-run without writes, locks or refreshes', async () => {
    expect(await migrate_content_references()).toEqual([{ story_id: 2, changed: true, applied: false, attachment_targets: 1, story_targets: 0 }])
    expect(mocks.get_connection).not.toHaveBeenCalled()
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })
  it('re-reads under FOR UPDATE and commits the rewrite and outbox event together', async () => {
    await migrate_content_references(true)
    expect(mocks.transaction_execute.mock.calls).toEqual([
      ['SELECT id, markdown FROM content_stories WHERE id = ? FOR UPDATE', [2]],
      ['UPDATE content_stories SET markdown = ? WHERE id = ?', ['[](att://latest.png)', 2]],
      [expect.stringMatching(/^INSERT INTO content_sync_outbox /), [expect.any(String), 'content_story:2', expect.any(String)]],
    ])
    const [id, resource, payload] = mocks.transaction_execute.mock.calls[2]![1]
    expect(JSON.parse(payload)).toMatchObject({ id, resource, type: 'refresh' })
    expect(mocks.transaction_execute.mock.invocationCallOrder[2]).toBeLessThan(mocks.commit.mock.invocationCallOrder[0]!)
    expect(mocks.release).toHaveBeenCalledOnce()
  })
  it('does not write or notify on repeated application', async () => {
    mocks.transaction_execute.mockResolvedValue([[{ id: 2, markdown: '[](att://latest.png)' }]])
    expect((await migrate_content_references(true))[0]).toMatchObject({ changed: false, applied: false })
    expect(mocks.transaction_execute).toHaveBeenCalledOnce()
  })
  it('rolls back the rewrite if inserting the outbox event fails', async () => {
    mocks.transaction_execute
      .mockResolvedValueOnce([[{ id: 2, markdown: '[](latest.png)' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockRejectedValueOnce(new Error('outbox unavailable'))
    await expect(migrate_content_references(true)).rejects.toThrow('outbox unavailable')
    expect(mocks.transaction_execute).toHaveBeenNthCalledWith(2, 'UPDATE content_stories SET markdown = ? WHERE id = ?', ['[](att://latest.png)', 2])
    expect(mocks.rollback).toHaveBeenCalledOnce()
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})
