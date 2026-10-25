import type { Pool } from 'mysql2/promise'
import { beforeEach, expect, it, vi } from 'vitest'
import { enqueue_content_refresh } from './sync-outbox.repository'
import { create_content_sync_dispatcher } from './sync-outbox.service'

vi.mock('@server/lib/log', () => ({ log_error: vi.fn() }))
const options = { enabled: true, sweepIntervalSeconds: 1, scanLimit: 5, leaseSeconds: 30, publishTimeoutMs: 10000, retrySeconds: 5, maxRetrySeconds: 300 }
interface Row { id: string, resource: string, payload: string, attempts: number, due: number, token: string | null, lease: number }
let now: number
beforeEach(() => {
  now = 0
})
function fixture() {
  const rows = new Map<string, Row>()
  let committed = new Map<string, Row>()
  let in_transaction = false
  const execute = vi.fn(async (sql: string, values: unknown[] = []): Promise<unknown[]> => {
    if (sql.startsWith('INSERT INTO content_sync_outbox')) {
      rows.set(String(values[0]), { id: String(values[0]), resource: String(values[1]), payload: String(values[2]), attempts: 0, due: 0, token: null, lease: 0 })
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('SELECT id, resource')) {
      const row = [... rows.values()].find(row => row.due <= now && row.lease <= now)
      return [row ? [structuredClone(row)] : []]
    }
    const deleting = sql.startsWith('DELETE')
    const claiming = sql.includes('attempts = attempts + 1')
    const row = rows.get(String(values[claiming ? 2 : deleting ? 0 : 1]))
    if (! row)
      return [{ affectedRows: 0 }]
    if (claiming) {
      row.token = String(values[0])
      row.lease = now + Number(values[1])
      row.attempts ++
    }
    else {
      expect(in_transaction).toBe(false)
      const token = String(values[deleting ? 1 : 2])
      if (row.token !== token || row.lease <= now)
        return [{ affectedRows: 0 }]
      if (deleting)
        rows.delete(row.id)
      else
        Object.assign(row, { token: null, lease: 0, due: now + Number(values[0]) })
    }
    return [{ affectedRows: 1 }]
  })
  const connection = {
    execute,
    beginTransaction: vi.fn(async () => {
      committed = structuredClone(rows)
      in_transaction = true
    }),
    commit: vi.fn(async () => { in_transaction = false }),
    rollback: vi.fn(async () => {
      rows.clear()
      committed.forEach((row, id) => rows.set(id, row))
      in_transaction = false
    }),
    release: vi.fn(),
  }
  const pool = { execute, getConnection: async () => connection } as unknown as Pool
  const publish = vi.fn(async (_resource: string, _payload: string, _timeout: number) => {
    expect(in_transaction).toBe(false)
  })
  const sweep = () => create_content_sync_dispatcher(pool, publish, options)()
  async function seed(resources = ['content_story:1']) {
    await connection.beginTransaction()
    await enqueue_content_refresh(connection as never, resources)
    await connection.commit()
  }
  return { rows, connection, pool, publish, sweep, seed }
}

it('deduplicates a transaction resource set and persists immutable event IDs before external delivery', async () => {
  const f = fixture()
  await f.seed(['content_story:1', 'content_story:1', 'content_stories:all'])
  expect(f.rows.size).toBe(2)
  expect(f.publish).not.toHaveBeenCalled()
  const events = [... f.rows.values()].map(row => row.payload)
  await f.sweep()
  expect(f.publish.mock.calls.map(([, payload]) => payload)).toEqual(events)
  expect(events.map(payload => JSON.parse(payload))).toEqual([
    expect.objectContaining({ id: expect.stringMatching(/^[\da-f]{32}$/), type: 'refresh', resource: 'content_story:1' }),
    expect.objectContaining({ type: 'refresh', resource: 'content_stories:all' }),
  ])
  expect(f.rows.size).toBe(0)
})

it('rolls back notification inserts with the business transaction', async () => {
  const f = fixture()
  await f.connection.beginTransaction()
  await enqueue_content_refresh(f.connection as never, ['content_story:1'])
  await f.connection.rollback()
  await f.sweep()
  expect(f.rows.size).toBe(0)
  expect(f.publish).not.toHaveBeenCalled()
})

it('persists an in-flight broker acknowledgement and leaves later events queued on shutdown', async () => {
  const f = fixture()
  await f.seed(['content_story:1', 'content_story:2'])
  const controller = new AbortController()
  f.publish.mockImplementation(async () => {
    controller.abort()
  })
  await create_content_sync_dispatcher(f.pool, f.publish, options)(controller.signal)
  expect(f.publish).toHaveBeenCalledOnce()
  expect(f.rows.size).toBe(1)
})

it('a fresh dispatcher retries an unconfirmed delivery using the original payload after backoff', async () => {
  const f = fixture()
  await f.seed()
  const event = [... f.rows.values()][0]!
  f.publish.mockRejectedValueOnce(new Error('disconnected'))
  await f.sweep()
  expect(f.rows.get(event.id)).toMatchObject({ token: null, due: 5, attempts: 1 })
  await f.sweep()
  expect(f.publish).toHaveBeenCalledOnce()
  now = 5
  await f.sweep()
  expect(f.publish.mock.calls[1]).toEqual(f.publish.mock.calls[0])
  expect(f.rows.size).toBe(0)
})

it('keeps a live lease exclusive and recovers it after process loss', async () => {
  const f = fixture()
  await f.seed()
  const row = [... f.rows.values()][0]!
  row.token = 'crashed-worker'
  row.lease = 30
  await f.sweep()
  expect(f.publish).not.toHaveBeenCalled()
  now = 31
  await f.sweep()
  expect(f.publish).toHaveBeenCalledOnce()
  expect(f.rows.size).toBe(0)
})

it.each([false, true])('an expired worker cannot remove or reschedule a newer lease (failure=%s)', async (failure) => {
  const f = fixture()
  await f.seed()
  const row = [... f.rows.values()][0]!
  f.publish.mockImplementationOnce(async () => {
    now = 31
    row.token = 'replacement'
    row.lease = 61
    if (failure)
      throw new Error('late failure')
  })
  await f.sweep()
  expect(f.rows.get(row.id)).toMatchObject({ token: 'replacement', lease: 61, due: 0 })
})

it('replays after broker ACK followed by database failure, without changing the event ID', async () => {
  const f = fixture()
  await f.seed()
  const execute = f.connection.execute.getMockImplementation()!
  let crash = true
  f.connection.execute.mockImplementation(async (sql, values) => {
    if (crash && (sql.startsWith('DELETE') || sql.includes('delivery_unconfirmed')))
      throw new Error('database unavailable after ACK')
    return execute(sql, values)
  })
  await expect(f.sweep()).rejects.toThrow('database unavailable')
  expect(f.rows.size).toBe(1)
  crash = false
  now = 31
  await f.sweep()
  expect(f.publish.mock.calls[1]).toEqual(f.publish.mock.calls[0])
  expect(f.rows.size).toBe(0)
})

it('never publishes an uncommitted claim', async () => {
  const f = fixture()
  await f.seed()
  f.connection.commit.mockRejectedValueOnce(new Error('commit failed'))
  await expect(f.sweep()).rejects.toThrow('commit failed')
  expect(f.publish).not.toHaveBeenCalled()
  expect([... f.rows.values()][0]?.token).toBeNull()
})

it('caps backoff and keeps retrying without silently dropping old events', async () => {
  const f = fixture()
  await f.seed()
  const row = [... f.rows.values()][0]!
  row.attempts = 1000
  f.publish.mockRejectedValueOnce(new Error('outage'))
  await f.sweep()
  expect(row.due).toBe(300)
  now = 300
  await f.sweep()
  expect(f.rows.size).toBe(0)
})

it('can pause delivery without removing pending work', async () => {
  const f = fixture()
  await f.seed()
  await create_content_sync_dispatcher(f.pool, f.publish, { ... options, enabled: false })()
  expect(f.rows.size).toBe(1)
  expect(f.publish).not.toHaveBeenCalled()
})
