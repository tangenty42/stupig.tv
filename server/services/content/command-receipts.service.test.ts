import type { Pool } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { create_content_receipt_compactor } from './command-receipts.service'

function receipt(actor_id: string, request_id: string, expires_at = 100) {
  return { actor_id, request_id, expires_at, fingerprint: 'original-fingerprint', scope_id: 9, created_at: 1,
    result: { value: { attachment_id: 7 } } as object }
}

function database(rows: ReturnType<typeof receipt>[]) {
  const state = { now: 100, reads: [] as string[][], writes: [] as string[], before_update: (_request: string) => {}, after_read: () => {} }
  const execute = vi.fn(async (sql: string, args: unknown[]) => {
    if (sql.startsWith('SELECT')) {
      const page = rows.filter((row) => {
        if (sql.includes('r.actor_id = ?'))
          return row.actor_id === args[0] && row.request_id > String(args[1])
        if (sql.includes('r.actor_id > ?'))
          return BigInt(row.actor_id) > BigInt(String(args[0]))
        return true
      }).sort((a, b) => a.actor_id === b.actor_id ? a.request_id.localeCompare(b.request_id) : BigInt(a.actor_id) < BigInt(b.actor_id) ? - 1 : 1)
        .slice(0, Number(args.at(- 1)))
      state.reads.push(page.map(row => row.request_id))
      const selected = page.map(row => ({ actor_id: row.actor_id, request_id: row.request_id, expired: Number(row.expires_at <= state.now) }))
      state.after_read()
      return [selected]
    }
    // This boundary deliberately rejects DELETE or updates to identity fields.
    expect(sql).toMatch(/^UPDATE content_command_receipts SET result = JSON_OBJECT\(\)\s+WHERE actor_id = \? AND request_id = \? AND expires_at <= CURRENT_TIMESTAMP\(3\) AND JSON_LENGTH\(result\) > 0$/)
    state.before_update(String(args[1]))
    const row = rows.find(row => row.actor_id === args[0] && row.request_id === args[1])!
    state.writes.push(row.request_id)
    const eligible = row.expires_at <= state.now && Object.keys(row.result).length > 0
    if (eligible)
      row.result = {}
    return [{ affectedRows: Number(eligible) }]
  })
  return { state, execute, pool: { execute } as unknown as Pick<Pool, 'execute'> }
}

const options = { enabled: true, sweepIntervalSeconds: 60, scanLimit: 2 }

it('compacts only expired payloads, retaining identity and both successful and rejected tombstones', async () => {
  const rows = [receipt('2', 'a'), receipt('2', 'b', 99), receipt('2', 'c', 101)]
  rows[1]!.result = { error: { message: 'rejected', public_data: { code: 'BATCH_REJECTED' } } }
  const original = structuredClone(rows)
  const { pool } = database(rows)
  await create_content_receipt_compactor(pool, { ... options, scanLimit: 100 })()
  expect(rows).toEqual(original.map((row, index) => index < 2 ? { ... row, result: {} } : row))
})

it('does no database work when disabled or already aborted', async () => {
  const { pool, execute } = database([receipt('2', 'a')])
  await create_content_receipt_compactor(pool, { ... options, enabled: false })()
  await create_content_receipt_compactor(pool, options)(AbortSignal.abort())
  expect(execute).not.toHaveBeenCalled()
})

it('advances across live and empty receipts, crosses actors in numeric order, and bounds each page', async () => {
  const rows = [receipt('2', 'a', 101), receipt('2', 'b'), receipt('2', 'c'), receipt('10', 'a'), receipt('9007199254740993', 'z')]
  rows[1]!.result = {}
  const { pool, state } = database(rows)
  const sweep = create_content_receipt_compactor(pool, options)
  await sweep()
  expect(state.reads).toEqual([['a', 'b']])
  await sweep()
  expect(state.reads.slice(1)).toEqual([['c'], ['a']])
  await sweep()
  expect(state.reads.slice(3)).toEqual([[], ['z']])
  expect(rows.map(row => row.result)).toEqual([{ value: { attachment_id: 7 } }, {}, {}, {}, {}])
  expect(rows.at(- 1)!.actor_id).toBe('9007199254740993')
})

it('wraps after a short final page and revisits newly expired rows and inserts behind the cursor', async () => {
  const rows = [receipt('2', 'b', 101), receipt('2', 'c'), receipt('2', 'd')]
  const { pool, state } = database(rows)
  const sweep = create_content_receipt_compactor(pool, options)
  await sweep()
  await sweep()
  state.now = 101
  rows.unshift(receipt('1', 'a'))
  state.reads = []
  await sweep()
  expect(state.reads).toEqual([['a', 'b']])
  expect(rows.every(row => Object.keys(row.result).length === 0)).toBe(true)
})

it('wraps after an exactly full final page and remains runnable on an empty table', async () => {
  const rows = [receipt('2', 'a'), receipt('2', 'b')]
  const { pool, state } = database(rows)
  const sweep = create_content_receipt_compactor(pool, options)
  await sweep()
  await sweep()
  await sweep()
  expect(state.reads).toEqual([['a', 'b'], [], [], ['a', 'b']])
  const empty = database([])
  const empty_sweep = create_content_receipt_compactor(empty.pool, options)
  await empty_sweep()
  await empty_sweep()
  expect(empty.state.reads).toEqual([[], []])
})

it('stops after discovery on abort without advancing or writing', async () => {
  const rows = [receipt('2', 'a'), receipt('2', 'b')]
  const { pool, state } = database(rows)
  const controller = new AbortController()
  state.after_read = () => controller.abort()
  const sweep = create_content_receipt_compactor(pool, options)
  await sweep(controller.signal)
  expect(state.writes).toEqual([])
  state.after_read = () => {}
  await sweep()
  expect(state.reads).toEqual([['a', 'b'], ['a', 'b']])
  expect(rows.every(row => Object.keys(row.result).length === 0)).toBe(true)
})

it('keeps the last completed row on mid-page abort and stops before another range query', async () => {
  const rows = [receipt('2', 'a'), receipt('2', 'b'), receipt('3', 'c')]
  const { pool, state } = database(rows)
  const controller = new AbortController()
  state.before_update = () => controller.abort()
  const sweep = create_content_receipt_compactor(pool, options)
  await sweep(controller.signal)
  expect(state.writes).toEqual(['a'])
  const next = new AbortController()
  state.after_read = () => next.abort()
  await sweep(next.signal)
  expect(state.reads).toEqual([['a', 'b'], ['b']])
  state.after_read = () => {}
  state.before_update = () => {}
  await sweep()
  expect(state.reads.slice(2)).toEqual([['b'], ['c']])
  expect(rows.every(row => Object.keys(row.result).length === 0)).toBe(true)
})

it('retries a failed update from the last completed row, including an uncertain committed write', async () => {
  const rows = [receipt('2', 'a'), receipt('2', 'b'), receipt('3', 'c')]
  const { pool, state } = database(rows)
  state.before_update = (request) => {
    if (request === 'b') {
      rows[1]!.result = {}
      throw new Error('reply lost after commit')
    }
  }
  const sweep = create_content_receipt_compactor(pool, options)
  await expect(sweep()).rejects.toThrow('reply lost')
  expect(state.writes).toEqual(['a'])
  state.before_update = () => {}
  await sweep()
  expect(state.reads.slice(1)).toEqual([['b'], ['c']])
  expect(rows.every(row => Object.keys(row.result).length === 0)).toBe(true)
  // A new process starts at the beginning without needing a durable checkpoint.
  await create_content_receipt_compactor(pool, options)()
  expect(state.reads.at(- 1)).toEqual(['a', 'b'])
})

it('does not lose a partially discovered page when the following range read fails', async () => {
  const rows = [receipt('2', 'a'), receipt('2', 'b'), receipt('2', 'c'), receipt('3', 'd')]
  const { pool, execute, state } = database(rows)
  const sweep = create_content_receipt_compactor(pool, options)
  execute.mockRejectedValueOnce(new Error('discovery failed'))
  await expect(sweep()).rejects.toThrow('discovery failed')
  await sweep()
  const implementation = execute.getMockImplementation()!
  execute.mockImplementationOnce(implementation).mockRejectedValueOnce(new Error('following range failed'))
  await expect(sweep()).rejects.toThrow('following range failed')
  expect(state.writes).toEqual(['a', 'b'])
  await sweep()
  expect(state.reads.slice(- 2)).toEqual([['c'], ['d']])
  expect(rows.every(row => Object.keys(row.result).length === 0)).toBe(true)
})

it('rechecks expiry at update time and tolerates repeated compaction by another runner', async () => {
  const rows = [receipt('2', 'a')]
  const { pool, state } = database(rows)
  state.before_update = () => {
    state.now = 99
  }
  await create_content_receipt_compactor(pool, options)()
  expect(rows[0]!.result).toEqual({ value: { attachment_id: 7 } })
  state.now = 100
  state.before_update = () => {}
  const first = create_content_receipt_compactor(pool, options)
  const second = create_content_receipt_compactor(pool, options)
  await Promise.all([first(), second()])
  expect(rows).toEqual([{ ... receipt('2', 'a'), result: {} }])
})
