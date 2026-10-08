import type { ContentTaskItem, ContentTaskState } from '@shared/types/content'
import type { UploadTaskInput } from '~/utils/content/task-uploader'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, reactive, ref } from 'vue'

/**
 * The store is the only place that renders task progress, so its two contracts
 * are worth pinning:
 *
 *  - `apply_snapshot` patches a `task_progress` event into the local state
 *    without refetching (a refetch per progress tick would be absurd), but must
 *    still fetch once for a task it has never seen.
 *  - `pending_rows` is the row projection the attachment list consumes; a wrong
 *    projection shows phantom rows or hides a resumable upload.
 *
 * `upload_task_item` is mocked because it is the boundary: the parts/URL/batch
 * behaviour is covered by `task-uploader.test.ts`, and what matters here is the
 * wiring around it (which callback updates what, and when drivers are cleaned up).
 */

const STORY_ID = 24
const CLIENT_ID = 'instance-abc'

const mocks = vi.hoisted(() => ({
  api: {
    create_task: vi.fn(),
    list_scope_tasks: vi.fn(),
    sign_task_parts: vi.fn(),
    report_task_item: vi.fn(),
    resume_task_item: vi.fn(),
    cancel_task: vi.fn(),
    resume_task: vi.fn(),
  },
  upload_calls: [] as { file: File, callbacks: Record<string, (arg: never) => Promise<unknown>> }[],
  upload_gate: { resolve: null as (() => void) | null },
}))

vi.stubGlobal('ref', ref)
vi.stubGlobal('computed', computed)
vi.stubGlobal('reactive', reactive)
vi.stubGlobal('useClientInstanceId', () => CLIENT_ID)
vi.stubGlobal('useApi', () => ({ content: mocks.api }))

vi.mock('~/utils/content/upload-transport', () => ({
  create_xhr_upload_transport: () => ({ put: vi.fn() }),
}))

vi.mock('~/utils/content/task-uploader', () => ({
  upload_task_item: vi.fn(async (options: never) => {
    mocks.upload_calls.push(options as never)
  }),
}))

const { useContentTasksStore } = await import('~/stores/contentTasks')

function make_item(overrides: Partial<ContentTaskItem> = {}): ContentTaskItem {
  return {
    id: 1,
    task_id: 7,
    path: 'a.png',
    action: 'upload',
    status: 'active',
    bytes_done: 0,
    bytes_total: 100,
    staging_key: 'staging/7/1',
    upload_id: null,
    part_size: null,
    result: null,
    ... overrides,
  }
}

function make_state(items: ContentTaskItem[], overrides: Partial<ContentTaskState['task']> = {}): ContentTaskState {
  return {
    task: {
      id: 7,
      scope_id: STORY_ID,
      kind: 'upload',
      status: 'running',
      payload: {},
      actor_id: 1,
      client_id: CLIENT_ID,
      error: null,
      heartbeat_at: null,
      created_at: '2026-10-10T00:00:00.000Z',
      updated_at: '2026-10-10T00:00:00.000Z',
      ... overrides,
    },
    items,
  }
}

function make_file(size = 100) {
  return new File([new Uint8Array(size)], 'a.png', { type: 'image/png' })
}

function reset_api() {
  mocks.upload_calls.length = 0
  mocks.upload_gate.resolve = null
  for (const fn of Object.values(mocks.api))
    fn.mockReset()
}

describe('content tasks store: row projection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    reset_api()
  })

  it('隐藏已落地并带回附件的任务项', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([
      make_item({ id: 1, status: 'done', result: { attachment: { file_name: 'a.png' } } }),
      make_item({ id: 2, path: 'b.png', status: 'active' }),
    ]))

    expect(store.pending_rows.map(row => row.item_id)).toEqual([2])
  })

  it('done 但没有附件（例如被跳过）时仍然出列，并带出原因', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([
      make_item({ id: 1, status: 'failed', result: { reason: '名称非法' } }),
      make_item({ id: 2, path: 'b.png', status: 'done', result: { attachment: { file_name: 'b.png' } } }),
    ]))

    const rows = store.pending_rows
    expect(rows.map(row => row.item_id)).toEqual([1])
    expect(rows[0]?.error).toBe('名称非法')
  })

  it('保留任务级错误信息到每一行', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1, status: 'failed' })], { status: 'failed', error: '上传超时' }))

    expect(store.pending_rows[0]?.error).toBe('上传超时')
  })

  it('有 staging_key 的项标记为可续传', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([
      make_item({ id: 1, staging_key: 'staging/7/1' }),
      make_item({ id: 2, path: 'b.png', staging_key: null }),
    ]))

    expect(store.pending_rows.map(row => row.can_resume)).toEqual([true, false])
  })

  it('active_tasks 排除终态任务', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item()], { id: 7, status: 'running' }))
    store.adopt(make_state([make_item({ task_id: 8, id: 3 })], { id: 8, status: 'done' }))

    expect(store.active_tasks.map(entry => entry.task.id)).toEqual([7])
  })
})

describe('content tasks store: progress snapshots', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    reset_api()
    mocks.api.list_scope_tasks.mockResolvedValue([])
  })

  it('已知任务就地打补丁，不触发重拉', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([
      make_item({ id: 1, status: 'active' }),
      make_item({ id: 2, path: 'b.png', status: 'pending' }),
    ]))

    store.apply_snapshot({
      task_id: 7,
      scope_id: STORY_ID,
      status: 'done',
      items: [{ id: 1, status: 'done', bytes_done: 100, bytes_total: 100 }],
    })

    expect(mocks.api.list_scope_tasks).not.toHaveBeenCalled()
    expect(store.tasks[0]?.task.status).toBe('done')
    expect(store.tasks[0]?.items.map(item => item.status)).toEqual(['done', 'pending'])
    expect(store.tasks[0]?.items[0]?.bytes_done).toBe(100)
  })

  it('快照没提到的任务项保持原样', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1, path: 'a.png', bytes_done: 12 }), make_item({ id: 2, path: 'b.png', bytes_done: 34 })]))

    store.apply_snapshot({ task_id: 7, scope_id: STORY_ID, status: 'running', items: [{ id: 2, status: 'active', bytes_done: 60, bytes_total: 100 }] })

    expect(store.tasks[0]?.items[0]?.bytes_done).toBe(12)
    expect(store.tasks[0]?.items[1]?.bytes_done).toBe(60)
  })

  it('未知任务触发一次重拉，避免凭空虚构行', async () => {
    const store = useContentTasksStore(STORY_ID)
    mocks.api.list_scope_tasks.mockResolvedValue([make_state([make_item({ task_id: 9, id: 4 })], { id: 9 })])

    store.apply_snapshot({ task_id: 9, scope_id: STORY_ID, status: 'running', items: [] })

    expect(mocks.api.list_scope_tasks).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(store.tasks).toHaveLength(1))
    expect(store.tasks[0]?.task.id).toBe(9)
  })
})

describe('content tasks store: driving uploads', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    reset_api()
    mocks.api.list_scope_tasks.mockResolvedValue([])
  })

  afterEach(() => {
    mocks.upload_gate.resolve?.()
  })

  it('仅为 active 的任务项派发字节，跳过被服务端拒绝的项', async () => {
    const store = useContentTasksStore(STORY_ID)
    const created = make_state([
      make_item({ id: 1, path: 'a.png', status: 'active' }),
      make_item({ id: 2, path: 'b.png', status: 'skipped', staging_key: null }),
    ])
    mocks.api.create_task.mockResolvedValue(created)

    const files = [make_file(), make_file()]
    await store.start_uploads([
      { file: files[0]!, path: 'a.png', insert_position: 3 },
      { file: files[1]!, path: 'b.png', insert_position: null },
    ])
    await vi.waitFor(() => expect(mocks.upload_calls).toHaveLength(1))

    expect(mocks.api.create_task).toHaveBeenCalledWith(
      STORY_ID,
      'upload',
      { uploads: [
        { path: 'a.png', size: 100, mime_type: 'image/png', insert_position: 3 },
        { path: 'b.png', size: 100, mime_type: 'image/png', insert_position: null },
      ] },
      CLIENT_ID,
    )
    expect(mocks.upload_calls[0]?.file).toBe(files[0])
  })

  it('空批次不发请求', async () => {
    const store = useContentTasksStore(STORY_ID)
    expect(await store.start_uploads([])).toBeNull()
    expect(mocks.api.create_task).not.toHaveBeenCalled()
  })

  it('进度与完成回报都落到任务项状态上', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1, status: 'active' })]))
    mocks.api.report_task_item.mockImplementation(async ({ status }) => make_state([make_item({ id: 1, status: status === 'completed' ? 'done' : 'active' })]))

    await store.drive_item(1, make_file())
    const callbacks = mocks.upload_calls[0]?.callbacks as unknown as {
      report_progress: (bytes: number) => Promise<void>
      report_completed: (parts: unknown[]) => Promise<void>
    }

    await callbacks.report_progress(50)
    expect(mocks.api.report_task_item).toHaveBeenCalledWith({ task_id: 7, item_id: 1, status: 'progress', bytes_done: 50 })

    await callbacks.report_completed([{ part_number: 1, etag: 'e1', size: 100 }])
    expect(mocks.api.report_task_item).toHaveBeenCalledWith({ task_id: 7, item_id: 1, status: 'completed', parts: [{ part_number: 1, etag: 'e1', size: 100 }] })
    expect(store.tasks[0]?.items[0]?.status).toBe('done')
  })

  it('任务项不存在时明确报错，而不是静默空转', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1 })]))
    await expect(store.drive_item(99, make_file())).rejects.toThrow('任务项不存在')
  })

  it('pause_item 中止本机传输，传输期间该项标记为可续传', async () => {
    const store = useContentTasksStore(STORY_ID)
    // No staging key, so `can_resume` can only come from the local driver.
    store.adopt(make_state([make_item({ id: 1, status: 'active', staging_key: null })]))
    const captured: { signal?: AbortSignal } = {}
    const { upload_task_item } = await import('~/utils/content/task-uploader')
    vi.mocked(upload_task_item).mockImplementationOnce(async (options: UploadTaskInput) => {
      captured.signal = options.signal
      await new Promise<void>((resolve) => {
        mocks.upload_gate.resolve = resolve
      })
    })

    const driving = store.drive_item(1, make_file())
    await vi.waitFor(() => expect(store.pending_rows[0]?.can_resume).toBe(true))

    store.pause_item(1)
    expect(captured.signal?.aborted).toBe(true)

    mocks.upload_gate.resolve?.()
    await driving
  })

  it('传输失败时记录错误但不吞掉异常', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1, status: 'active' })]))
    const { upload_task_item } = await import('~/utils/content/task-uploader')
    vi.mocked(upload_task_item).mockRejectedValueOnce(new Error('网络中断'))

    await expect(store.drive_item(1, make_file())).rejects.toThrow('网络中断')
    expect(store.last_error).toBe('网络中断')
  })
})
