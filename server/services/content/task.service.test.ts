import { ApiError } from '@server/errors/ApiError'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 任务存储的语义全在 SQL 边界上（事务写入、条件状态迁移、保留期过滤），
// mock db 边界并模拟 content_tasks / content_task_items 两表的最小行为。
const state = vi.hoisted(() => ({
  tasks: [] as { id: number, scope_id: number, kind: string, status: string, payload: string, actor_id: number | null, client_id: string | null }[],
  items: [] as { id: number, task_id: number, path: string, action: string, status: string, bytes_done: number, bytes_total: number, staging_key: string | null, upload_id: string | null, part_size: number | null, result: string | null }[],
  next_task_id: 1,
  next_item_id: 1,
  calls: [] as { sql: string, params: unknown[] }[],
  /** beginTransaction..commit 之间的 SQL，用来断言"同一事务" */
  in_transaction: false,
  tx_calls: [] as string[],
}))

function task_row(task: (typeof state.tasks)[number]) {
  return {
    ... task,
    error: null,
    heartbeat_at: null,
    created_at: '2026-10-08 16:00:00',
    updated_at: '2026-10-08 16:00:00',
  }
}

function execute(sql: string, params: unknown[] = []) {
  state.calls.push({ sql, params })
  if (state.in_transaction)
    state.tx_calls.push(sql)
  if (sql.includes('INSERT INTO content_tasks')) {
    const id = state.next_task_id ++
    state.tasks.push({ id, scope_id: Number(params[0]), kind: String(params[1]), status: String(params[2]), payload: String(params[3]), actor_id: params[4] as number | null, client_id: params[5] as string | null })
    return [{ insertId: id }]
  }
  if (sql.includes('INSERT INTO content_task_items')) {
    const id = state.next_item_id ++
    state.items.push({ id, task_id: Number(params[0]), path: String(params[1]), action: String(params[2]), status: String(params[3]), bytes_done: 0, bytes_total: Number(params[4]), staging_key: null, upload_id: null, part_size: null, result: params[5] === null ? null : String(params[5]) })
    return [{}]
  }
  if (sql.includes('FROM content_tasks WHERE id ='))
    return [state.tasks.filter(task => task.id === Number(params[0])).map(task_row)]
  if (sql.includes('FROM content_tasks') && sql.includes('scope_id'))
    return [state.tasks.filter(task => task.scope_id === Number(params[0])).map(task_row)]
  if (sql.includes('FROM content_task_items WHERE task_id IN'))
    return [state.items.filter(item => (params as number[]).includes(item.task_id))]
  if (sql.includes('FROM content_task_items WHERE task_id ='))
    return [state.items.filter(item => item.task_id === Number(params[0]))]
  if (sql.includes('UPDATE content_tasks SET status')) {
    const [to, , task_id, ... from] = params
    const task = state.tasks.find(item => item.id === Number(task_id))
    if (task && (from as string[]).includes(task.status)) {
      task.status = String(to)
      return [{ affectedRows: 1 }]
    }
    return [{ affectedRows: 0 }]
  }
  if (sql.includes('UPDATE content_tasks SET payload')) {
    const [payload, status, task_id] = params
    const task = state.tasks.find(item => item.id === Number(task_id))
    if (task) {
      task.payload = String(payload)
      task.status = String(status)
      return [{ affectedRows: 1 }]
    }
    return [{ affectedRows: 0 }]
  }
  if (sql.includes('UPDATE content_tasks SET heartbeat_at')) {
    const task = state.tasks.find(item => item.id === Number(params[0]))
    return [{ affectedRows: task?.status === 'running' ? 1 : 0 }]
  }
  if (sql.includes('UPDATE content_task_items SET')) {
    const item_id = Number(params[params.length - 2])
    const task_id = Number(params[params.length - 1])
    const item = state.items.find(entry => entry.id === item_id && entry.task_id === task_id)
    if (item && sql.includes('path = ?, status = ?')) {
      item.path = String(params[0])
      item.status = String(params[1])
      item.result = params[2] === null ? null : String(params[2])
    }
    else if (item && sql.includes('status = ?')) {
      item.status = String(params[0])
    }
    return [{ affectedRows: item ? 1 : 0 }]
  }
  return [{}]
}

vi.mock('@server/lib/db', () => ({
  db: {
    execute,
    query: execute,
    getConnection: async () => ({
      execute,
      beginTransaction: async () => {
        state.in_transaction = true
      },
      commit: async () => {
        state.in_transaction = false
      },
      rollback: async () => {
        state.in_transaction = false
      },
      release: () => {},
    }),
  },
}))

vi.mock('@config/loader', () => ({
  runtime_config: () => ({ app: { content: { task: { retentionHours: 24 } } } }),
}))

vi.mock('@server/lib/sync', () => ({
  publish_task_snapshot: vi.fn(),
  publish_refresh: vi.fn(),
  sync_resource: (type: string, id: string | number) => `${type}:${id}`,
}))

const { apply_task_resolutions, create_task, heartbeat_task, list_scope_tasks, task_snapshot, transition_task, update_task_item } = await import('@server/services/content/task.service')

beforeEach(() => {
  state.tasks = []
  state.items = []
  state.next_task_id = 1
  state.next_item_id = 1
  state.calls = []
  state.tx_calls = []
  state.in_transaction = false
})

describe('create_task', () => {
  it('在一个事务里写入任务与全部任务项，返回解析后的 payload', async () => {
    const created = await create_task({
      scope_id: 42,
      kind: 'move',
      payload: { moves: [{ file_name: 'a.png', target_folder: 'dir' }] },
      items: [{ path: 'a.png', action: 'move' }],
      actor_id: 7,
      client_id: 'client-1',
    })

    expect(state.tx_calls.some(sql => sql.includes('INSERT INTO content_tasks'))).toBe(true)
    expect(state.tx_calls.some(sql => sql.includes('INSERT INTO content_task_items'))).toBe(true)
    expect(created.task).toMatchObject({ id: 1, scope_id: 42, kind: 'move', status: 'queued', actor_id: 7, client_id: 'client-1' })
    expect(created.task.payload).toEqual({ moves: [{ file_name: 'a.png', target_folder: 'dir' }] })
    expect(created.items).toHaveLength(1)
    expect(created.items[0]).toMatchObject({ task_id: 1, path: 'a.png', action: 'move', status: 'pending' })
  })

  it('持久化 paused 状态与待 resolve 项，不需要额外 schema 列', async () => {
    const resolve = { kind: 'sanitize', from: 'a b.png', to: 'ab.png', reason: '文件名将被和谐' }
    const created = await create_task({
      scope_id: 42,
      kind: 'upload',
      payload: { uploads: [{ path: 'a b.png', size: 10, mime_type: null }] },
      items: [{ path: 'a b.png', action: 'upload', bytes_total: 10, result: { resolve } }],
      actor_id: 7,
      client_id: 'client-1',
      status: 'paused',
    })

    expect(created.task.status).toBe('paused')
    expect(created.items[0]?.result).toEqual({ resolve })
    expect(state.tx_calls.some(sql => sql.includes('INSERT INTO content_task_items'))).toBe(true)
  })
})

describe('transition_task', () => {
  it('合法迁移：UPDATE 附带当前状态前提', async () => {
    state.tasks.push({ id: 1, scope_id: 42, kind: 'move', status: 'queued', payload: '{}', actor_id: null, client_id: null })

    await transition_task(1, 'running')

    const update = state.calls.find(call => call.sql.includes('UPDATE content_tasks SET status'))
    expect(update?.params).toEqual(['running', null, 1, 'queued'])
    expect(state.tasks[0]?.status).toBe('running')
  })

  it('非法/过期的迁移（当前状态不在前提里）抛 409', async () => {
    state.tasks.push({ id: 1, scope_id: 42, kind: 'move', status: 'done', payload: '{}', actor_id: null, client_id: null })

    await expect(transition_task(1, 'running')).rejects.toMatchObject({ statusCode: 409 })
    await expect(transition_task(1, 'running')).rejects.toBeInstanceOf(ApiError)
    expect(state.tasks[0]?.status).toBe('done')
  })
})

describe('apply_task_resolutions', () => {
  it('全部跳过时在选择事务内直接完成任务，不留下 queued 中间态', async () => {
    state.tasks.push({ id: 1, scope_id: 42, kind: 'upload', status: 'paused', payload: '{}', actor_id: null, client_id: null })
    state.items.push({ id: 11, task_id: 1, path: 'a.png', action: 'upload', status: 'pending', bytes_done: 0, bytes_total: 10, staging_key: null, upload_id: null, part_size: null, result: JSON.stringify({ resolve: { kind: 'rename' } }) })

    const resolved = await apply_task_resolutions(1, {}, [{ item_id: 11, path: 'a.png', status: 'skipped', result: { reason: '用户选择跳过' } }], {})

    expect(resolved.task.status).toBe('done')
    expect(resolved.items[0]).toMatchObject({ status: 'skipped', result: { reason: '用户选择跳过' } })
    expect(state.tx_calls.some(sql => sql.includes('UPDATE content_tasks SET payload'))).toBe(true)
  })

  it('在锁住的 paused 任务事务内写回选择，并在最后一项后 queued', async () => {
    state.tasks.push({ id: 1, scope_id: 42, kind: 'upload', status: 'paused', payload: '{"uploads":[{"path":"a b.png"}]}', actor_id: null, client_id: null })
    state.items.push({ id: 11, task_id: 1, path: 'a b.png', action: 'upload', status: 'pending', bytes_done: 0, bytes_total: 10, staging_key: null, upload_id: null, part_size: null, result: JSON.stringify({ resolve: { kind: 'sanitize', from: 'a b.png', to: 'ab.png', reason: 'sanitize' } }) })

    const resolved = await apply_task_resolutions(1, { uploads: [{ path: 'ab.png' }] }, [
      { item_id: 11, path: 'ab.png', status: 'pending', result: null },
    ], { uploads: [{ path: 'a b.png' }] })

    expect(state.tasks[0]).toMatchObject({ status: 'queued', payload: '{"uploads":[{"path":"ab.png"}]}' })
    expect(resolved.items[0]).toMatchObject({ path: 'ab.png', status: 'pending', result: null })
    expect(state.tx_calls.some(sql => sql.includes('FOR UPDATE'))).toBe(true)
    expect(state.in_transaction).toBe(false)
  })

  it('还存在未决定项时继续保持 paused', async () => {
    state.tasks.push({ id: 1, scope_id: 42, kind: 'upload', status: 'paused', payload: '{}', actor_id: null, client_id: null })
    state.items.push(
      { id: 11, task_id: 1, path: 'a.png', action: 'upload', status: 'pending', bytes_done: 0, bytes_total: 10, staging_key: null, upload_id: null, part_size: null, result: JSON.stringify({ resolve: { kind: 'rename' } }) },
      { id: 12, task_id: 1, path: 'b.png', action: 'upload', status: 'pending', bytes_done: 0, bytes_total: 10, staging_key: null, upload_id: null, part_size: null, result: JSON.stringify({ resolve: { kind: 'sanitize' } }) },
    )

    await apply_task_resolutions(1, {}, [{ item_id: 11, path: 'a-1.png', status: 'pending', result: null }], {})

    expect(state.tasks[0]?.status).toBe('paused')
    expect(state.items[1]?.result).toContain('sanitize')
  })

  it('两个设备按同一旧 payload 处理不同项时拒绝后到者，刷新后可保留前一项继续处理', async () => {
    const base = { uploads: [{ path: 'a b.png' }, { path: 'c d.png' }] }
    state.tasks.push({ id: 1, scope_id: 42, kind: 'upload', status: 'paused', payload: JSON.stringify(base), actor_id: null, client_id: null })
    for (const [index, upload] of base.uploads.entries()) {
      state.items.push({ id: 11 + index, task_id: 1, path: upload.path, action: 'upload', status: 'pending', bytes_done: 50, bytes_total: 100, staging_key: `staging/${index}`, upload_id: `multipart-${index}`, part_size: 50, result: JSON.stringify({ resolve: { kind: 'sanitize', from: upload.path, to: upload.path.replaceAll(' ', '') } }) })
    }
    const first_payload = { uploads: [{ path: 'ab.png' }, { path: 'c d.png' }] }
    await apply_task_resolutions(1, first_payload, [{ item_id: 11, path: 'ab.png', status: 'pending', result: null }], base)
    const before_stale = structuredClone({ tasks: state.tasks, items: state.items })
    state.tx_calls = []

    await expect(apply_task_resolutions(1, { uploads: [{ path: 'a b.png' }, { path: 'cd.png' }] }, [
      { item_id: 12, path: 'cd.png', status: 'pending', result: null },
    ], base)).rejects.toMatchObject({ statusCode: 409, message: '任务内容已变化，请刷新后重试' })

    expect({ tasks: state.tasks, items: state.items }).toEqual(before_stale)
    expect(state.tx_calls.some(sql => sql.startsWith('UPDATE'))).toBe(false)
    const resolved = await apply_task_resolutions(1, { uploads: [{ path: 'ab.png' }, { path: 'cd.png' }] }, [
      { item_id: 12, path: 'cd.png', status: 'pending', result: null },
    ], first_payload)
    expect(resolved.task).toMatchObject({ status: 'queued', payload: { uploads: [{ path: 'ab.png' }, { path: 'cd.png' }] } })
    expect(resolved.items).toMatchObject([
      { path: 'ab.png', bytes_done: 50, staging_key: 'staging/0', upload_id: 'multipart-0', part_size: 50 },
      { path: 'cd.png', bytes_done: 50, staging_key: 'staging/1', upload_id: 'multipart-1', part_size: 50 },
    ])
  })
})

describe('list_scope_tasks', () => {
  it('按保留期过滤并把任务项按任务分组', async () => {
    state.tasks.push({ id: 1, scope_id: 42, kind: 'move', status: 'running', payload: '{}', actor_id: null, client_id: null })
    state.items.push(
      { id: 1, task_id: 1, path: 'a.png', action: 'move', status: 'done', bytes_done: 0, bytes_total: 0, staging_key: null, upload_id: null, part_size: null, result: null },
      { id: 2, task_id: 1, path: 'b.png', action: 'move', status: 'pending', bytes_done: 0, bytes_total: 0, staging_key: null, upload_id: null, part_size: null, result: null },
    )

    const tasks = await list_scope_tasks(42)

    const list_query = state.calls.find(call => call.sql.includes('status NOT IN'))
    expect(list_query?.params).toEqual([42, 24])
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.items.map(item => item.path)).toEqual(['a.png', 'b.png'])
  })
})

describe('heartbeat_task', () => {
  it('只有 running 的任务能心跳；否则抛 409', async () => {
    state.tasks.push({ id: 1, scope_id: 42, kind: 'move', status: 'running', payload: '{}', actor_id: null, client_id: null })
    await heartbeat_task(1)
    expect(state.calls.some(call => call.sql.includes(`status = 'running'`))).toBe(true)

    state.tasks[0]!.status = 'cancelled'
    await expect(heartbeat_task(1)).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('update_task_item', () => {
  it('只更新 patch 里给出的字段，且按 task 归属限定', async () => {
    state.items.push({ id: 5, task_id: 1, path: 'a.png', action: 'move', status: 'active', bytes_done: 0, bytes_total: 10, staging_key: null, upload_id: null, part_size: null, result: null })

    await update_task_item(1, 5, { status: 'done', bytes_done: 10 })

    const update = state.calls.find(call => call.sql.includes('UPDATE content_task_items SET'))
    expect(update?.sql).toContain('status = ?')
    expect(update?.sql).toContain('bytes_done = ?')
    expect(update?.sql).not.toContain('staging_key')
    expect(update?.params).toEqual(['done', 10, 5, 1])
    expect(state.items[0]?.status).toBe('done')
  })

  it('空 patch 不发任何 SQL', async () => {
    await update_task_item(1, 5, {})
    expect(state.calls).toHaveLength(0)
  })
})

describe('task_snapshot', () => {
  it('只带进度展示需要的字段（不含暂存 key 等内部状态）', () => {
    const snapshot = task_snapshot({
      task: {
        id: 1,
        scope_id: 42,
        kind: 'upload',
        status: 'running',
        payload: {},
        actor_id: null,
        client_id: null,
        error: null,
        heartbeat_at: null,
        created_at: '',
        updated_at: '',
      },
      items: [{
        id: 7,
        task_id: 1,
        path: 'a.png',
        action: 'upload',
        status: 'active',
        bytes_done: 30,
        bytes_total: 100,
        staging_key: 'content-upload/42/secret',
        upload_id: 'up-1',
        part_size: 50,
        result: null,
      }],
    })

    expect(snapshot).toEqual({
      task_id: 1,
      scope_id: 42,
      status: 'running',
      items: [{ id: 7, path: 'a.png', status: 'active', bytes_done: 30, bytes_total: 100, resolution: null, reason: null, retry_of_item_id: null, superseded_at: null, paused_at: null, control_version: 0 }],
    })
    expect(JSON.stringify(snapshot)).not.toContain('secret')
    expect(JSON.stringify(snapshot)).not.toContain('up-1')
  })

  it('内部唯一 path 的待处理/跳过任务项以原始名称供其它端展示', () => {
    const snapshot = task_snapshot({
      task: {
        id: 1,
        scope_id: 42,
        kind: 'upload',
        status: 'paused',
        payload: {},
        actor_id: null,
        client_id: null,
        error: null,
        heartbeat_at: null,
        created_at: '',
        updated_at: '',
      },
      items: [{
        id: 12,
        task_id: 1,
        path: '__pending_upload_1',
        action: 'upload',
        status: 'skipped',
        bytes_done: 0,
        bytes_total: 100,
        staging_key: null,
        upload_id: null,
        part_size: null,
        result: { resolution: { kind: 'rename', from: 'same.png', to: 'same-1.png', reason: 'duplicate' }, reason: '用户选择跳过' },
      }],
    })

    expect(snapshot.items[0]).toMatchObject({ path: 'same.png', resolution: null, reason: '用户选择跳过' })
    expect(JSON.stringify(snapshot)).not.toContain('__pending_upload_1')
  })
})
