import type { ContentStoryAttachment, ContentTaskItem, ContentTaskState } from '@shared/types/content'
import type { UploadTaskInput } from '~/utils/content/task-uploader'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, reactive, ref } from 'vue'
import { pending_upload_status } from '~/utils/content/task-row'

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
  stored_handles: new Map<string, { file_name: string, file_size: number, handle: FileSystemFileHandle }>(),
  api: {
    preflight_task: vi.fn(),
    create_task: vi.fn(),
    list_scope_tasks: vi.fn(),
    sign_task_parts: vi.fn(),
    report_task_item: vi.fn(),
    resume_task_item: vi.fn(),
    cancel_task: vi.fn(),
    resume_task: vi.fn(),
    resolve_task: vi.fn(),
    retry_task_item: vi.fn(),
    pause_task_item: vi.fn(),
    continue_task_item: vi.fn(),
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

vi.mock('~/utils/content/upload-file-handle', async importOriginal => ({
  ... await importOriginal<typeof import('~/utils/content/upload-file-handle')>(),
  load_upload_file_handle: vi.fn(async (_db: string, key: string) => mocks.stored_handles.get(key) ?? null),
  save_upload_file_handle: vi.fn(async (_db: string, key: string, record: { file_name: string, file_size: number, handle: FileSystemFileHandle }) => { mocks.stored_handles.set(key, record) }),
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

describe('durable retry', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    reset_api()
  })
  it('resumes a failed upload with existing parts using its original item', async () => {
    const store = useContentTasksStore(STORY_ID)
    const failed = make_state([make_item({ status: 'failed' })], { status: 'failed' })
    const resumed = make_state([make_item()])
    store.adopt(failed)
    mocks.api.resume_task.mockResolvedValue(resumed)
    mocks.api.list_scope_tasks.mockResolvedValue([resumed])
    await store.retry_item(1, async () => make_file())
    await vi.waitFor(() => expect(mocks.upload_calls).toHaveLength(1))
    expect(mocks.api.retry_task_item).not.toHaveBeenCalled()
    expect(store.pending_rows.map(row => row.item_id)).toEqual([1])
  })
  it('preserves failed rows on cancel/error and persists supersession across reloads', async () => {
    const store = useContentTasksStore(STORY_ID)
    const previous = make_state([make_item({ status: 'failed', staging_key: null }), make_item({ id: 2, path: 'b.png', status: 'failed' })], { status: 'failed' })
    store.adopt(previous)
    expect(await store.retry_item(1, async () => null)).toBeNull()
    expect(mocks.api.retry_task_item).not.toHaveBeenCalled()
    mocks.api.retry_task_item.mockRejectedValueOnce(new Error('creation failed'))
    await expect(store.retry_item(1, async () => make_file())).rejects.toThrow('creation failed')
    expect(store.pending_rows.map(row => row.item_id)).toEqual([1, 2])
    const superseded = make_state([{ ... previous.items[0]!, superseded_at: '2026-10-13T00:00:00Z' }, previous.items[1]!], { status: 'failed' })
    const current = make_state([make_item({ id: 3, task_id: 8, status: 'pending', retry_of_item_id: 1 })], { id: 8, status: 'paused' })
    mocks.api.retry_task_item.mockResolvedValue({ previous: superseded, current })
    expect(await store.retry_item(1, async () => make_file())).toMatchObject(current)
    expect(mocks.api.retry_task_item).toHaveBeenLastCalledWith(7, 1, 'a.png', 100, CLIENT_ID)
    expect(store.local_item(3)?.file.name).toBe('a.png')
    expect(store.pending_rows.map(row => row.item_id)).toEqual([2, 3])
    store.apply_list([previous, current])
    store.apply_snapshot({ task_id: 7, scope_id: STORY_ID, status: 'failed', items: [{ id: 1, path: 'a.png', status: 'failed', bytes_done: 0, bytes_total: 100, resolution: null, reason: null, superseded_at: null }] })
    expect(store.pending_rows.map(row => row.item_id)).toEqual([2, 3])
    setActivePinia(createPinia())
    const reloaded = useContentTasksStore(STORY_ID)
    reloaded.apply_list([superseded, current])
    expect(reloaded.pending_rows.map(row => row.item_id)).toEqual([2, 3])
    expect(mocks.api.cancel_task).not.toHaveBeenCalled()
  })
})

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
  mocks.stored_handles.clear()
  mocks.upload_calls.length = 0
  mocks.upload_gate.resolve = null
  for (const fn of Object.values(mocks.api))
    fn.mockReset()
  mocks.api.list_scope_tasks.mockResolvedValue([])
  mocks.api.pause_task_item.mockResolvedValue(make_state([make_item({ paused_at: '2026-10-13T06:00:00Z', control_version: 1 })], { status: 'paused' }))
  mocks.api.continue_task_item.mockResolvedValue(make_state([make_item({ control_version: 2 })]))
  mocks.api.preflight_task.mockImplementation(async (_story_id: number, _kind: string, payload: { uploads?: { path: string }[] }) => ({
    items: (payload.uploads ?? []).map(entry => ({ path: entry.path, action: 'upload', ok: true, reason: null, suggested_name: null, resolution: null })),
    locks: [],
  }))
}

describe('content tasks store: row projection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    reset_api()
  })

  it('cancelled 父任务的 active item 在重载和迟到快照后均不显示', () => {
    const store = useContentTasksStore(STORY_ID)
    const cancelled = make_state([make_item({ bytes_done: 43 })], { status: 'cancelled' })
    store.apply_list([cancelled])
    expect(store.pending_rows).toEqual([])
    store.apply_snapshot({ task_id: 7, scope_id: STORY_ID, status: 'running', items: [{ id: 1, path: 'a.png', status: 'active', bytes_done: 43, bytes_total: 100, resolution: null, reason: null }] })
    expect(store.pending_rows).toEqual([])
    setActivePinia(createPinia())
    const fresh = useContentTasksStore(STORY_ID)
    fresh.apply_list([cancelled])
    expect(fresh.pending_rows).toEqual([])
  })

  it('服务端暂停跨刷新显示，旧控制版本不能撤销暂停或覆盖继续', async () => {
    const store = useContentTasksStore(STORY_ID)
    const paused = make_state([make_item({ bytes_done: 43, paused_at: '2026-10-13T06:00:00Z', control_version: 1 })], { status: 'paused' })
    store.apply_list([paused])
    expect(pending_upload_status(store.pending_rows[0]!)).toBe('paused')
    store.apply_snapshot({ task_id: 7, scope_id: STORY_ID, status: 'running', items: [{ id: 1, path: 'a.png', status: 'active', bytes_done: 43, bytes_total: 100, resolution: null, reason: null, paused_at: null, control_version: 0 }] })
    expect(pending_upload_status(store.pending_rows[0]!)).toBe('paused')
    const resumed = make_state([make_item({ bytes_done: 43, control_version: 2, paused_at: null })])
    mocks.api.continue_task_item.mockResolvedValue(resumed)
    mocks.api.list_scope_tasks.mockResolvedValue([resumed])
    await store.resume_item(1, { file: make_file(), insert_position: null })
    expect(mocks.api.continue_task_item).toHaveBeenCalledWith(7, 1)
    store.apply_list([paused])
    expect(store.tasks[0]?.items[0]?.paused_at).toBeNull()
    expect(store.tasks[0]?.items[0]?.control_version).toBe(2)
    expect(store.pending_rows.map(row => row.item_id)).toEqual([1])
  })

  it('跳过项只留在报告中，快照、列表同步和全新页面均不恢复附件行或允许重试', async () => {
    const skipped = make_item({ status: 'skipped', result: { reason: '用户选择跳过' } })
    const state = make_state([skipped, make_item({ id: 2, path: 'b.png', status: 'failed' })])
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item(), state.items[1]!]))
    store.apply_snapshot({ task_id: 7, scope_id: STORY_ID, status: 'running', items: [{ id: 1, path: 'a.png', status: 'skipped', bytes_done: 0, bytes_total: 100, resolution: null, reason: '用户选择跳过' }] })
    expect(store.pending_rows.map(row => row.item_id)).toEqual([2])
    store.apply_list([state])
    expect(store.pending_rows.map(row => row.item_id)).toEqual([2])
    expect(store.tasks[0]?.items[0]).toEqual({ ... skipped, superseded_at: null })
    const pick = vi.fn(async () => make_file())
    const start = vi.fn(async () => true)
    expect(await store.retry_item(1, pick, start)).toBeNull()
    expect(pick).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    setActivePinia(createPinia())
    const reloaded = useContentTasksStore(STORY_ID)
    reloaded.apply_list([state])
    expect(reloaded.pending_rows.map(row => row.item_id)).toEqual([2])
  })

  it('resolve 改名的快照保留实际源文件名，列表重载后仍可跨设备选回源文件', () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ path: '__pending_upload_0', status: 'pending', result: { resolve: { kind: 'sanitize', from: 'a b.png', to: 'ab.png', reason: '和谐', entry_index: 0 } } })], {
      status: 'paused', payload: { uploads: [{ path: 'a b.png', source_file_name: 'local source.PNG', size: 100, mime_type: 'image/png' }] },
    }))
    store.apply_snapshot({ task_id: 7, scope_id: STORY_ID, status: 'running', items: [{ id: 1, path: 'ab.png', status: 'active', bytes_done: 50, bytes_total: 100, resolution: null, reason: null }] })
    expect(store.pending_rows[0]).toMatchObject({ path: 'ab.png', source_file_name: 'local source.PNG' })

    store.apply_list([make_state([make_item({ path: 'ab.png' })], { payload: { uploads: [{ path: 'ab.png', source_file_name: 'local source.PNG', size: 100, mime_type: 'image/png' }] } })])
    expect(store.pending_rows[0]?.source_file_name).toBe('local source.PNG')
  })

  it('隐藏已落地并带回附件的任务项', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([
      make_item({ id: 1, status: 'done', result: { attachment: { file_name: 'a.png' } } }),
      make_item({ id: 2, path: 'b.png', status: 'active' }),
    ]))

    expect(store.pending_rows.map(row => row.item_id)).toEqual([2])
  })

  it('服务端执行的任务项（加密）带上 kind 与非传输标记，done 项一律出列', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([
      make_item({ id: 1, action: 'encrypt', status: 'pending', staging_key: null }),
      make_item({ id: 2, path: 'b.png', action: 'encrypt', status: 'done', result: { new_path: 'b.png.good' } }),
    ], { kind: 'encrypt', payload: { file_names: ['a.png', 'b.png'] } }))

    const rows = store.pending_rows
    expect(rows.map(row => row.item_id)).toEqual([1])
    expect(rows[0]).toMatchObject({ kind: 'encrypt', action: 'encrypt', is_transfer: false })
  })

  it('paused resolve 提供项投影到跨端待处理行', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([
      make_item({
        id: 1,
        path: 'a b.png',
        status: 'pending',
        staging_key: null,
        result: { resolve: { kind: 'sanitize', from: 'a b.png', to: 'ab.png', reason: '需要和谐' } },
      }),
    ], { status: 'paused' }))

    expect(store.pending_rows[0]).toMatchObject({
      path: 'a b.png',
      resolution: { kind: 'sanitize', from: 'a b.png', to: 'ab.png' },
    })
  })

  it('失败项保留错误原因，已完成项退出列表', async () => {
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
      items: [{ id: 1, path: 'a.png', status: 'done', bytes_done: 100, bytes_total: 100, resolution: null, reason: null }],
    })

    expect(mocks.api.list_scope_tasks).not.toHaveBeenCalled()
    expect(store.tasks[0]?.task.status).toBe('done')
    expect(store.tasks[0]?.items.map(item => item.status)).toEqual(['done', 'pending'])
    expect(store.tasks[0]?.items[0]?.bytes_done).toBe(100)
  })

  it('快照没提到的任务项保持原样', async () => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ id: 1, path: 'a.png', bytes_done: 12 }), make_item({ id: 2, path: 'b.png', bytes_done: 34 })]))

    store.apply_snapshot({ task_id: 7, scope_id: STORY_ID, status: 'running', items: [{ id: 2, path: 'b.png', status: 'active', bytes_done: 60, bytes_total: 100, resolution: null, reason: null }] })

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

  it('源句柄按 item 身份保存，resolve 改名后仍能恢复源文件', async () => {
    const store = useContentTasksStore(STORY_ID)
    const file = make_file(100, 'a b.png')
    const handle = { getFile: async () => file } as FileSystemFileHandle
    const paused = make_state([make_item({ id: 12, path: '__pending_upload_0', status: 'pending' })], { status: 'paused' })
    mocks.api.create_task.mockResolvedValue(paused)
    await store.start_uploads([{ file, file_name: 'a b.png', handle }])
    expect(store.local_item(12)?.handle).toBe(handle)
    expect(mocks.stored_handles.get(`${STORY_ID}:item:12`)).toEqual({ file_name: 'a b.png', file_size: 100, handle })
    mocks.api.resolve_task.mockResolvedValue(make_state([make_item({ id: 12, path: 'ab-1.png', status: 'active' })]))
    await store.resolve_task(7, [{ item_id: 12, choice: 'apply' }])
    expect(mocks.stored_handles.get(`${STORY_ID}:item:12`)?.handle).toBe(handle)
  })

  it('建一个持久批任务，只为服务端留下的 active 项派发字节', async () => {
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

    expect(mocks.api.preflight_task).not.toHaveBeenCalled()
    expect(mocks.api.create_task).toHaveBeenCalledWith(STORY_ID, 'upload', { uploads: [
      { path: 'a.png', source_file_name: 'a.png', size: 100, mime_type: 'image/png', insert_position: 3 },
      { path: 'b.png', source_file_name: 'b.png', size: 100, mime_type: 'image/png', insert_position: null },
    ] }, CLIENT_ID)
    expect(result.task).toBe(created)
    expect(result.rejected).toEqual([{ path: 'b.png', reason: '无法上传' }])
    expect(mocks.upload_calls[0]?.file).toBe(files[0])
  })

  it('存在 resolve 提供项时保留原名并创建 paused 任务，不提前传字节', async () => {
    const store = useContentTasksStore(STORY_ID)
    mocks.api.preflight_task.mockResolvedValue({
      items: [{
        path: 'a b.png',
        action: 'upload',
        ok: true,
        reason: null,
        resolution: { kind: 'sanitize', from: 'a b.png', to: 'ab.png', reason: '文件名将被和谐' },
      }],
      locks: [],
    })
    const paused = make_state([make_item({ id: 5, path: 'a b.png', status: 'pending', staging_key: null, result: { resolve: { kind: 'sanitize', from: 'a b.png', to: 'ab.png', reason: '文件名将被和谐' } } })], { status: 'paused' })
    mocks.api.create_task.mockResolvedValue(paused)

    const result = await store.start_uploads([{ file: make_file(), file_name: 'a b.png', insert_position: null }])

    expect(result.rejected).toEqual([])
    expect(mocks.api.create_task).toHaveBeenCalledWith(STORY_ID, 'upload', { uploads: [
      { path: 'a b.png', source_file_name: 'a.png', size: 100, mime_type: 'image/png', insert_position: null },
    ] }, CLIENT_ID)
    expect(result.task).toBe(paused)
    expect(mocks.upload_calls).toHaveLength(0)
    expect(store.pending_rows[0]?.resolution?.to).toBe('ab.png')
  })

  it('完全重复的文件名也保留为两条独立待处理行和两个本地源文件', async () => {
    const store = useContentTasksStore(STORY_ID)
    const first_file = make_file(100, 'same.png')
    const second_file = make_file(200, 'same.png')
    const paused = make_state([
      make_item({ id: 21, path: 'same.png', status: 'pending', staging_key: null }),
      make_item({ id: 22, path: '__pending_upload_1', status: 'pending', staging_key: null, result: { resolve: { kind: 'rename', from: 'same.png', to: 'same-suffixed.png', reason: '冲突', entry_index: 1 } } }),
    ], { status: 'paused', payload: { uploads: [{ path: 'same.png', size: 100, mime_type: 'image/png' }, { path: 'same.png', size: 200, mime_type: 'image/png' }] } })
    mocks.api.create_task.mockResolvedValue(paused)

    const result = await store.start_uploads([
      { file: first_file, file_name: 'same.png', insert_position: null },
      { file: second_file, file_name: 'same.png', insert_position: null },
    ])

    expect(result.task?.items).toHaveLength(2)
    expect(store.local_item(21)?.file).toBe(first_file)
    expect(store.local_item(22)?.file).toBe(second_file)
    expect(store.pending_rows.map(row => row.path)).toEqual(['same.png', 'same.png'])
  })

  it('硬拒绝项也落入持久任务的 skipped 状态', async () => {
    const store = useContentTasksStore(STORY_ID)
    const created = make_state([make_item({ id: 4, path: 'bad.png', status: 'skipped', staging_key: null, result: { reason: '文件名不合法' } })], { status: 'done' })
    mocks.api.create_task.mockResolvedValue(created)

    const result = await store.start_uploads([{ file: make_file(0, 'bad.png'), file_name: 'bad.png', insert_position: null }])

    expect(result).toEqual({ task: created, rejected: [{ path: 'bad.png', reason: '文件名不合法' }] })
    expect(mocks.api.create_task).toHaveBeenCalled()
  })

  it('部分 skipped 时照常上传通过的条目', async () => {
    const store = useContentTasksStore(STORY_ID)
    mocks.api.create_task.mockResolvedValue(make_state([
      make_item({ id: 5, path: 'bad.png', status: 'skipped', staging_key: null, result: { reason: '文件为空' } }),
      make_item({ id: 6, path: 'ok.png', status: 'active' }),
    ]))

    const result = await store.start_uploads([
      { file: make_file(0, 'bad.png'), file_name: 'bad.png', insert_position: null },
      { file: make_file(10, 'ok.png'), file_name: 'ok.png', insert_position: null },
    ])

    expect(result.rejected).toEqual([{ path: 'bad.png', reason: '文件为空' }])
    expect(mocks.api.create_task).toHaveBeenCalledWith(STORY_ID, 'upload', { uploads: [
      { path: 'bad.png', source_file_name: 'bad.png', size: 0, mime_type: 'image/png', insert_position: null },
      { path: 'ok.png', source_file_name: 'ok.png', size: 10, mime_type: 'image/png', insert_position: null },
    ] }, CLIENT_ID)
    await vi.waitFor(() => expect(mocks.upload_calls).toHaveLength(1))
  })

  it('空批次不发任何请求', async () => {
    const store = useContentTasksStore(STORY_ID)
    expect(await store.start_uploads([])).toEqual({ task: null, rejected: [] })
    expect(mocks.api.preflight_task).not.toHaveBeenCalled()
    expect(mocks.api.create_task).not.toHaveBeenCalled()
  })

  it.each([false, true])('resolve 跳过项退出列表且不新增任务，全部跳过=%s', async (all_skipped) => {
    const store = useContentTasksStore(STORY_ID)
    store.adopt(make_state([make_item({ status: 'pending' }), make_item({ id: 2, path: 'b.png', status: 'pending' })], { status: 'paused' }))
    const resolved = make_state([
      make_item({ status: 'skipped', result: { reason: '用户选择跳过' } }),
      make_item({ id: 2, path: 'b.png', status: all_skipped ? 'skipped' : 'active' }),
    ], { status: all_skipped ? 'done' : 'running' })
    mocks.api.resolve_task.mockResolvedValue(resolved)
    await store.resolve_task(7, [{ item_id: 1, choice: 'skip' }, { item_id: 2, choice: all_skipped ? 'skip' : 'apply' }])
    store.apply_list([resolved])
    expect(store.pending_rows.map(row => row.item_id)).toEqual(all_skipped ? [] : [2])
    expect(store.tasks[0]?.items.map(item => item.id)).toEqual([1, 2])
    expect(mocks.api.create_task).not.toHaveBeenCalled()
  })

  it('resolve 后复用本地文件驱动 active item', async () => {
    const store = useContentTasksStore(STORY_ID)
    const file = make_file(100, 'a b.png')
    const paused = make_state([make_item({ id: 12, path: 'a b.png', status: 'pending', staging_key: null, result: { resolve: { kind: 'sanitize', from: 'a b.png', to: 'ab.png', reason: '需要和谐' } } })], { status: 'paused' })
    mocks.api.preflight_task.mockResolvedValue({ items: [{ path: 'a b.png', action: 'upload', ok: true, reason: null, resolution: { kind: 'sanitize', from: 'a b.png', to: 'ab.png', reason: '需要和谐' } }], locks: [] })
    mocks.api.create_task.mockResolvedValue(paused)
    await store.start_uploads([{ file, file_name: 'a b.png', insert_position: null }])
    mocks.api.resolve_task.mockResolvedValue(make_state([make_item({ id: 12, task_id: 7, path: 'ab.png', status: 'active' })], { status: 'running' }))

    await store.resolve_task(7, [{ item_id: 12, choice: 'apply' }])

    expect(mocks.api.resolve_task).toHaveBeenCalledWith(7, [{ item_id: 12, choice: 'apply' }])
    await vi.waitFor(() => expect(mocks.upload_calls).toHaveLength(1))
    expect(mocks.upload_calls[0]?.file).toBe(file)
    expect(mocks.api.create_task).toHaveBeenCalledTimes(1)
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

    await store.pause_item(1)
    expect(captured.signal?.aborted).toBe(true)
    expect(store.pending_rows[0]).toMatchObject({ is_driving: false, is_paused: true })

    mocks.upload_gate.resolve?.()
    await driving
    store.apply_snapshot({ task_id: 7, scope_id: STORY_ID, status: 'running', items: [{ id: 1, path: 'a.png', status: 'active', bytes_done: 43, bytes_total: 100, resolution: null, reason: null }] })
    expect(pending_upload_status(store.pending_rows[0]!)).toBe('paused')
    expect(mocks.upload_calls).toHaveLength(1)
    expect(store.local_item(1)?.file).toBeInstanceOf(File)
    for (let attempt = 0; attempt < 2; attempt ++) {
      await store.resume_item(1, store.local_item(1)!)
      await store.pause_item(1)
      expect(store.pending_rows.map(row => row.item_id)).toEqual([1])
    }
    expect(mocks.api.create_task).not.toHaveBeenCalled()
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

  it('创建 replace 任务并推送 active 文件', async () => {
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
      source_file_name: 'a.png',
      content_type: 'image/png',
    }, CLIENT_ID)
  })

  it('替换新名保留原始名，交由服务端生成 sanitize resolve', async () => {
    const store = useContentTasksStore(STORY_ID)
    mocks.api.preflight_task.mockResolvedValue({ items: [{
      path: 'a.png',
      action: 'replace',
      ok: true,
      reason: null,
      resolution: { kind: 'sanitize', from: '我的 照片.JPEG', to: '我的照片.jpeg', reason: '和谐' },
    }], locks: [] })
    mocks.api.create_task.mockResolvedValue(make_state([make_item({ id: 3, path: 'a.png', action: 'replace', status: 'pending', staging_key: null, result: { resolve: { kind: 'sanitize', from: '我的 照片.JPEG', to: '我的照片.jpeg', reason: '和谐' } } })], { status: 'paused' }))

    const result = await store.start_replace({ file: make_file(20, '我的 照片.JPEG'), old_file_name: 'a.png', mode: 'new-name' })

    expect(mocks.api.create_task).toHaveBeenCalledWith(STORY_ID, 'replace', expect.objectContaining({
      file_name: '我的 照片.JPEG',
    }), CLIENT_ID)
    expect(result.task?.task.status).toBe('paused')
    expect(mocks.upload_calls).toHaveLength(0)
  })

  it('服务端 hard refusal 持久为 skipped 任务项', async () => {
    const store = useContentTasksStore(STORY_ID)
    const skipped = make_state([make_item({ id: 3, path: 'a.png', action: 'replace', status: 'skipped', staging_key: null, result: { reason: '已加密' } })], { status: 'done' })
    mocks.api.create_task.mockResolvedValue(skipped)

    const result = await store.start_replace({ file: make_file(), old_file_name: 'a.png', mode: 'keep-name' })

    expect(result).toEqual({ task: skipped, rejected: [{ path: 'a.png', reason: '已加密' }] })
    expect(mocks.api.create_task).toHaveBeenCalled()
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
