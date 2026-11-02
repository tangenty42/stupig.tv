import type { Pool } from 'mysql2'
import { expect, it, vi } from 'vitest'
import { observe_database_pool } from './database-observation'

it('observes queued callback acquisition once and preserves the exact connection/error', () => {
  let reply!: Parameters<Pool['getConnection']>[0]
  const pool = { getConnection: vi.fn((callback: typeof reply) => {
    reply = callback
  }) } as unknown as Pool
  const finish = vi.fn()
  const begin = vi.fn(() => finish)
  observe_database_pool(pool, begin)
  observe_database_pool(pool, begin)
  const callback = vi.fn()
  pool.getConnection(callback)
  expect(begin).toHaveBeenCalledOnce()
  expect(finish).not.toHaveBeenCalled()
  const connection = {} as Parameters<typeof reply>[1]
  reply(null, connection)
  expect(finish).toHaveBeenCalledExactlyOnceWith(false)
  expect(callback).toHaveBeenCalledExactlyOnceWith(null, connection)
})

it('records callback and synchronous failures without substituting a different error', () => {
  const error = new Error('pool unavailable')
  const finish = vi.fn()
  const pool = { getConnection: vi.fn((callback: Parameters<Pool['getConnection']>[0]) => callback(error, undefined!)) } as unknown as Pool
  observe_database_pool(pool, () => finish)
  const callback = vi.fn()
  pool.getConnection(callback)
  expect(callback).toHaveBeenCalledWith(error, undefined)
  expect(finish).toHaveBeenCalledWith(true)
  const throwing = { getConnection: () => {
    throw error
  } } as unknown as Pool
  observe_database_pool(throwing, () => finish)
  expect(() => throwing.getConnection(callback)).toThrow(error)
})
