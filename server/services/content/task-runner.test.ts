import type { ContentTaskWithItems } from '@server/services/content/task.service'
import { ApiError } from '@server/errors/ApiError'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// runner 的语义在调度与边界协作上：锁、状态迁移、执行器、事件都 mock 在边界，
// 断言的是调度决策本身（何时执行、何时留下、错误怎么落地）。
const state = vi.hoisted(() => ({
  tasks: new Map<number, { task: ContentTaskWithItems['task'], items: ContentTaskWithItems['items'] }>(),
  lock_conflict: false,
  lock_released: [] as number[][],
  executed: [] as number[],
  execute_error: null as Error | null,
  published: [] as string[],
  transitioned: [] as { id: number, to: string }[],
  transition_error_once: false,
  execute_incomplete: false,
  expired: [] as number[],
  delete_claimed: true,
  deleted: [] as number[],
  discarded: [] as unknown[],
  order: [] as string[],
}))

function make_task(id: number, status = 'queued'): ContentTaskWithItems {
  return {
    task: {
      id,
      scope_id: 42,
      kind: 'move',
      status: status as ContentTaskWithItems['task']['status'],
      payload: { moves: [{ file_name: 'a.png', target_folder: 'dir' }] },
      actor_id: null,
      client_id: null,
      error: null,
      heartbeat_at: null,
      created_at: '',
      updated_at: '',
    },
    items: [{
      id: id * 10,
      task_id: id,
      path: 'a.png',
      action: 'move',
      status: 'pending',
      bytes_done: 0,
      bytes_total: 0,
      staging_key: null,
      upload_id: null,
      part_size: null,
      result: null,
    }],
  }
}

vi.mock('@server/services/content/task.service', () => ({
  get_task: vi.fn(async (id: number) => state.tasks.get(id) ?? null),
  list_queued_tasks: vi.fn(async () => [... state.tasks.values()].filter(entry => entry.task.status === 'queued')),
  transition_task: vi.fn(async (id: number, to: string, patch?: { error?: string | null }) => {
    if (state.transition_error_once) {
      state.transition_error_once = false
      throw new ApiError(409, '任务状态已变化，请刷新后重试')
    }
    const entry = state.tasks.get(id)
    if (entry) {
      entry.task.status = to as ContentTaskWithItems['task']['status']
      entry.task.error = patch?.error ?? null
    }
    state.transitioned.push({ id, to })
  }),
  is_terminal_task_status: (status: string) => ['done', 'failed', 'cancelled'].includes(status),
  heartbeat_task: vi.fn(async (id: number) => {
    const entry = state.tasks.get(id)
    if (! entry || entry.task.status !== 'running')
      throw new ApiError(409, '任务状态已变化，请刷新后重试')
  }),
  publish_task_state: vi.fn(async () => {}),
  list_expired_tasks: vi.fn(async () => state.expired),
  delete_finished_task: vi.fn(async (id: number) => {
    state.order.push(`delete:${id}`)
    state.deleted.push(id)
    return state.delete_claimed
  }),
}))

vi.mock('@server/services/content/task-operations.service', () => ({
  task_lock_paths: vi.fn(() => ['a.png', 'dir/a.png']),
  discard_task_staging: vi.fn(async (items: unknown) => {
    state.order.push('discard')
    state.discarded.push(items)
  }),
  execute_task: vi.fn(async (task: ContentTaskWithItems['task']) => {
    state.executed.push(task.id)
    if (state.execute_error)
      throw state.execute_error
    // 传输类任务返回 complete: false（留给客户端回报），默认按纯 DB 任务处理
    return { complete: state.execute_incomplete !== true }
  }),
}))

vi.mock('@server/lib/operation-lock', () => ({
  acquire_path_locks: vi.fn(async (scope_id: number, paths: string[], task_id: number) => (
    state.lock_conflict
      ? { acquired: false as const, conflicts: paths }
      : { acquired: true as const, lock: { scope_id, task_id, token: 't', paths } }
  )),
  release_path_locks: vi.fn(async (lock: { task_id: number }) => {
    state.lock_released.push([lock.task_id])
  }),
  release_task_locks: vi.fn(async (scope_id: number, task_id: number) => {
    state.lock_released.push([scope_id, task_id])
  }),
  renew_task_locks: vi.fn(async () => 1),
}))

vi.mock('@server/lib/sync', () => ({
  publish_refresh: vi.fn((event: { resource: string }) => {
    state.published.push(event.resource)
  }),
  sync_resource: (type: string, id: string | number) => `${type}:${id}`,
}))

vi.mock('@server/lib/log', () => ({ log_error: vi.fn(), log_info: vi.fn(), log_warn: vi.fn(), error_fields: () => ({}) }))
vi.mock('@shared/config', () => ({ runtime_config: () => ({ app: { content: { task: { sweepIntervalSeconds: 60, queuedTimeoutSeconds: 300 } } } }) }))
vi.mock('@server/lib/db', () => ({ db: { execute: vi.fn(async () => [[]]) } }))

const { dispatch_task, run_task_synchronously, run_task_tick } = await import('@server/services/content/task-runner.service')

beforeEach(() => {
  state.tasks = new Map()
  state.lock_conflict = false
  state.lock_released = []
  state.executed = []
  state.execute_error = null
  state.published = []
  state.transitioned = []
  state.transition_error_once = false
  state.execute_incomplete = false
  state.expired = []
  state.delete_claimed = true
  state.deleted = []
  state.discarded = []
  state.order = []
})

describe('dispatch_task', () => {
  it('排队任务：取锁 → running → 执行 → done，释放锁并广播任务刷新', async () => {
    state.tasks.set(1, make_task(1))

    await dispatch_task(1)

    expect(state.executed).toEqual([1])
    expect(state.transitioned.map(entry => entry.to)).toEqual(['running', 'done'])
    expect(state.lock_released).toEqual([[42, 1]])
    expect(state.published).toEqual(['content_story_tasks:42'])
    expect(state.tasks.get(1)?.task.status).toBe('done')
  })

  it('传输类任务（执行器不完成）：保持 running 并继续持锁，等客户端回报', async () => {
    state.tasks.set(1, make_task(1))
    state.execute_incomplete = true

    await dispatch_task(1)

    expect(state.executed).toEqual([1])
    expect(state.transitioned.map(entry => entry.to)).toEqual(['running'])
    // 锁不释放：上传任务的全部主张就建立在这些路径锁上
    expect(state.lock_released).toEqual([])
    expect(state.tasks.get(1)?.task.status).toBe('running')
  })

  it('锁冲突时留在队列，不执行、不改状态', async () => {
    state.tasks.set(1, make_task(1))
    state.lock_conflict = true

    await dispatch_task(1)

    expect(state.executed).toEqual([])
    expect(state.transitioned).toEqual([])
    expect(state.tasks.get(1)?.task.status).toBe('queued')
  })

  it('非排队任务直接跳过（幂等）', async () => {
    state.tasks.set(1, make_task(1, 'done'))

    await dispatch_task(1)

    expect(state.executed).toEqual([])
  })

  it('执行器抛错：任务标记 failed 并携带错误，锁释放，错误重抛给同步调用方', async () => {
    state.tasks.set(1, make_task(1))
    state.execute_error = new ApiError(404, '附件不存在或已被删除')

    await expect(dispatch_task(1)).rejects.toMatchObject({ statusCode: 404 })

    expect(state.tasks.get(1)?.task.status).toBe('failed')
    expect(state.tasks.get(1)?.task.error).toBe('附件不存在或已被删除')
    expect(state.lock_released).toEqual([[42, 1]])
  })

  it('状态迁移竞态（他人抢先 running）：安静让位，不执行、不标失败', async () => {
    state.tasks.set(1, make_task(1))
    state.transition_error_once = true

    await dispatch_task(1)

    expect(state.executed).toEqual([])
    expect(state.tasks.get(1)?.task.status).toBe('queued')
    expect(state.lock_released).toEqual([[1]])
  })
})

describe('run_task_synchronously', () => {
  it('派发后到达终态：返回任务与任务项', async () => {
    state.tasks.set(1, make_task(1))

    const result = await run_task_synchronously(1)

    expect(result.task.status).toBe('done')
    expect(result.items).toHaveLength(1)
  })

  it('派发后仍在排队（锁被占）：抛 409，与旧 scope 锁语义一致', async () => {
    state.tasks.set(1, make_task(1))
    state.lock_conflict = true

    await expect(run_task_synchronously(1)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('执行器的 ApiError 原样透传', async () => {
    state.tasks.set(1, make_task(1))
    state.execute_error = new ApiError(400, '不能移动到文件夹自身内部')

    await expect(run_task_synchronously(1)).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('tick：过期任务清算', () => {
  /** A terminal task whose item still holds a staged multipart. */
  function expired_task(id: number) {
    const entry = make_task(id, 'failed')
    entry.items[0]!.staging_key = 'content-upload/42/x'
    entry.items[0]!.upload_id = 'up-1'
    return entry
  }

  it('先删行再释放暂存对象：没有可续传的行之后，multipart 才被 abort', async () => {
    state.tasks.set(7, expired_task(7))
    state.expired = [7]

    await run_task_tick()

    expect(state.deleted).toEqual([7])
    expect(state.discarded).toEqual([[state.tasks.get(7)!.items[0]]])
    // 顺序很重要：先声明行已被删除（否则可能被并发 resume 拿回去续传）。
    expect(state.order).toEqual(['delete:7', 'discard'])
  })

  it('保留期内的任务不动', async () => {
    state.tasks.set(7, expired_task(7))
    state.expired = []

    await run_task_tick()

    expect(state.deleted).toEqual([])
    expect(state.discarded).toEqual([])
  })

  it('删行没抢到（任务刚被重新排队）时不释放暂存：续传仍然可用', async () => {
    state.tasks.set(7, expired_task(7))
    state.expired = [7]
    state.delete_claimed = false

    await run_task_tick()

    expect(state.deleted).toEqual([7])
    expect(state.discarded).toEqual([])
    expect(state.order).toEqual(['delete:7'])
  })
})
