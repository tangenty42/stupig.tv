import { ApiError } from '@server/errors/ApiError'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 锁的语义全部在 SQL 边界上（插入/过期抢夺条件/按 token 释放/只读未过期），
// 按仓库约定 mock db 边界，不碰真实数据库。
const state = vi.hoisted(() => ({
  calls: [] as { sql: string, params: unknown[] }[],
  /** INSERT 时捕获的 token（SELECT 默认回显它，模拟自己拿到锁） */
  inserted_token: null as string | null,
  /** SELECT token 的覆盖值：设置为他人 token 即模拟锁被持有 */
  select_token: null as string | null,
  /** get_operation_lock 的返回行 */
  lock_rows: [] as { kind: string, expires_at: string }[],
}))

vi.mock('@server/lib/db', () => ({
  db: {
    execute: async (sql: string, params: unknown[]) => {
      state.calls.push({ sql, params })
      if (sql.includes('INSERT INTO content_locks')) {
        state.inserted_token = String(params[2])
        return [{}]
      }
      if (sql.includes('SELECT token')) {
        return [[{ token: state.select_token ?? state.inserted_token }]]
      }
      if (sql.includes('SELECT kind, expires_at')) {
        return [state.lock_rows]
      }
      return [{}]
    },
  },
}))

vi.mock('@shared/config', () => ({
  runtime_config: () => ({ app: { content: { operationLock: { ttlSeconds: 120 } } } }),
}))

const { acquire_operation_lock, get_operation_lock, release_operation_lock } = await import('@server/lib/operation-lock')

beforeEach(() => {
  state.calls = []
  state.inserted_token = null
  state.select_token = null
  state.lock_rows = []
})

describe('acquire_operation_lock', () => {
  it('向 content_locks 的 scope 行（path 为空）写入带 TTL 的租约', async () => {
    const lock = await acquire_operation_lock(42, 'move')

    const insert = state.calls.find(call => call.sql.includes('INSERT INTO content_locks'))
    expect(insert?.params[0]).toBe(42)
    expect(insert?.params[1]).toBe('move')
    expect(insert?.params[2]).toBe(state.inserted_token)
    expect(insert?.params[3]).toBe(120)
    expect(insert?.sql).toContain('ON DUPLICATE KEY UPDATE')
    expect(state.calls.some(call => call.sql.includes('content_operation_locks'))).toBe(false)
    expect(lock.scope_id).toBe(42)
    expect(lock.token).toBe(state.inserted_token)
  })

  it('锁被他人持有时抛 409，不接管租约', async () => {
    state.select_token = 'someone-elses-token'

    await expect(acquire_operation_lock(42, 'move')).rejects.toMatchObject({
      statusCode: 409,
    })
    await expect(acquire_operation_lock(42, 'move')).rejects.toBeInstanceOf(ApiError)
  })
})

describe('release_operation_lock', () => {
  it('只按 scope + token 删除自己的租约', async () => {
    await release_operation_lock({ scope_id: 42, token: 'my-token' })

    const del = state.calls.find(call => call.sql.includes('DELETE FROM content_locks'))
    expect(del?.params).toEqual([42, 'my-token'])
  })
})

describe('get_operation_lock', () => {
  it('有未过期租约时返回 kind 和 ISO 过期时间', async () => {
    state.lock_rows = [{ kind: 'move', expires_at: '2026-10-08 14:00:00' }]

    const lock = await get_operation_lock(42)

    expect(lock).toEqual({ kind: 'move', expires_at: new Date('2026-10-08 14:00:00').toISOString() })
    expect(state.calls[0]?.sql).toContain('expires_at >= NOW()')
  })

  it('没有未过期租约时返回 null', async () => {
    expect(await get_operation_lock(42)).toBeNull()
  })
})
