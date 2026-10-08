import type { ContentStoryAttachment, ContentTaskItem, ContentTaskState } from '@shared/types/content'
import type { UploadTaskInput } from '~/utils/content/task-uploader'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, reactive, ref } from 'vue'

/**
 * The store owns two contracts worth pinning:
 *
 *  - `apply_snapshot` patches a `task_progress` event into the local state
 *    without refetching (a refetch per progress tick would be absurd), but must
 *    still fetch once for a task it has never seen.
 *  - `pending_rows` is the row projection the attachment list consumes, and the
 *    start/resume/cancel paths are what decide whether an upload is reachable,
 *    resumable, or stuck holding the scope's locks.
 *
 * `upload_task_item` is mocked because it is the boundary: the parts/URL/batch
 * behaviour is covered by `task-uploader.test.ts`, and what matters here is the
 * wiring around it (which callback updates what, and when drivers are cleaned up).
 */

const STORY_ID = 24
const CLIENT_ID = 'instance-abc'

const mocks = vi.hoisted(() => ({
  api: {
    preflight_task: vi.fn(),
    create_task: vi.fn(),
    list_scope_tasks: vi.fn(),
    sign_task_parts: vi.fn(),
    report_task_item: vi.fn(),
    resume_task_item: vi.fn(),
    cancel_task: vi.fn(),
    resume_task: vi.fn(),
  },
  upload_calls: [] as UploadTaskInput[],
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
  upload_task_item: vi.fn(async (options: UploadTaskInput) => {
    mocks.upload_calls.push(options)
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

function make_file(size = 100, name = 'a.png') {
  return new File([new Uint8Array(size)], name, { type: 'image/png' })
}

/**
 * Holds the mocked transfer open and hands back its callbacks, so a test can
 * drive progress and completion the way the real uploader does.
 */
async function start_gated_upload() {
  const captured: { callbacks?: UploadTaskInput['callbacks'], signal?: AbortSignal } = {}
  const { upload_task_item } = await import('~/utils/content/task-uploader')
  vi.mocked(upload_task_item).mockImplementationOnce(async (options: UploadTaskInput) => {
    captured.callbacks = options.callbacks
    captured.signal = options.signal
    mocks.upload_calls.push(options)
    await new Promise<void>((resolve) => {
      mocks.upload_gate.resolve = resolve
    })
  })
  return captured
}

function reset_api() {
  mocks.upload_calls.length = 0
  mocks.upload_gate.resolve = null
  for (const fn of Object.values(mocks.api))
    fn.mockReset()
  mocks.api.list_scope_tasks.mockResolvedValue([])
  mocks.api.preflight_task.mockImplementation(async (_story_id: number, _kind: string, payload: { uploads?: { path: string }[] }) => ({
    items: (payload.uploads ?? []).map(entry => ({ path: entry.path, action: 'upload', ok: true, reason: null, suggested_name: null })),
    locks: [],
  }))
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

  it('从任务 payload 取回每项的 mime 类型', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1, path: 'a.png' })], { payload: { uploads: [{ path: 'a.png', size: 100, mime_type: 'image/gif' }] } }))

    expect(store.pending_rows[0]?.mime_type).toBe('image/gif')
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

describe('content tasks store: starting uploads', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    reset_api()
  })

  it('先预检再建任务，只为服务端留下的 active 项派发字节', async () => {
    const store = useContentTasksStore(STORY_ID)
    const created = make_state([
      make_item({ id: 1, path: 'a.png', status: 'active' }),
      make_item({ id: 2, path: 'b.png', status: 'skipped', staging_key: null }),
    ])
    mocks.api.create_task.mockResolvedValue(created)

    const files = [make_file(100, 'a.png'), make_file(100, 'b.png')]
    const result = await store.start_uploads([
      { file: files[0]!, file_name: 'a.png', insert_position: 3 },
      { file: files[1]!, file_name: 'b.png', insert_position: null },
    ])
    await vi.waitFor(() => expect(mocks.upload_calls).toHaveLength(1))

    expect(mocks.api.preflight_task).toHaveBeenCalledWith(STORY_ID, 'upload', { uploads: [
      { path: 'a.png', size: 100, mime_type: 'image/png', insert_position: 3 },
      { path: 'b.png', size: 100, mime_type: 'image/png', insert_position: null },
    ] })
    expect(mocks.api.create_task).toHaveBeenCalledWith(STORY_ID, 'upload', { uploads: [
      { path: 'a.png', size: 100, mime_type: 'image/png', insert_position: 3 },
      { path: 'b.png', size: 100, mime_type: 'image/png', insert_position: null },
    ] }, CLIENT_ID)
    expect(result.task).toBe(created)
    expect(mocks.upload_calls[0]?.file).toBe(files[0])
  })

  it('采用预检给的建议名，重名的文件不等于失败', async () => {
    const store = useContentTasksStore(STORY_ID)
    mocks.api.preflight_task.mockResolvedValue({
      items: [{ path: 'a.png', action: 'upload', ok: true, reason: null, suggested_name: 'a-1.png' }],
      locks: [],
    })
    mocks.api.create_task.mockResolvedValue(make_state([make_item({ id: 5, path: 'a-1.png' })]))

    const result = await store.start_uploads([{ file: make_file(), file_name: 'a.png', insert_position: null }])

    expect(result.rejected).toEqual([])
    expect(mocks.api.create_task).toHaveBeenCalledWith(STORY_ID, 'upload', { uploads: [
      { path: 'a-1.png', size: 100, mime_type: 'image/png', insert_position: null },
    ] }, CLIENT_ID)
    await vi.waitFor(() => expect(mocks.upload_calls).toHaveLength(1))
  })

  it('预检拒绝的条目不建任务，并原样回报原因', async () => {
    const store = useContentTasksStore(STORY_ID)
    mocks.api.preflight_task.mockResolvedValue({
      items: [{ path: 'bad.png', action: 'upload', ok: false, reason: '文件名不合法' }],
      locks: [],
    })

    const result = await store.start_uploads([{ file: make_file(0, 'bad.png'), file_name: 'bad.png', insert_position: null }])

    expect(result).toEqual({ task: null, rejected: [{ path: 'bad.png', reason: '文件名不合法' }] })
    expect(mocks.api.create_task).not.toHaveBeenCalled()
  })

  it('部分被拒时仍然上传通过的条目', async () => {
    const store = useContentTasksStore(STORY_ID)
    mocks.api.preflight_task.mockResolvedValue({
      items: [
        { path: 'bad.png', action: 'upload', ok: false, reason: '文件为空' },
        { path: 'ok.png', action: 'upload', ok: true, reason: null, suggested_name: null },
      ],
      locks: [],
    })
    mocks.api.create_task.mockResolvedValue(make_state([make_item({ id: 6, path: 'ok.png' })]))

    const result = await store.start_uploads([
      { file: make_file(0, 'bad.png'), file_name: 'bad.png', insert_position: null },
      { file: make_file(10, 'ok.png'), file_name: 'ok.png', insert_position: null },
    ])

    expect(result.rejected).toEqual([{ path: 'bad.png', reason: '文件为空' }])
    expect(mocks.api.create_task).toHaveBeenCalledWith(STORY_ID, 'upload', { uploads: [
      { path: 'ok.png', size: 10, mime_type: 'image/png', insert_position: null },
    ] }, CLIENT_ID)
    await vi.waitFor(() => expect(mocks.upload_calls).toHaveLength(1))
  })

  it('空批次不发任何请求', async () => {
    const store = useContentTasksStore(STORY_ID)
    expect(await store.start_uploads([])).toEqual({ task: null, rejected: [] })
    expect(mocks.api.preflight_task).not.toHaveBeenCalled()
    expect(mocks.api.create_task).not.toHaveBeenCalled()
  })
})

describe('content tasks store: driving uploads', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    reset_api()
  })

  afterEach(() => {
    mocks.upload_gate.resolve?.()
  })

  it('进度与完成回报都落到任务项状态上，落地项回调拿到附件', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1, status: 'active' })]))
    const attachment: ContentStoryAttachment = { file_name: 'a.png' } as ContentStoryAttachment
    mocks.api.report_task_item.mockImplementation(async ({ status }: { status: string }) => make_state([
      make_item({ id: 1, status: status === 'completed' ? 'done' : 'active', result: status === 'completed' ? { attachment } : null }),
    ]))
    const landed = vi.fn()
    const captured = await start_gated_upload()

    const driving = store.drive_item(1, { file: make_file(), insert_position: 3, on_landed: landed })
    await vi.waitFor(() => expect(captured.callbacks).toBeDefined())

    await captured.callbacks!.report_progress(50)
    expect(mocks.api.report_task_item).toHaveBeenCalledWith({ task_id: 7, item_id: 1, status: 'progress', bytes_done: 50 })

    await captured.callbacks!.report_completed([{ part_number: 1, etag: 'e1', size: 100 }])
    expect(mocks.api.report_task_item).toHaveBeenCalledWith({ task_id: 7, item_id: 1, status: 'completed', parts: [{ part_number: 1, etag: 'e1', size: 100 }] })
    expect(landed).toHaveBeenCalledWith(attachment)
    // The bytes are the server's now: nothing left to retry from here.
    expect(store.local_item(1)).toBeNull()

    mocks.upload_gate.resolve?.()
    await driving
  })

  it('任务项不存在时明确报错，而不是静默空转', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1 })]))
    await expect(store.drive_item(99, { file: make_file(), insert_position: null })).rejects.toThrow('任务项不存在')
  })

  it('pause_item 中止本机传输，持有的文件让该项仍可续传', async () => {
    const store = useContentTasksStore(STORY_ID)
    // No staging key, so `can_resume` can only come from the bytes held here,
    // and the server still lists the item (a paused transfer stays active).
    store.adopt(make_state([make_item({ id: 1, status: 'active', staging_key: null })]))
    mocks.api.list_scope_tasks.mockResolvedValue([make_state([make_item({ id: 1, status: 'active', staging_key: null })])])
    const captured = await start_gated_upload()

    const driving = store.drive_item(1, { file: make_file(), insert_position: null })
    await vi.waitFor(() => expect(store.pending_rows[0]?.can_resume).toBe(true))

    store.pause_item(1)
    expect(captured.signal?.aborted).toBe(true)

    mocks.upload_gate.resolve?.()
    await driving
    expect(store.local_item(1)?.file).toBeInstanceOf(File)
  })

  it('传输失败时记录错误、保留文件，但不吞掉异常', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1, status: 'active' })]))
    mocks.api.list_scope_tasks.mockResolvedValue([make_state([make_item({ id: 1, status: 'active' })])])
    const { upload_task_item } = await import('~/utils/content/task-uploader')
    vi.mocked(upload_task_item).mockRejectedValueOnce(new Error('网络中断'))

    await expect(store.drive_item(1, { file: make_file(), insert_position: null })).rejects.toThrow('网络中断')
    expect(store.last_error).toBe('网络中断')
    expect(store.local_item(1)).not.toBeNull()
  })

  it('resume_item 重新排队已失败的任务，然后继续推送字节', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1, status: 'active' })], { status: 'failed', error: '任务中断，请重试' }))
    mocks.api.resume_task.mockResolvedValue(make_state([make_item({ id: 1, status: 'active' })]))

    await store.resume_item(1, { file: make_file(), insert_position: null })

    expect(mocks.api.resume_task).toHaveBeenCalledWith(7)
    expect(mocks.upload_calls).toHaveLength(1)
  })

  it('还在运行的任务不会被重新排队', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1, status: 'active' })]))

    await store.resume_item(1, { file: make_file(), insert_position: null })

    expect(mocks.api.resume_task).not.toHaveBeenCalled()
    expect(mocks.upload_calls).toHaveLength(1)
  })
})

describe('content tasks store: removing and cancelling', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    reset_api()
  })

  it('取消任务后本机不再显示该行', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1, status: 'active' })]))
    mocks.api.cancel_task.mockResolvedValue(make_state([make_item({ id: 1, status: 'failed' })], { status: 'cancelled' }))

    await store.cancel(7)

    expect(mocks.api.cancel_task).toHaveBeenCalledWith(7)
    expect(store.tasks).toEqual([])
    expect(store.pending_rows).toEqual([])
  })

  it('移除已完成的任务不打扰服务端：暂存已经落地，没有东西要释放', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1, status: 'failed' })], { status: 'done' }))

    await store.remove(7)

    expect(mocks.api.cancel_task).not.toHaveBeenCalled()
    expect(store.tasks).toEqual([])
  })

  it('移除失败的任务走取消：服务端要靠它丢掉暂存的分片', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1, status: 'failed' })], { status: 'failed' }))
    mocks.api.cancel_task.mockResolvedValue(make_state([make_item({ id: 1, status: 'failed' })], { status: 'cancelled' }))

    await store.remove(7)

    expect(mocks.api.cancel_task).toHaveBeenCalledWith(7)
    expect(store.tasks).toEqual([])
  })

  it('移除后的行不会被下一次 load 带回来', async () => {
    const store = useContentTasksStore(STORY_ID)
    const task = make_state([make_item({ id: 1, status: 'failed' })], { status: 'failed' })
    store.adopt(task)
    // 服务端在整个保留期内照旧列出这行（终态行是审计/续传窗口）。
    mocks.api.list_scope_tasks.mockResolvedValue([task])
    mocks.api.cancel_task.mockResolvedValue({ ... task, task: { ... task.task, status: 'cancelled' } })

    await store.remove(7)
    await store.load()

    expect(store.tasks).toEqual([])
    expect(store.pending_rows).toEqual([])
  })

  it('移除仍在运行的任务会先取消它，才放开路径锁', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1, status: 'active' })]))
    mocks.api.cancel_task.mockResolvedValue(make_state([make_item({ id: 1, status: 'active' })], { status: 'cancelled' }))

    await store.remove(7)

    expect(mocks.api.cancel_task).toHaveBeenCalledWith(7)
    expect(store.tasks).toEqual([])
  })

  it('load 丢掉服务端已经不再列出的任务项本地字节', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1, status: 'active' })]))
    store.drive_item(1, { file: make_file(), insert_position: null }).catch(() => {})
    await vi.waitFor(() => expect(store.local_item(1)).not.toBeNull())

    await store.load()

    expect(store.local_item(1)).toBeNull()
  })
})

describe('content tasks store: replacing', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    reset_api()
  })

  it('预检通过后建 replace 任务并推送新文件', async () => {
    const store = useContentTasksStore(STORY_ID)
    mocks.api.preflight_task.mockResolvedValue({ items: [{ path: 'a.png', action: 'replace', ok: true, reason: null }], locks: [] })
    mocks.api.create_task.mockResolvedValue(make_state([make_item({ id: 3, path: 'a.png', action: 'replace', status: 'active' })]))

    const result = await store.start_replace({ file: make_file(20, 'a.png'), old_file_name: 'a.png', mode: 'keep-name' })
    await vi.waitFor(() => expect(mocks.upload_calls).toHaveLength(1))

    expect(result.rejected).toEqual([])
    expect(mocks.api.create_task).toHaveBeenCalledWith(STORY_ID, 'replace', {
      old_file_name: 'a.png',
      mode: 'keep-name',
      size: 20,
      mime_type: 'image/png',
      file_name: 'a.png',
      content_type: 'image/png',
    }, CLIENT_ID)
  })

  it('预检不通过时根本不建任务', async () => {
    const store = useContentTasksStore(STORY_ID)
    mocks.api.preflight_task.mockResolvedValue({ items: [{ path: 'a.png', action: 'replace', ok: false, reason: '已加密' }], locks: [] })

    const result = await store.start_replace({ file: make_file(), old_file_name: 'a.png', mode: 'keep-name' })

    expect(result).toEqual({ task: null, rejected: [{ path: 'a.png', reason: '已加密' }] })
    expect(mocks.api.create_task).not.toHaveBeenCalled()
  })

  it('服务端在准备阶段就落地过替换项时，直接回调而不重复推送', async () => {
    const store = useContentTasksStore(STORY_ID)
    const attachment: ContentStoryAttachment = { file_name: 'a.png' } as ContentStoryAttachment
    mocks.api.preflight_task.mockResolvedValue({ items: [{ path: 'a.png', action: 'replace', ok: true, reason: null }], locks: [] })
    mocks.api.create_task.mockResolvedValue(make_state([make_item({ id: 3, path: 'a.png', action: 'replace', status: 'done', result: { attachment } })]))
    const landed = vi.fn()

    await store.start_replace({ file: make_file(), old_file_name: 'a.png', mode: 'keep-name', on_landed: landed })

    expect(landed).toHaveBeenCalledWith(attachment)
    expect(mocks.upload_calls).toHaveLength(0)
  })
})
