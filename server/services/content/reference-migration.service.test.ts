import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), transaction_execute: vi.fn(), begin: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), get_connection: vi.fn(), publish: vi.fn(),
}))
vi.mock('@server/lib/db', () => ({ db: { execute: mocks.execute, getConnection: mocks.get_connection } }))
vi.mock('@server/lib/sync', () => ({ publish_refresh: mocks.publish, sync_resource: (kind: string, id: number) => `${kind}:${id}` }))
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
    expect(mocks.publish).not.toHaveBeenCalled()
  })
  it('re-reads under FOR UPDATE, leaves revision untouched and refreshes after commit', async () => {
    await migrate_content_references(true)
    expect(mocks.transaction_execute.mock.calls).toEqual([
      ['SELECT id, markdown FROM content_stories WHERE id = ? FOR UPDATE', [2]],
      ['UPDATE content_stories SET markdown = ? WHERE id = ?', ['[](att://latest.png)', 2]],
    ])
    expect(mocks.commit.mock.invocationCallOrder[0]).toBeLessThan(mocks.publish.mock.invocationCallOrder[0]!)
    expect(mocks.publish).toHaveBeenCalledWith({ resource: 'content_story:2' })
    expect(mocks.release).toHaveBeenCalledOnce()
  })
  it('does not write or notify on repeated application', async () => {
    mocks.transaction_execute.mockResolvedValue([[{ id: 2, markdown: '[](att://latest.png)' }]])
    expect((await migrate_content_references(true))[0]).toMatchObject({ changed: false, applied: false })
    expect(mocks.transaction_execute).toHaveBeenCalledOnce()
    expect(mocks.publish).not.toHaveBeenCalled()
  })
  it('rolls back a database failure and does not publish a refresh', async () => {
    mocks.transaction_execute.mockRejectedValueOnce(new Error('db unavailable'))
    await expect(migrate_content_references(true)).rejects.toThrow('db unavailable')
    expect(mocks.rollback).toHaveBeenCalledOnce()
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})
