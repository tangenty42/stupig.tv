import type { WorkspaceRow } from './workspace.repository'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { create_content_receipt_compactor } from './command-receipts.service'
import { node_version, workspace_node_versions, workspace_transaction } from './workspace.repository'

const boundary = vi.hoisted(() => ({ getConnection: vi.fn() }))
vi.mock('@server/lib/db', () => ({ db: { getConnection: boundary.getConnection } }))

function row(id: number, path: string, folder = false): WorkspaceRow {
  return { id, file_name: path, parent_id: id === 1 ? 0 : 1, name: path.split('/').at(- 1) ?? '', is_folder: Number(folder), node_revision: 1, object_key: null, version: 'v1', is_private: 0 } as WorkspaceRow
}

describe('workspace snapshot versions', () => {
  it('retains the original folder/file hash contract and row ordering', () => {
    const rows = [row(1, '', true), row(2, 'folder', true), row(3, 'folder/nested', true), row(4, 'folder/nested/file'), row(5, 'other')]
    const versions = workspace_node_versions(rows)
    for (const node of rows) expect(versions.get(node.id)).toBe(node_version(rows, node))
    rows[3]!.node_revision ++
    const changed = workspace_node_versions(rows)
    expect(changed.get(1)).not.toBe(versions.get(1))
    expect(changed.get(2)).not.toBe(versions.get(2))
    expect(changed.get(5)).toBe(versions.get(5))
  })
  it('constructs a ten-thousand-file snapshot without repeatedly scanning every file', () => {
    const rows = [row(1, '', true), ... Array.from({ length: 10000 }, (_, index) => row(index + 2, `file${index}`))]
    const versions = workspace_node_versions(rows)
    expect(versions.size).toBe(10001)
    expect(versions.get(500)).toBe(node_version(rows, rows[499]!))
    expect(versions.get(1)).toBe(node_version(rows, rows[0]!))
  })
})

describe('workspace receipt replay', () => {
  function database() {
    const receipts = new Map<string, { actor_id: number, request_id: string, scope_id: number, fingerprint: string, result: object | string, expires_at: number }>()
    const state = { now: 0, effects: 0 }
    const execute = vi.fn(async (sql: string, args: unknown[] = []) => {
      if (sql.includes('FROM content_stories'))
        return [[{ id: 1 }]]
      if (sql.includes('FROM users'))
        return [[{ id: 7, is_admin: 1, is_banned: 0, permissions: [] }]]
      if (sql.startsWith('SELECT') && sql.includes('FROM content_command_receipts')) {
        if (sql.includes('FOR UPDATE')) {
          const receipt = receipts.get(`${args[0]}:${args[1]}`)
          return [receipt ? [{ ... receipt, expired: Number(receipt.expires_at <= state.now) }] : []]
        }
        return [[... receipts.values()].map(receipt => ({ ... receipt, actor_id: String(receipt.actor_id), expired: Number(receipt.expires_at <= state.now) }))]
      }
      if (sql.startsWith('INSERT INTO content_command_receipts')) {
        receipts.set(`${args[0]}:${args[1]}`, { actor_id: Number(args[0]), request_id: String(args[1]), scope_id: Number(args[2]),
          fingerprint: String(args[3]), result: String(args[4]), expires_at: state.now + Number(args[5]) * 3600_000 })
        return [{ affectedRows: 1 }]
      }
      if (sql.startsWith('UPDATE content_command_receipts SET result = JSON_OBJECT()')) {
        const receipt = receipts.get(`${args[0]}:${args[1]}`)!
        if (receipt.expires_at <= state.now)
          receipt.result = {}
        return [{ affectedRows: 1 }]
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    })
    const connection = { execute, query: vi.fn(), beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }
    boundary.getConnection.mockResolvedValue(connection)
    const action = vi.fn(async () => ({ effect: ++ state.effects, refresh: {} }))
    const body = { operation: 'test', request_id: 'request' }
    const run = () => workspace_transaction(7, 'request', 1, body, action)
    return { receipts, state, execute, connection, action, body, run }
  }

  it.each(['string', 'object'])('replays an unexpired %s result without executing its effects again', async (format) => {
    const { run, action, state, receipts } = database()
    const result = await run()
    if (format === 'object') {
      const receipt = receipts.get('7:request')!
      receipt.result = JSON.parse(String(receipt.result))
    }
    state.now = 24 * 3600_000 - 1
    await expect(run()).resolves.toEqual(result)
    expect(action).toHaveBeenCalledOnce()
    expect(receipts.size).toBe(1)
  })

  it('rejects the original request at expiry and after compaction without running it again', async () => {
    const { run, action, state, receipts, execute, connection } = database()
    await run()
    const original = { ... receipts.get('7:request')! }
    state.now = original.expires_at
    await expect(run()).rejects.toMatchObject({ statusCode: 409 })
    await create_content_receipt_compactor({ execute } as unknown as Parameters<typeof create_content_receipt_compactor>[0],
      { enabled: true, sweepIntervalSeconds: 60, scanLimit: 100 })()
    expect(receipts.get('7:request')).toEqual({ ... original, result: {} })
    await expect(run()).rejects.toMatchObject({ statusCode: 409 })
    // The empty tombstone is authoritative even if the clock moves backwards.
    state.now = 0
    await expect(run()).rejects.toMatchObject({ statusCode: 409 })
    expect(action).toHaveBeenCalledOnce()
    expect(connection.commit).toHaveBeenCalledOnce()
    expect(connection.rollback).toHaveBeenCalledTimes(3)
  })

  it('rejects a serialized empty tombstone before attempting to use its missing outcome', async () => {
    const { run, body, receipts, action } = database()
    receipts.set('7:request', { actor_id: 7, request_id: 'request', scope_id: 1,
      fingerprint: createHash('sha256').update(JSON.stringify(body)).digest('hex'), result: '{}', expires_at: 1 })
    await expect(run()).rejects.toMatchObject({ statusCode: 409 })
    expect(action).not.toHaveBeenCalled()
    expect(receipts.size).toBe(1)
  })
})
