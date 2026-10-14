import { beforeEach, describe, expect, it, vi } from 'vitest'

// Exercise the real persistence entry point against a transactional DB boundary.
// The mutex models the task-row lock; rollback restores uncommitted writes.
const db_state = vi.hoisted(() => ({
  tasks: [] as Record<string, unknown>[],
  items: [] as Record<string, unknown>[],
  next_task: 2,
  next_item: 3,
  fail_mark: false,
  tail: Promise.resolve(),
}))

function execute(sql: string, params: unknown[] = []): unknown[] {
  if (sql.startsWith('UPDATE content_tasks SET status = \'paused\'')) {
    const task = db_state.tasks.find(row => row.id === params[0])!
    const waiting = db_state.items.filter(row => row.task_id === params[0] && ['pending', 'active'].includes(String(row.status)) && ! row.superseded_at)
    const changed = task.status === 'running' && waiting.length > 0 && waiting.every(row => row.paused_at)
    if (changed)
      task.status = 'paused'
    return [{ affectedRows: changed ? 1 : 0 }]
  }
  if (sql.startsWith('UPDATE content_task_items SET paused_at')) {
    const item = db_state.items.find(row => row.id === params[0] && row.task_id === params[1])!
    item.paused_at = sql.includes('CURRENT_TIMESTAMP') ? '2026-10-13T06:00:00Z' : null
    item.control_version = Number(item.control_version ?? 0) + 1
    return [{ affectedRows: 1 }]
  }
  if (sql.startsWith('UPDATE content_tasks SET status = ?')) {
    db_state.tasks.find(row => row.id === params[1])!.status = params[0]
    return [{ affectedRows: 1 }]
  }
  if (sql.startsWith('DELETE FROM content_locks'))
    return [{ affectedRows: 1 }]
  if (sql.startsWith('SELECT')) {
    if (sql.includes('FROM content_tasks'))
      return [structuredClone(db_state.tasks.filter(row => row.id === params[0]))]
    return [structuredClone(db_state.items.filter(row => sql.includes('retry_of_item_id =') ? row.retry_of_item_id === params[0] : row.task_id === params[0]))]
  }
  if (sql.startsWith('INSERT INTO content_tasks')) {
    const id = db_state.next_task ++
    db_state.tasks.push({ id, scope_id: params[0], kind: params[1], status: params[2], payload: params[3], actor_id: params[4], client_id: params[5], error: null, heartbeat_at: null, created_at: '', updated_at: '' })
    return [{ insertId: id }]
  }
  if (sql.startsWith('INSERT INTO content_task_items')) {
    const id = db_state.next_item ++
    db_state.items.push({ id, task_id: params[0], path: params[1], action: params[2], status: params[3], bytes_done: 0, bytes_total: params[4], result: params[5], retry_of_item_id: params[6], superseded_at: null, staging_key: null, upload_id: null, part_size: null })
    return [{ insertId: id }]
  }
  if (sql.startsWith('UPDATE content_task_items SET superseded_at')) {
    if (db_state.fail_mark)
      throw new Error('write failed')
    const old = db_state.items.find(row => row.id === params[0] && row.task_id === params[1])!
    old.superseded_at = '2026-10-13T00:00:00Z'
    return [{ affectedRows: 1 }]
  }
  if (sql.startsWith('DELETE FROM content_tasks')) {
    const old = db_state.tasks.find(row => row.id === params[0] && ['done', 'failed', 'cancelled'].includes(String(row.status)))
    db_state.tasks = db_state.tasks.filter(row => row !== old)
    return [{ affectedRows: old ? 1 : 0 }]
  }
  if (sql.startsWith('DELETE FROM content_task_items')) {
    db_state.items = db_state.items.filter(row => row.task_id !== params[0])
    return [{ affectedRows: 1 }]
  }
  throw new Error(`Unexpected SQL: ${sql}`)
}

vi.mock('@server/lib/db', () => ({ db: {
  execute,
  getConnection: async () => {
    let release_lock = () => {}
    let before: { tasks: Record<string, unknown>[], items: Record<string, unknown>[] } | null = null
    return {
      execute,
      beginTransaction: async () => {
        const preceding = db_state.tail
        db_state.tail = new Promise<void>((resolve) => {
          release_lock = resolve
        })
        await preceding
        before = structuredClone({ tasks: db_state.tasks, items: db_state.items })
      },
      commit: async () => {
        before = null
        release_lock()
      },
      rollback: async () => {
        if (before) {
          db_state.tasks = before.tasks
          db_state.items = before.items
        }
        before = null
        release_lock()
      },
      release: () => {},
    }
  },
} }))
vi.mock('@server/lib/sync', () => ({ publish_task_snapshot: vi.fn() }))
const { create_task, delete_finished_task, get_task, pause_task_if_all_items_paused, set_transfer_paused } = await import('./task.service')

const payload = { uploads: [{ path: 'a.png', source_file_name: 'a.png', size: 100, mime_type: null }] }
const retry = () => create_task({ scope_id: 42, kind: 'upload', payload, items: [{ path: 'a.png', action: 'upload', bytes_total: 100 }], actor_id: 1, client_id: 'tab', retry: { task_id: 1, item_id: 1, base_payload: payload } })

beforeEach(() => {
  db_state.tasks = [{ id: 1, scope_id: 42, kind: 'upload', status: 'failed', payload: JSON.stringify(payload), actor_id: 1, client_id: 'old', error: 'failed', heartbeat_at: null, created_at: '', updated_at: '' }]
  db_state.items = [1, 2].map(id => ({ id, task_id: 1, path: id === 1 ? 'a.png' : 'b.png', action: 'upload', status: 'failed', bytes_done: 0, bytes_total: 100, staging_key: null, upload_id: null, part_size: null, result: null, superseded_at: null, retry_of_item_id: null }))
  db_state.next_task = 2
  db_state.next_item = 3
  db_state.fail_mark = false
  db_state.tail = Promise.resolve()
})

describe('durable item retry', () => {
  it('does not fork a resumable multipart upload', async () => {
    db_state.items[0]!.staging_key = 'existing/parts'
    await expect(retry()).rejects.toMatchObject({ statusCode: 409 })
    expect(db_state.tasks).toHaveLength(1)
  })

  it('links successive failures as a chain without modifying siblings', async () => {
    const first = await retry()
    db_state.tasks.find(row => row.id === first.task.id)!.status = 'failed'
    db_state.items.find(row => row.id === first.items[0]!.id)!.status = 'failed'
    const second = await create_task({ scope_id: 42, kind: 'upload', payload, items: [{ path: 'a.png', action: 'upload', bytes_total: 100 }], actor_id: 1, client_id: 'tab', retry: { task_id: first.task.id, item_id: first.items[0]!.id, base_payload: payload } })
    expect(second.items[0]?.retry_of_item_id).toBe(first.items[0]?.id)
    expect((await get_task(first.task.id))?.items[0]?.superseded_at).toBeTruthy()
    expect((await get_task(1))?.items[1]?.superseded_at).toBeNull()
  })
  it('creates one successor under concurrent retries and a lost-response replay', async () => {
    const [a, b] = await Promise.all([retry(), retry()])
    expect(a.task.id).toBe(b.task.id)
    expect((await retry()).task.id).toBe(a.task.id)
    expect(db_state.tasks).toHaveLength(2)
    expect(a.items[0]?.retry_of_item_id).toBe(1)
    const old = await get_task(1)
    expect(old?.items[0]?.superseded_at).toBeTruthy()
    expect(old?.items[0]?.status).toBe('failed')
    expect(old?.items[1]?.superseded_at).toBeNull()
  })

  it('rolls back the successor when marking the old attempt fails', async () => {
    db_state.fail_mark = true
    await expect(retry()).rejects.toThrow('write failed')
    expect(db_state.tasks).toHaveLength(1)
    expect(db_state.items).toHaveLength(2)
    expect(db_state.items[0]?.superseded_at).toBeNull()
  })

  it.each(['running', 'cancelled'])('does not replace a task concurrently moved to %s', async (status) => {
    db_state.tasks[0]!.status = status
    await expect(retry()).rejects.toMatchObject({ statusCode: 409 })
    expect(db_state.tasks).toHaveLength(1)
  })

  it('checks scope and stale payload under the lock', async () => {
    db_state.tasks[0]!.scope_id = 43
    await expect(retry()).rejects.toMatchObject({ statusCode: 404 })
    db_state.tasks[0]!.scope_id = 42
    db_state.tasks[0]!.payload = '{}'
    await expect(retry()).rejects.toMatchObject({ statusCode: 409 })
  })

  it('keeps retries when old history expires and keeps old tombstone when successor expires', async () => {
    const next = await retry()
    db_state.tasks.find(row => row.id === next.task.id)!.status = 'failed'
    expect(await delete_finished_task(next.task.id)).toBe(true)
    await expect(retry()).rejects.toMatchObject({ statusCode: 409 })
    expect((await get_task(1))?.items[0]?.superseded_at).toBeTruthy()
    expect(await delete_finished_task(1)).toBe(true)
    expect(db_state.items).toEqual([])
  })

  it('retention deletion and retry serialize without orphaned items', async () => {
    const [deleted, attempted] = await Promise.allSettled([delete_finished_task(1), retry()])
    expect(deleted.status).toBe('fulfilled')
    expect(attempted.status).toBe('rejected')
    expect(db_state.tasks).toEqual([])
    expect(db_state.items).toEqual([])
  })
})

describe('durable transfer control', () => {
  beforeEach(() => {
    db_state.tasks[0]!.status = 'running'
    for (const item of db_state.items) {
      item.status = 'active'
      item.staging_key = `stage/${item.id}`
      item.paused_at = null
      item.control_version = 0
    }
  })

  it('persists individual pauses, parks an entirely paused batch and resumes the same items', async () => {
    const first = await set_transfer_paused(1, 1, true)
    expect(first.task.status).toBe('running')
    expect(first.items[0]).toMatchObject({ paused_at: '2026-10-13T06:00:00Z', control_version: 1, staging_key: 'stage/1' })
    expect(first.items[1]?.paused_at).toBeNull()
    const all = await set_transfer_paused(1, 2, true)
    expect(all.task.status).toBe('paused')
    expect((await set_transfer_paused(1, 2, true)).items[1]?.control_version).toBe(1)
    const continued = await set_transfer_paused(1, 1, false)
    expect(continued.task.status).toBe('queued')
    expect(continued.items[0]).toMatchObject({ id: 1, paused_at: null, control_version: 2, staging_key: 'stage/1' })
    expect(continued.items[1]?.paused_at).toBeTruthy()
    expect(db_state.tasks).toHaveLength(1)
    expect(db_state.items).toHaveLength(2)
  })

  it.each(['cancelled', 'done'])('rejects stale transfer control after %s', async (status) => {
    db_state.tasks[0]!.status = status
    await expect(set_transfer_paused(1, 1, false)).rejects.toMatchObject({ statusCode: 409 })
    await expect(set_transfer_paused(1, 1, true)).rejects.toMatchObject({ statusCode: 409 })
    expect(db_state.items[0]?.control_version).toBe(0)
  })

  it('keeps name resolution separate from transfer pause', async () => {
    db_state.tasks[0]!.status = 'paused'
    db_state.items[0]!.result = JSON.stringify({ resolve: { kind: 'rename' } })
    await expect(set_transfer_paused(1, 1, false)).rejects.toMatchObject({ statusCode: 409 })
    expect(db_state.tasks[0]!.status).toBe('paused')
  })

  it('rechecks all paused siblings without undoing a concurrent continue', async () => {
    await set_transfer_paused(1, 1, true)
    db_state.items[1]!.status = 'done'
    expect(await pause_task_if_all_items_paused(1)).toBe(true)
    expect(db_state.tasks[0]!.status).toBe('paused')
    await set_transfer_paused(1, 1, false)
    db_state.tasks[0]!.status = 'running'
    expect(await pause_task_if_all_items_paused(1)).toBe(false)
    expect(db_state.tasks[0]!.status).toBe('running')
  })
})
