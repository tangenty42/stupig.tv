import { ApiError } from '@server/errors/ApiError'
import { settings } from '@shared/settings'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// task-api 是编排层：断言它把校验、预签、回报、完成这几步按正确的顺序和边界
// 串起来。锁、存储、任务表、执行器都在边界处 mock。
const state = vi.hoisted(() => ({
  task: null as unknown,
  signed_parts: [] as { key: string, upload_id: string, part_number: number }[],
  signed_put: [] as { key: string, content_type: string | null }[],
  finalized: [] as { item_id: number, parts: unknown[] }[],
  finalize_error: null as Error | null,
  resumed: [] as number[],
  completed_tasks: [] as number[],
  transitioned: [] as { id: number, to: string }[],
  item_updates: [] as { item_id: number, patch: Record<string, unknown> }[],
  published: [] as string[],
  touched: [] as number[],
  kicked: 0,
  dispatched: [] as number[],
  discarded: [] as unknown[],
  created: [] as unknown[],
  applied_resolutions: [] as unknown[],
  scope_paths: [] as string[],
  scope_files: [] as { file_name: string }[],
  scope_folders: [] as string[],
  preflight_items: null as unknown[] | null,
}))

function make_task(overrides: Record<string, unknown> = {}) {
  return {
    task: {
      id: 9,
      scope_id: 42,
      kind: 'upload',
      status: 'running',
      payload: { uploads: [{ path: 'a.png', size: 100, mime_type: 'image/png' }] },
      actor_id: null,
      client_id: null,
      error: null,
      heartbeat_at: null,
      created_at: '',
      updated_at: '',
      ... overrides,
    },
    items: [{
      id: 11,
      task_id: 9,
      path: 'a.png',
      action: 'upload',
      status: 'active',
      bytes_done: 0,
      bytes_total: 100,
      staging_key: 'content-upload/42/x' as string | null,
      upload_id: 'up-1',
      part_size: 50,
      result: null,
    }],
  }
}

vi.mock('@server/services/content/task.service', () => ({
  set_transfer_paused: vi.fn(async () => state.task),
  get_retry_task: vi.fn(async () => null),
  get_task: vi.fn(async () => state.task),
  create_task: vi.fn(async (input: unknown) => {
    state.created.push(input)
    return state.task
  }),
  apply_task_resolutions: vi.fn(async (_id: number, payload: Record<string, unknown>, updates: { item_id: number, path: string, status: string, result: Record<string, unknown> | null }[]) => {
    state.applied_resolutions.push(updates)
    const current = state.task as {
      task: { status: string, payload: Record<string, unknown> }
      items: { id: number, path: string, status: string, result: Record<string, unknown> | null }[]
    } | null
    if (! current)
      return null
    current.task.payload = payload
    for (const update of updates) {
      const item = current.items.find(entry => entry.id === update.item_id)
      if (item) {
        item.path = update.path
        item.status = update.status
        item.result = update.result
      }
    }
    current.task.status = current.items.some(item => item.result?.resolve)
      ? 'paused'
      : current.items.every(item => ['done', 'skipped', 'failed'].includes(item.status)) ? 'done' : 'queued'
    return state.task
  }),
  transition_task: vi.fn(async (id: number, to: string) => {
    if ((state.task as { task: { status: string } } | null)?.task.status === 'running' && to === 'cancelled')
      throw new ApiError(409, '任务状态已变化，请刷新后重试')
    state.transitioned.push({ id, to })
    if (state.task) {
      const task = (state.task as { task: { status: string } }).task
      task.status = to
    }
  }),
  update_task_item: vi.fn(async (_task_id: number, item_id: number, patch: Record<string, unknown>) => {
    state.item_updates.push({ item_id, patch })
  }),
  list_scope_tasks: vi.fn(async () => []),
  publish_task_state: vi.fn(async () => {}),
}))

vi.mock('@server/services/content/task-runner.service', () => ({
  dispatch_task: vi.fn(async (id: number) => {
    state.dispatched.push(id)
  }),
  run_task_synchronously: vi.fn(async () => state.task),
  touch_task: vi.fn(async (id: number) => {
    state.touched.push(id)
  }),
  complete_task_if_finished: vi.fn(async (id: number) => {
    state.completed_tasks.push(id)
    return true
  }),
  kick_task_runner: vi.fn(() => {
    state.kicked ++
  }),
}))

vi.mock('@server/services/content/task-operations.service', () => ({
  task_item_paths: vi.fn((kind: string, payload: Record<string, unknown>) => {
    if (kind !== 'upload')
      return [{ path: 'a.png', action: 'upload', bytes_total: 100 }]
    const uploads = payload.uploads as { path: string, size: number }[]
    const claimed = new Set<string>()
    return uploads.map((entry, index) => {
      let path = entry.path
      if (claimed.has(path))
        path = `__pending_upload_${index}`
      claimed.add(path)
      return { path, action: 'upload', bytes_total: entry.size }
    })
  }),
  preflight_task: vi.fn(async (_scope: number, _kind: string, payload: Record<string, unknown>) => ({
    items: state.preflight_items ?? [{ path: 'a.png', action: 'upload', ok: true, reason: null, resolution: payload.uploads ? { kind: 'sanitize', from: 'a b.png', to: 'a-b.png', reason: 'normalize' } : null }],
    locks: [],
  })),
  discard_task_staging: vi.fn(async (items: unknown) => {
    state.discarded.push(items)
  }),
  finalize_transfer_item: vi.fn(async (_task: unknown, item: { id: number }, parts: unknown[]) => {
    if (state.finalize_error)
      throw state.finalize_error
    state.finalized.push({ item_id: item.id, parts })
    return { file_name: 'a.png', is_image: true }
  }),
  transfer_item_resume_state: vi.fn(async (item: { id: number }) => {
    state.resumed.push(item.id)
    return { staging_key: 'k', upload_id: 'up-1', part_size: 50, uploaded_parts: [{ part_number: 1, etag: 'e1', size: 50 }] }
  }),
}))

vi.mock('@server/services/content/attachment-structure.service', () => ({
  attachment_scope_payload: vi.fn(async () => ({ attachments: [], folders: [], operation_lock: null })),
}))

vi.mock('@server/services/content-attachments.service', () => ({
  get_scope_attachment: vi.fn(async () => ({ file_name: 'a.png' })),
  list_scope_paths: vi.fn(async () => state.scope_paths),
  list_scope_attachments: vi.fn(async () => state.scope_files),
  list_scope_folders: vi.fn(async () => state.scope_folders),
}))

vi.mock('@server/lib/operation-lock', () => ({
  release_task_locks: vi.fn(async () => {}),
}))

vi.mock('@server/lib/storage', () => ({
  signed_part_upload_url: vi.fn(async (key: string, upload_id: string, part_number: number) => {
    state.signed_parts.push({ key, upload_id, part_number })
    return `https://signed/part/${part_number}`
  }),
  signed_put_url: vi.fn(async (key: string, content_type: string | null) => {
    state.signed_put.push({ key, content_type })
    return 'https://signed/put'
  }),
}))

vi.mock('@server/lib/sync', () => ({
  publish_refresh: vi.fn((event: { resource: string }) => {
    state.published.push(event.resource)
  }),
  sync_resource: (type: string, id: string | number) => `${type}:${id}`,
}))

const { cancel_content_task, continue_content_task_item, create_content_task, pause_content_task_item, report_task_item, resolve_content_task, resume_content_task, resume_task_item, retry_content_task_item, sign_task_parts } = await import('@server/services/content/task-api.service')

describe('durable pause API', () => {
  it('暂停发布共享状态，继续派发原任务且不创建新项', async () => {
    state.task = make_task({ status: 'paused' })
    await pause_content_task_item(9, 11)
    expect(state.published).toContain('content_story_tasks:42')
    state.task = make_task({ status: 'queued' })
    await continue_content_task_item(9, 11)
    expect(state.dispatched).toEqual([9])
    expect(state.created).toEqual([])
  })

  it('暂停项拒绝迟到的传输请求', async () => {
    const paused = make_task()
    ;(paused.items[0] as Record<string, unknown>).paused_at = '2026-10-13T06:00:00Z'
    state.task = paused
    await expect(resume_task_item({ task_id: 9, item_id: 11 })).rejects.toMatchObject({ statusCode: 409 })
    await expect(report_task_item({ task_id: 9, item_id: 11, status: 'progress', bytes_done: 43 })).rejects.toMatchObject({ statusCode: 409 })
    expect(state.item_updates).toEqual([])
  })
})

describe('retry item orchestration', () => {
  it.each(['upload', 'replace', 'redact'])('重试保留 %s 语义且传入原任务比较基线', async (kind) => {
    const old = make_task({ kind, status: 'failed', payload: kind === 'upload' ? { uploads: [{ path: 'a.png', source_file_name: 'a.png', size: 100, mime_type: null }] } : kind === 'replace' ? { old_file_name: 'target.png', mode: 'keep-name', file_name: 'a.png', source_file_name: 'a.png', size: 100 } : { source_file_name: 'source.png.good', size: 100, content_type: 'image/png' } })
    old.items[0]!.status = 'failed'
    old.items[0]!.staging_key = null
    state.task = old
    await retry_content_task_item({ task_id: 9, item_id: 11, source_file_name: 'a.png', size: 100, actor_id: 1, client_id: 'new-tab' })
    expect(state.created[0]).toMatchObject({ kind, payload: old.task.payload, retry: { task_id: 9, item_id: 11, base_payload: old.task.payload } })
  })

  it.each(['skipped', 'done', 'active'])('拒绝 %s 项重新创建', async (status) => {
    const old = make_task({ status: 'failed' })
    old.items[0]!.status = status
    state.task = old
    await expect(retry_content_task_item({ task_id: 9, item_id: 11, source_file_name: 'a.png', size: 100, actor_id: 1, client_id: null })).rejects.toMatchObject({ statusCode: 409 })
    expect(state.created).toEqual([])
  })
})

beforeEach(() => {
  state.task = make_task()
  state.signed_parts = []
  state.signed_put = []
  state.finalized = []
  state.finalize_error = null
  state.resumed = []
  state.completed_tasks = []
  state.transitioned = []
  state.item_updates = []
  state.published = []
  state.touched = []
  state.kicked = 0
  state.dispatched = []
  state.discarded = []
  state.created = []
  state.applied_resolutions = []
  state.scope_paths = []
  state.scope_files = []
  state.scope_folders = []
  state.preflight_items = null
})

describe('sign_task_parts', () => {
  it('multipart 项逐分片预签，并回报片大小与 upload_id', async () => {
    const plan = await sign_task_parts({ task_id: 9, item_id: 11, part_numbers: [2, 1] })

    expect(state.signed_parts).toEqual([
      { key: 'content-upload/42/x', upload_id: 'up-1', part_number: 1 },
      { key: 'content-upload/42/x', upload_id: 'up-1', part_number: 2 },
    ])
    expect(plan.parts.map(part => part.part_number)).toEqual([1, 2])
    expect(plan).toMatchObject({ part_size: 50, upload_id: 'up-1', sign_batch_size: settings.app.content.upload.signBatchSize })
    // 每次传输调用都续租
    expect(state.touched).toEqual([9])
  })

  it('单次 PUT 项签整对象 PUT，用 payload 里的内容类型', async () => {
    const task = make_task()
    ;(task.items[0] as Record<string, unknown>).part_size = null
    ;(task.items[0] as Record<string, unknown>).upload_id = null
    state.task = task

    const plan = await sign_task_parts({ task_id: 9, item_id: 11, part_numbers: [1] })

    expect(state.signed_put).toEqual([{ key: 'content-upload/42/x', content_type: 'image/png' }])
    expect(plan.upload_id).toBeNull()
  })

  it('超出总分片数或超出批大小被拒绝', async () => {
    // bytes_total 100 / part_size 50 = 2 片
    await expect(sign_task_parts({ task_id: 9, item_id: 11, part_numbers: [3] })).rejects.toMatchObject({ statusCode: 400 })
    const part_numbers = Array.from({ length: settings.app.content.upload.signBatchSize + 1 }, (_, index) => index + 1)
    const task = make_task()
    task.items[0]!.bytes_total = part_numbers.length * task.items[0]!.part_size
    state.task = task
    await expect(sign_task_parts({ task_id: 9, item_id: 11, part_numbers })).rejects.toMatchObject({ statusCode: 400 })
    expect(state.signed_parts).toEqual([])
  })

  it('非 active 的任务项被拒绝', async () => {
    const task = make_task()
    ;(task.items[0] as Record<string, unknown>).status = 'done'
    state.task = task

    await expect(sign_task_parts({ task_id: 9, item_id: 11, part_numbers: [1] })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('任务项不存在时抛 404', async () => {
    await expect(sign_task_parts({ task_id: 9, item_id: 999, part_numbers: [1] })).rejects.toBeInstanceOf(ApiError)
  })
})

describe('report_task_item', () => {
  it('progress：只写 bytes_done（按总字节夹紧），不改状态', async () => {
    await report_task_item({ task_id: 9, item_id: 11, status: 'progress', bytes_done: 999 })

    expect(state.item_updates).toEqual([{ item_id: 11, patch: { bytes_done: 100 } }])
    expect(state.finalized).toEqual([])
    expect(state.completed_tasks).toEqual([])
  })

  it('completed：定稿 → 任务项 done（带附件结果）→ 收尾任务，并广播', async () => {
    const parts = [{ part_number: 1, etag: 'e1', size: 50 }]

    await report_task_item({ task_id: 9, item_id: 11, status: 'completed', parts })

    expect(state.finalized).toEqual([{ item_id: 11, parts }])
    expect(state.item_updates[0]?.patch).toMatchObject({ status: 'done', result: { attachment: { file_name: 'a.png', is_image: true } } })
    expect(state.completed_tasks).toEqual([9])
  })

  it('finalize 时撞名：该项 skipped、发布快照并收尾，不留下 running 锁', async () => {
    state.finalize_error = new ApiError(409, '操作时发生文件名冲突')

    await report_task_item({ task_id: 9, item_id: 11, status: 'completed', parts: [] })

    expect(state.item_updates).toEqual([{
      item_id: 11,
      patch: { status: 'skipped', result: { reason: '目标名称已被占用，请重新操作' } },
    }])
    expect(state.completed_tasks).toEqual([9])
    expect(state.finalized).toEqual([])
  })
})

describe('resume_task_item', () => {
  it('返回暂存 key 与已上传分片', async () => {
    const resume = await resume_task_item({ task_id: 9, item_id: 11 })

    expect(resume).toMatchObject({ staging_key: 'k', upload_id: 'up-1', part_size: 50 })
    expect(resume.uploaded_parts).toHaveLength(1)
    expect(state.resumed).toEqual([11])
  })
})

describe('cancel / resume（任务级）', () => {
  it('取消：转 cancelled、清锁、释放暂存对象、广播', async () => {
    await cancel_content_task(9)

    expect(state.transitioned).toEqual([{ id: 9, to: 'cancelling' }, { id: 9, to: 'cancelled' }])
    // 取消意味着这份传输永远不回来了：分片的 multipart 与暂存对象都要释放。
    expect(state.discarded).toEqual([[make_task().items[0]]])
    expect(state.published).toEqual(['content_story_tasks:42'])
  })

  it('恢复：重新排队并踢一次 runner', async () => {
    state.task = make_task({ status: 'failed' })

    await resume_content_task(9)

    expect(state.transitioned).toEqual([{ id: 9, to: 'queued' }])
    expect(state.kicked).toBe(1)
    expect(state.dispatched).toEqual([9])
  })

  it('失败任务的暂存不被清掉：下次恢复还要接着传', async () => {
    state.task = make_task({ status: 'failed' })

    await resume_content_task(9)

    expect(state.discarded).toEqual([])
  })

  it('任务不存在时抛 404', async () => {
    state.task = null

    await expect(cancel_content_task(9)).rejects.toMatchObject({ statusCode: 404 })
    await expect(resume_content_task(9)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('正在服务端执行的加密任务只能标记 cancelling：锁与暂存留给 dispatch 收尾', async () => {
    state.task = make_task({ kind: 'encrypt', payload: { file_names: ['a.png'] } })

    await cancel_content_task(9)

    expect(state.transitioned).toEqual([{ id: 9, to: 'cancelling' }])
    expect(state.discarded).toEqual([])
    expect(state.published).toEqual(['content_story_tasks:42'])
  })
})

describe('create / resolve（持久待处理）', () => {
  it('同批 sanitize 目标等于另一项原始名时，待处理项的内部 path 避开所有建议名', async () => {
    state.task = make_task({ status: 'paused' })
    state.preflight_items = [
      { path: 'a b.png', action: 'upload', ok: true, resolution: { kind: 'sanitize', from: 'a b.png', to: 'ab.png', entry_index: 0 } },
      { path: 'ab.png', action: 'upload', ok: true, resolution: { kind: 'rename', from: 'ab.png', to: 'ab-1.png', entry_index: 1 } },
    ]
    await create_content_task({ scope_id: 42, kind: 'upload', payload: { uploads: [{ path: 'a b.png', size: 10 }, { path: 'ab.png', size: 20 }] }, actor_id: 1, client_id: null })

    const items = (state.created[0] as { items: { path: string, result: { resolve: { entry_index: number } } }[] }).items
    expect(new Set(items.map(item => item.path)).size).toBe(2)
    expect(items.map(item => item.path)).not.toContain('ab.png')
    expect(items.map(item => item.path)).not.toContain('ab-1.png')
    expect(items.map(item => item.result.resolve.entry_index)).toEqual([0, 1])
  })

  it.each(['encrypt', 'decrypt', 'redact', 'move', 'rename', 'delete', 'folder_create', 'folder_delete'] as const)('createTask %s 不因缺少 resolve 预检而跳过任务项', async (kind) => {
    state.task = make_task({ kind, status: 'queued' })

    await create_content_task({ scope_id: 42, kind, payload: {}, actor_id: 1, client_id: null })

    expect(state.created[0]).toMatchObject({ status: 'queued', items: [{ path: 'a.png' }] })
    expect((state.created[0] as { items: { status?: string, result?: unknown }[] }).items[0]).not.toHaveProperty('status', 'skipped')
    expect(state.dispatched).toEqual([9])
  })

  it('createTask 将带 resolve 提供项的任务持久为 paused，且不 dispatch', async () => {
    state.task = make_task({ kind: 'upload', status: 'paused', payload: { uploads: [{ path: 'a.png', size: 100, mime_type: null }] } })

    const created = await create_content_task({
      scope_id: 42,
      kind: 'upload',
      payload: { uploads: [{ path: 'a.png', size: 100, mime_type: null }] },
      actor_id: 1,
      client_id: 'client-1',
    })

    expect(created.task.status).toBe('paused')
    expect(state.created[0]).toMatchObject({ status: 'paused', items: [{ result: { resolve: { kind: 'sanitize', to: 'a-b.png' } } }] })
    expect(state.dispatched).toEqual([])
  })

  it('重复 raw path 创建为独立任务项，第二项保留 entry_index resolve', async () => {
    state.task = make_task({ kind: 'upload', status: 'paused', payload: { uploads: [{ path: 'same.png' }, { path: 'same.png' }] } })
    state.preflight_items = [
      { path: 'same.png', action: 'upload', ok: true, reason: null, resolution: null },
      { path: 'same.png', action: 'upload', ok: true, reason: null, resolution: { kind: 'rename', from: 'same.png', to: 'same-1.png', reason: '冲突', entry_index: 1 } },
    ]

    await create_content_task({
      scope_id: 42,
      kind: 'upload',
      payload: { uploads: [{ path: 'same.png', size: 10 }, { path: 'same.png', size: 20 }] },
      actor_id: 1,
      client_id: 'client-1',
    })

    expect(state.created[0]).toMatchObject({
      status: 'paused',
      items: [
        { path: 'same.png' },
        { path: '__pending_upload_1', result: { resolve: { entry_index: 1, to: 'same-1.png' } } },
      ],
    })
  })

  function paused_upload_task() {
    const current = make_task({ kind: 'upload', status: 'paused', payload: { uploads: [{ path: 'a b.png', size: 100, mime_type: null }] } }) as {
      task: { status: string, payload: Record<string, unknown>, scope_id: number }
      items: { id: number, path: string, action: string, status: string, bytes_done: number, bytes_total: number, staging_key: string | null, upload_id: string | null, part_size: number | null, result: Record<string, unknown> | null }[]
    }
    current.items[0]!.path = 'a b.png'
    current.items[0]!.result = { resolve: { kind: 'sanitize', from: 'a b.png', to: 'ab.png', reason: '文件名将被和谐' } }
    state.task = current
  }

  it('apply 写回最终路径与 payload，并将任务重新排队', async () => {
    paused_upload_task()

    const resolved = await resolve_content_task({ task_id: 9, resolutions: [{ item_id: 11, choice: 'apply' }] })

    expect(resolved.task.status).toBe('queued')
    expect(resolved.task.payload).toMatchObject({ uploads: [{ path: 'ab.png' }] })
    expect(resolved.task.payload).toMatchObject({ uploads: [{ source_file_name: 'a b.png' }] })
    expect(resolved.items[0]).toMatchObject({ path: 'ab.png', status: 'pending', result: null })
    expect(state.dispatched).toEqual([9])
  })

  it('有待 resolve 的 paused 任务不能通过 resumeTask 绕过确认', async () => {
    paused_upload_task()

    await expect(resume_content_task(9)).rejects.toMatchObject({ statusCode: 409, message: '请先处理待确认的名称' })
    expect(state.transitioned).toEqual([])
  })

  it('skip 终结全部项目时直接收成 done', async () => {
    paused_upload_task()

    const resolved = await resolve_content_task({ task_id: 9, resolutions: [{ item_id: 11, choice: 'skip' }] })

    expect(resolved.task.status).toBe('done')
    expect(resolved.items[0]).toMatchObject({ status: 'skipped', result: { reason: '用户选择跳过' } })
    expect(state.dispatched).toEqual([])
    expect(state.transitioned).toEqual([])
  })

  it('apply 时目标已被占用则跳过该项，不覆盖新附件', async () => {
    paused_upload_task()
    state.scope_paths = ['ab.png']

    const resolved = await resolve_content_task({ task_id: 9, resolutions: [{ item_id: 11, choice: 'apply' }] })

    expect(resolved.items[0]).toMatchObject({ status: 'skipped', result: { reason: '目标名称已被占用，请重新操作' } })
    expect(resolved.task.status).toBe('done')
    expect(state.dispatched).toEqual([])
  })

  it('重复原始名按 entry_index 只改写被 resolve 的 payload entry', async () => {
    const current = make_task({
      kind: 'upload',
      status: 'paused',
      payload: { uploads: [{ path: 'same.png' }, { path: 'same.png' }] },
    }) as {
      task: { status: string, payload: Record<string, unknown>, scope_id: number }
      items: { id: number, path: string, action: string, status: string, bytes_done: number, bytes_total: number, staging_key: string | null, upload_id: string | null, part_size: number | null, result: Record<string, unknown> | null }[]
    }
    current.items[0]!.id = 12
    current.items[0]!.path = '__pending_upload_1'
    current.items[0]!.result = { resolve: { kind: 'rename', from: 'same.png', to: 'same-1.png', reason: '冲突', entry_index: 1 } }
    state.task = current

    const resolved = await resolve_content_task({ task_id: 9, resolutions: [{ item_id: 12, choice: 'apply' }] })

    expect(resolved.task.payload).toMatchObject({ uploads: [{ path: 'same.png' }, { path: 'same-1.png' }] })
    expect(resolved.items[0]).toMatchObject({ path: 'same-1.png', result: null })
  })

  it('replace new-name resolve 回写同目录最终路径与 payload 名称', async () => {
    const current = make_task({
      kind: 'replace',
      status: 'paused',
      payload: { old_file_name: 'dir/old.png', mode: 'new-name', file_name: 'new .PNG' },
    }) as {
      task: { status: string, payload: Record<string, unknown>, scope_id: number }
      items: { id: number, path: string, action: string, status: string, bytes_done: number, bytes_total: number, staging_key: string | null, upload_id: string | null, part_size: number | null, result: Record<string, unknown> | null }[]
    }
    current.items[0]!.action = 'replace'
    current.items[0]!.path = 'dir/old.png'
    current.items[0]!.result = { resolve: { kind: 'sanitize', from: 'new .PNG', to: 'new.png', reason: 'sanitize' } }
    state.task = current

    const resolved = await resolve_content_task({ task_id: 9, resolutions: [{ item_id: 11, choice: 'apply' }] })

    expect(resolved.task.payload).toMatchObject({ file_name: 'new.png' })
    expect(resolved.task.payload).toMatchObject({ source_file_name: 'new .PNG' })
    expect(resolved.items[0]).toMatchObject({ path: 'dir/new.png', status: 'pending' })
    expect(state.dispatched).toEqual([9])
  })
})
