import { ApiError } from '@server/errors/ApiError'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// task-api 是编排层：断言它把校验、预签、回报、完成这几步按正确的顺序和边界
// 串起来。锁、存储、任务表、执行器都在边界处 mock。
const state = vi.hoisted(() => ({
  task: null as unknown,
  signed_parts: [] as { key: string, upload_id: string, part_number: number }[],
  signed_put: [] as { key: string, content_type: string | null }[],
  finalized: [] as { item_id: number, parts: unknown[] }[],
  resumed: [] as number[],
  completed_tasks: [] as number[],
  transitioned: [] as { id: number, to: string }[],
  item_updates: [] as { item_id: number, patch: Record<string, unknown> }[],
  published: [] as string[],
  touched: [] as number[],
  kicked: 0,
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
      staging_key: 'content-upload/42/x',
      upload_id: 'up-1',
      part_size: 50,
      result: null,
    }],
  }
}

vi.mock('@server/services/content/task.service', () => ({
  get_task: vi.fn(async () => state.task),
  create_task: vi.fn(async () => state.task),
  transition_task: vi.fn(async (id: number, to: string) => {
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
  dispatch_task: vi.fn(async () => {}),
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
  task_item_paths: vi.fn(() => [{ path: 'a.png', action: 'upload', bytes_total: 100 }]),
  finalize_transfer_item: vi.fn(async (_task: unknown, item: { id: number }, parts: unknown[]) => {
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

vi.mock('@shared/config', () => ({
  runtime_config: () => ({ app: { content: { upload: { signBatchSize: 2, urlTtlSeconds: 900 } } } }),
}))

const { cancel_content_task, report_task_item, resume_content_task, resume_task_item, sign_task_parts } = await import('@server/services/content/task-api.service')

beforeEach(() => {
  state.task = make_task()
  state.signed_parts = []
  state.signed_put = []
  state.finalized = []
  state.resumed = []
  state.completed_tasks = []
  state.transitioned = []
  state.item_updates = []
  state.published = []
  state.touched = []
  state.kicked = 0
})

describe('sign_task_parts', () => {
  it('multipart 项逐分片预签，并回报片大小与 upload_id', async () => {
    const plan = await sign_task_parts({ task_id: 9, item_id: 11, part_numbers: [2, 1] })

    expect(state.signed_parts).toEqual([
      { key: 'content-upload/42/x', upload_id: 'up-1', part_number: 1 },
      { key: 'content-upload/42/x', upload_id: 'up-1', part_number: 2 },
    ])
    expect(plan.parts.map(part => part.part_number)).toEqual([1, 2])
    expect(plan).toMatchObject({ part_size: 50, upload_id: 'up-1' })
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
    // signBatchSize 为 2
    await expect(sign_task_parts({ task_id: 9, item_id: 11, part_numbers: [1, 2, 3] })).rejects.toMatchObject({ statusCode: 400 })
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
  it('取消：转 cancelled、清锁、广播', async () => {
    await cancel_content_task(9)

    expect(state.transitioned).toEqual([{ id: 9, to: 'cancelled' }])
    expect(state.published).toEqual(['content_story_tasks:42'])
  })

  it('恢复：重新排队并踢一次 runner', async () => {
    state.task = make_task({ status: 'failed' })

    await resume_content_task(9)

    expect(state.transitioned).toEqual([{ id: 9, to: 'queued' }])
    expect(state.kicked).toBe(1)
  })

  it('任务不存在时抛 404', async () => {
    state.task = null

    await expect(cancel_content_task(9)).rejects.toMatchObject({ statusCode: 404 })
    await expect(resume_content_task(9)).rejects.toMatchObject({ statusCode: 404 })
  })
})
