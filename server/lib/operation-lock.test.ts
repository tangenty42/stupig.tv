import { ApiError } from '@server/errors/ApiError'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 锁的语义全部在 SQL 边界上（命名锁临界区、前缀冲突、过期清理、按 token
// 释放/续租），按仓库约定 mock db 边界，不碰真实数据库。mock 直接在内存里
// 模拟 content_locks 表的行为，以便断言"什么状态能拿到锁"。
const state = vi.hoisted(() => ({
  /** 模拟的 content_locks 行 */
  rows: [] as { path: string, kind: string, task_id: number | null, token: string, expired: boolean }[],
  /** GET_LOCK 是否可用（false 模拟临界区被占） */
  guard_available: true,
  calls: [] as { sql: string, params: unknown[] }[],
}))

function execute(sql: string, params: unknown[]) {
  state.calls.push({ sql, params })
  if (sql.includes('GET_LOCK'))
    return [[{ acquired: state.guard_available ? 1 : 0 }]]
  if (sql.includes('RELEASE_LOCK'))
    return [[{ released: 1 }]]
  // 过期清理
  if (sql.includes('DELETE FROM content_locks') && sql.includes('expires_at < NOW()')) {
    state.rows = state.rows.filter(row => ! row.expired)
    return [{ affectedRows: 0 }]
  }
  // 活跃锁列表（临界区内 / list_scope_locks 共用）
  if (sql.includes('SELECT path, kind, task_id, expires_at'))
    return [state.rows.filter(row => ! row.expired).map(row => ({ path: row.path, kind: row.kind, task_id: row.task_id, expires_at: '2026-10-08 16:00:00' }))]
  if (sql.includes('INSERT INTO content_locks')) {
    // 范围锁：path 是 SQL 里的字面量 ''，参数为 [scope, kind, token, ttl]；
    // 路径锁：参数为 [scope, path, kind, task_id, token, ttl]
    const path_lock = params.length === 6
    const path = path_lock ? String(params[1]) : ''
    const kind = String(params[path_lock ? 2 : 1])
    const token = String(params[path_lock ? 4 : 2])
    const task_id = path_lock ? Number(params[3]) : null
    if (state.rows.some(row => row.path === path && ! row.expired))
      throw Object.assign(new Error('Duplicate entry'), { errno: 1062 })
    state.rows.push({ path, kind, task_id, token, expired: false })
    return [{ affectedRows: 1 }]
  }
  // 续租
  if (sql.includes('UPDATE content_locks')) {
    const [, , task_id, token] = params
    const matched = state.rows.filter(row => ! row.expired && row.task_id === task_id && row.token === token)
    return [{ affectedRows: matched.length }]
  }
  // 按 token 释放（scope 锁与路径锁共用）
  if (sql.includes('DELETE FROM content_locks') && sql.includes('token = ?')) {
    const token = params[params.length - 1]
    state.rows = state.rows.filter(row => row.token !== token)
    return [{ affectedRows: 1 }]
  }
  // get_operation_lock（SELECT 全部活跃锁，模拟 ORDER BY：scope 行优先）
  if (sql.includes('SELECT kind, expires_at')) {
    return [state.rows
      .filter(row => ! row.expired)
      .sort((left, right) => Number(right.path === '') - Number(left.path === ''))
      .map(row => ({ kind: row.kind, expires_at: '2026-10-08 16:00:00' }))]
  }
  return [{}]
}

vi.mock('@server/lib/db', () => ({
  db: {
    execute,
    getConnection: async () => ({ execute, release: () => {} }),
  },
}))

vi.mock('@shared/config', () => ({
  runtime_config: () => ({ app: { content: { operationLock: { ttlSeconds: 120 } } } }),
}))

const { acquire_operation_lock, acquire_path_locks, get_operation_lock, list_scope_locks, release_operation_lock, release_path_locks, renew_path_locks } = await import('@server/lib/operation-lock')

beforeEach(() => {
  state.rows = []
  state.guard_available = true
  state.calls = []
})

describe('acquire_operation_lock（scope 级，阶段 0 语义）', () => {
  it('空闲 scope：清理过期行后写入 path 为空的租约', async () => {
    const lock = await acquire_operation_lock(42, 'move')

    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ path: '', kind: 'move', task_id: null })
    expect(lock).toMatchObject({ scope_id: 42 })
    expect(state.calls.some(call => call.sql.includes('GET_LOCK'))).toBe(true)
    expect(state.calls.some(call => call.sql.includes('content_operation_locks'))).toBe(false)
  })

  it('已有活跃 scope 锁时抛 409', async () => {
    state.rows.push({ path: '', kind: 'move', task_id: null, token: 'other', expired: false })

    await expect(acquire_operation_lock(42, 'move')).rejects.toMatchObject({ statusCode: 409 })
    await expect(acquire_operation_lock(42, 'move')).rejects.toBeInstanceOf(ApiError)
    expect(state.rows).toHaveLength(1)
  })

  it('有任务持有路径锁时抛 409（旧操作与任务互斥）', async () => {
    state.rows.push({ path: 'a/b.png', kind: 'move', task_id: 7, token: 'task-token', expired: false })

    await expect(acquire_operation_lock(42, 'encrypt')).rejects.toMatchObject({ statusCode: 409 })
    expect(state.rows).toHaveLength(1)
  })

  it('过期的 scope 锁被清理后可接管', async () => {
    state.rows.push({ path: '', kind: 'move', task_id: null, token: 'stale', expired: true })

    const lock = await acquire_operation_lock(42, 'encrypt')

    expect(lock.scope_id).toBe(42)
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]?.token).toBe(lock.token)
  })

  it('命名锁临界区被占时抛 409', async () => {
    state.guard_available = false

    await expect(acquire_operation_lock(42, 'move')).rejects.toMatchObject({ statusCode: 409 })
    expect(state.rows).toHaveLength(0)
  })
})

describe('acquire_path_locks（任务路径锁）', () => {
  it('无冲突时每个路径写一行，携带 task_id', async () => {
    const result = await acquire_path_locks(42, ['a.png', 'dir/b.png'], 7, 'move')

    expect(result.acquired).toBe(true)
    expect(state.rows.map(row => row.path).sort()).toEqual(['a.png', 'dir/b.png'])
    expect(state.rows.every(row => row.task_id === 7)).toBe(true)
  })

  it('前缀冲突矩阵：祖先、后代、相同路径都互斥', async () => {
    state.rows.push({ path: 'a/b', kind: 'move', task_id: 1, token: 'held', expired: false })

    for (const requested of ['a/b/c.png', 'a', 'a/b']) {
      const result = await acquire_path_locks(42, [requested], 7, 'move')
      expect(result.acquired).toBe(false)
      if (! result.acquired)
        expect(result.conflicts).toEqual([requested])
    }
    expect(state.rows).toHaveLength(1)
  })

  it('scope 级锁（path 为空）与任意路径互斥', async () => {
    state.rows.push({ path: '', kind: 'encrypt', task_id: null, token: 'scope', expired: false })

    const result = await acquire_path_locks(42, ['a.png'], 7, 'move')
    expect(result.acquired).toBe(false)
  })

  it('过期路径锁先清理再获取', async () => {
    state.rows.push({ path: 'a.png', kind: 'move', task_id: 1, token: 'stale', expired: true })

    const result = await acquire_path_locks(42, ['a.png'], 7, 'move')

    expect(result.acquired).toBe(true)
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]?.task_id).toBe(7)
  })

  it('命名锁忙时不抛错，报告未获取（runner 稍后重试）', async () => {
    state.guard_available = false

    const result = await acquire_path_locks(42, ['a.png'], 7, 'move')
    expect(result.acquired).toBe(false)
    if (! result.acquired)
      expect(result.conflicts).toEqual([])
  })

  it('空路径集合直接获取成功，不写任何行', async () => {
    const result = await acquire_path_locks(42, [], 7, 'move')

    expect(result.acquired).toBe(true)
    expect(state.rows).toHaveLength(0)
  })
})

describe('renew_path_locks', () => {
  it('按 scope + task + token 滚动租约', async () => {
    const result = await acquire_path_locks(42, ['a.png', 'b.png'], 7, 'move')
    if (! result.acquired)
      throw new Error('unreachable')

    await renew_path_locks(result.lock)

    const update = state.calls.find(call => call.sql.includes('UPDATE content_locks'))
    expect(update?.params.slice(1)).toEqual([42, 7, result.lock.token])
  })

  it('部分锁行丢失（被清扫）时抛 409，任务必须停止', async () => {
    const result = await acquire_path_locks(42, ['a.png', 'b.png'], 7, 'move')
    if (! result.acquired)
      throw new Error('unreachable')
    state.rows = state.rows.filter(row => row.path !== 'b.png')

    await expect(renew_path_locks(result.lock)).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('release_path_locks', () => {
  it('只按 task + token 释放自己的锁', async () => {
    const mine = await acquire_path_locks(42, ['a.png'], 7, 'move')
    if (! mine.acquired)
      throw new Error('unreachable')
    state.rows.push({ path: 'c.png', kind: 'move', task_id: 8, token: 'other-task', expired: false })

    await release_path_locks(mine.lock)

    expect(state.rows.map(row => row.path)).toEqual(['c.png'])
  })
})

describe('get_operation_lock / list_scope_locks', () => {
  it('读取活跃 scope 锁并映射过期时间', async () => {
    state.rows.push({ path: '', kind: 'move', task_id: null, token: 'x', expired: false })

    const lock = await get_operation_lock(42)

    expect(lock).toEqual({ kind: 'move', expires_at: new Date('2026-10-08 16:00:00').toISOString() })
    expect(state.calls[0]?.sql).toContain('expires_at >= NOW()')
  })

  it('没有活跃 scope 锁时返回 null', async () => {
    expect(await get_operation_lock(42)).toBeNull()
  })

  it('只有任务路径锁时也返回它（过渡期：任务锁同样禁用结构操作）', async () => {
    state.rows.push({ path: 'a.png', kind: 'move', task_id: 7, token: 'x', expired: false })

    const lock = await get_operation_lock(42)

    expect(lock?.kind).toBe('move')
  })

  it('scope 锁与路径锁并存时优先返回 scope 锁', async () => {
    state.rows.push(
      { path: 'a.png', kind: 'move', task_id: 7, token: 'x', expired: false },
      { path: '', kind: 'encrypt', task_id: null, token: 'y', expired: false },
    )

    const lock = await get_operation_lock(42)

    expect(lock?.kind).toBe('encrypt')
  })

  it('list_scope_locks 返回全部活跃锁（含任务路径锁）', async () => {
    state.rows.push(
      { path: '', kind: 'move', task_id: null, token: 'x', expired: false },
      { path: 'a.png', kind: 'move', task_id: 7, token: 'y', expired: false },
      { path: 'old.png', kind: 'move', task_id: 9, token: 'z', expired: true },
    )

    const locks = await list_scope_locks(42)

    expect(locks.map(lock => lock.path).sort()).toEqual(['', 'a.png'])
    expect(locks.find(lock => lock.path === 'a.png')?.task_id).toBe(7)
  })
})

describe('release_operation_lock', () => {
  it('只按 scope + token 删除自己的租约', async () => {
    state.rows.push({ path: '', kind: 'move', task_id: null, token: 'my-token', expired: false })

    await release_operation_lock({ scope_id: 42, token: 'my-token' })

    expect(state.rows).toHaveLength(0)
  })
})
