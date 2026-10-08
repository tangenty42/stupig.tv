import { ApiError } from '@server/errors/ApiError'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 执行器的语义在"payload → 锁路径/任务项"的纯映射与"结果 → 任务项状态"的
// 回填上；DB 效果由 attachment-structure / story 的既有测试覆盖，这里 mock 掉。
const state = vi.hoisted(() => ({
  applied_moves: null as unknown,
  applied_rename: null as unknown,
  applied_folder: [] as string[],
  update_story: null as unknown,
  item_updates: [] as { task_id: number, item_id: number, patch: Record<string, unknown> }[],
  move_result: { succeeded: [] as { old_file_name: string, new_file_name: string }[], skipped: [] as { file_name: string, reason: string }[] },
  update_story_result: { succeeded: [] as string[], skipped: [] as { file_name: string, reason: string }[] },
  folder_delete_error: null as Error | null,
  // preflight 边界
  scope_files: [] as string[],
  scope_folders: [] as string[],
  scope_paths: [] as string[],
  story_markdown: '',
  scope_locks: [] as { path: string, kind: string, task_id: number | null, expires_at: string }[],
  name_error: null as Error | null,
}))

vi.mock('@server/services/content/attachment-structure.service', () => ({
  apply_attachment_moves: vi.fn(async (_scope: number, moves: unknown) => {
    state.applied_moves = moves
    return { attachments: [], ... state.move_result }
  }),
  apply_attachment_rename: vi.fn(async (_scope: number, old_name: string, new_name: string) => {
    state.applied_rename = [old_name, new_name]
    return { file_name: 'renamed.png' }
  }),
  apply_folder_create: vi.fn(async (_scope: number, folder: string) => {
    state.applied_folder.push(folder)
  }),
  apply_folder_delete: vi.fn(async (_scope: number, folder: string) => {
    if (state.folder_delete_error)
      throw state.folder_delete_error
    state.applied_folder.push(folder)
  }),
  apply_folder_rename: vi.fn(async () => {}),
  resolve_attachment_name: vi.fn((name: string) => {
    if (state.name_error)
      throw state.name_error
    return name
  }),
  resolve_renamed_attachment_name: vi.fn((_old_name: string, new_name: string) => {
    if (state.name_error)
      throw state.name_error
    return new_name
  }),
}))

vi.mock('@server/services/content-attachments.service', () => ({
  list_scope_attachments: vi.fn(async () => state.scope_files.map(file_name => ({ file_name }))),
  list_scope_folders: vi.fn(async () => state.scope_folders),
  list_scope_paths: vi.fn(async () => state.scope_paths),
}))

vi.mock('@server/lib/operation-lock', () => ({
  list_scope_locks: vi.fn(async () => state.scope_locks),
}))

vi.mock('@server/services/content/story.service', () => ({
  get_story: vi.fn(async () => ({ markdown: state.story_markdown })),
  update_story: vi.fn(async (_scope: number, markdown: string, delete_files: string[], base_revision: number) => {
    state.update_story = { markdown, delete_files, base_revision }
    return state.update_story_result
  }),
}))

vi.mock('@server/services/content/task.service', () => ({
  update_task_item: vi.fn(async (task_id: number, item_id: number, patch: Record<string, unknown>) => {
    state.item_updates.push({ task_id, item_id, patch })
  }),
}))

const { task_lock_paths, task_item_paths, execute_task, preflight_task } = await import('@server/services/content/task-operations.service')

function make_task(kind: string, payload: Record<string, unknown>) {
  return {
    id: 1,
    scope_id: 42,
    kind,
    status: 'running',
    payload,
    actor_id: null,
    client_id: null,
    error: null,
    heartbeat_at: null,
    created_at: '',
    updated_at: '',
  } as never
}

function make_item(id: number, path: string, action: string) {
  return {
    id,
    task_id: 1,
    path,
    action,
    status: 'pending',
    bytes_done: 0,
    bytes_total: 0,
    staging_key: null,
    upload_id: null,
    part_size: null,
    result: null,
  } as never
}

beforeEach(() => {
  state.applied_moves = null
  state.applied_rename = null
  state.applied_folder = []
  state.update_story = null
  state.item_updates = []
  state.move_result = { succeeded: [], skipped: [] }
  state.update_story_result = { succeeded: [], skipped: [] }
  state.folder_delete_error = null
  state.scope_files = []
  state.scope_folders = []
  state.scope_paths = []
  state.story_markdown = ''
  state.scope_locks = []
  state.name_error = null
})

describe('task_lock_paths', () => {
  it('move：锁源路径与目标路径（同路径移动只锁源）', () => {
    const paths = task_lock_paths('move', { moves: [
      { file_name: 'a.png', target_folder: 'dir' },
      { file_name: 'b.png', target_folder: null },
      { file_name: 'c.png', target_folder: 'dir' },
    ] })
    expect(paths.sort()).toEqual(['a.png', 'b.png', 'c.png', 'dir/a.png', 'dir/c.png'])
  })

  it('rename / folder_rename：锁源与目标', () => {
    expect(task_lock_paths('rename', { old_file_name: 'a.png', new_file_name: 'b.png' }).sort()).toEqual(['a.png', 'b.png'])
    expect(task_lock_paths('folder_rename', { source_folder: 'a', new_folder: 'b' }).sort()).toEqual(['a', 'b'])
  })

  it('delete：锁全部文件与文件夹', () => {
    expect(task_lock_paths('delete', { file_names: ['a.png'], folders: ['dir'], markdown: '', base_revision: 1, can_private: true }).sort()).toEqual(['a.png', 'dir'])
  })

  it('folder_create / folder_delete：只锁目标路径', () => {
    expect(task_lock_paths('folder_create', { folder: 'a/b' })).toEqual(['a/b'])
    expect(task_lock_paths('folder_delete', { folder: 'a/b' })).toEqual(['a/b'])
  })

  it('传输/加密类尚未实现：抛 400', () => {
    expect(() => task_lock_paths('upload', {})).toThrow('不支持的任务类型')
    expect(() => task_lock_paths('encrypt', {})).toThrow('不支持的任务类型')
  })
})

describe('task_item_paths', () => {
  it('move：任务项来自源路径去重', () => {
    const items = task_item_paths('move', { moves: [
      { file_name: 'a.png', target_folder: 'dir' },
      { file_name: 'a.png', target_folder: null },
      { file_name: 'b.png', target_folder: 'dir' },
    ] })
    expect(items).toEqual([{ path: 'a.png', action: 'move' }, { path: 'b.png', action: 'move' }])
  })

  it('delete：文件项与文件夹项分开', () => {
    const items = task_item_paths('delete', { file_names: ['a.png'], folders: ['dir'], markdown: '', base_revision: 1, can_private: true })
    expect(items).toEqual([{ path: 'a.png', action: 'delete' }, { path: 'dir', action: 'folder_delete' }])
  })
})

describe('execute_task', () => {
  it('move：succeeded 标 done 并带新路径，skipped 带原因，同路径为 no-op done', async () => {
    state.move_result = {
      succeeded: [{ old_file_name: 'a.png', new_file_name: 'dir/a.png' }],
      skipped: [{ file_name: 'b.png', reason: '操作时发生文件名冲突' }],
    }
    const task = make_task('move', { moves: [
      { file_name: 'a.png', target_folder: 'dir' },
      { file_name: 'b.png', target_folder: 'dir' },
      { file_name: 'c.png', target_folder: null },
    ] })
    const items = [make_item(11, 'a.png', 'move'), make_item(12, 'b.png', 'move'), make_item(13, 'c.png', 'move')]

    await execute_task(task, items)

    expect(state.item_updates).toEqual([
      { task_id: 1, item_id: 11, patch: { status: 'done', result: { new_path: 'dir/a.png' } } },
      { task_id: 1, item_id: 12, patch: { status: 'skipped', result: { reason: '操作时发生文件名冲突' } } },
      { task_id: 1, item_id: 13, patch: { status: 'done', result: { new_path: 'c.png' } } },
    ])
  })

  it('rename：应用并回填新路径', async () => {
    const task = make_task('rename', { old_file_name: 'a.png', new_file_name: 'renamed.png' })
    await execute_task(task, [make_item(11, 'a.png', 'rename')])

    expect(state.applied_rename).toEqual(['a.png', 'renamed.png'])
    expect(state.item_updates[0]?.patch).toEqual({ status: 'done', result: { new_path: 'renamed.png' } })
  })

  it('delete：文件走 revision 校验的保存，文件夹逐项隔离失败', async () => {
    state.update_story_result = {
      succeeded: ['a.png'],
      skipped: [{ file_name: 'b.png', reason: '已被正文引用' }],
    }
    state.folder_delete_error = Object.assign(new Error('文件夹内仍有附件，无法删除'), { statusCode: 409 })
    const task = make_task('delete', { file_names: ['a.png', 'b.png'], folders: ['dir'], markdown: '# doc', base_revision: 7, can_private: true })
    const items = [make_item(11, 'a.png', 'delete'), make_item(12, 'b.png', 'delete'), make_item(13, 'dir', 'folder_delete')]

    await execute_task(task, items)

    expect(state.update_story).toEqual({ markdown: '# doc', delete_files: ['a.png', 'b.png'], base_revision: 7 })
    expect(state.item_updates.map(update => update.patch.status)).toEqual(['done', 'skipped', 'failed'])
  })

  it('folder_create：应用并标 done', async () => {
    const task = make_task('folder_create', { folder: 'a/b' })
    await execute_task(task, [make_item(11, 'a/b', 'folder_create')])

    expect(state.applied_folder).toEqual(['a/b'])
    expect(state.item_updates[0]?.patch.status).toBe('done')
  })
})

describe('preflight_task', () => {
  it('move：源缺失与目标冲突给出原因，正常项通过', async () => {
    state.scope_files = ['a.png', 'dir/taken.png']
    state.scope_paths = ['a.png', 'dir/taken.png', 'taken.png']
    state.scope_locks = [{ path: 'x.png', kind: 'move', task_id: 9, expires_at: '' }]

    const result = await preflight_task(42, 'move', { moves: [
      { file_name: 'a.png', target_folder: null },
      { file_name: 'ghost.png', target_folder: null },
      { file_name: 'dir/taken.png', target_folder: null },
    ] })

    // a.png 移到根是 no-op（原地）；ghost.png 不存在；dir/taken.png 移到根撞上已有同名文件
    expect(result.items.map(item => [item.ok, item.reason])).toEqual([
      [true, null],
      [false, '附件不存在或已被删除'],
      [false, '操作时发生文件名冲突'],
    ])
    expect(result.locks).toHaveLength(1)
  })

  it('rename：名称规则违反来自共享守卫的消息', async () => {
    state.scope_files = ['a.png']
    state.scope_paths = ['a.png']
    state.name_error = new ApiError(400, '文件名不能以 .good 结尾')

    const result = await preflight_task(42, 'rename', { old_file_name: 'a.png', new_file_name: 'a.png.good' })

    expect(result.items[0]?.ok).toBe(false)
    expect(result.items[0]?.reason).toContain('.good')
  })

  it('delete：被正文引用的文件与非空文件夹被拦截', async () => {
    state.scope_files = ['a.png', 'dir/b.png']
    state.scope_paths = ['a.png', 'dir/b.png', 'dir']
    state.scope_folders = ['dir']
    state.story_markdown = '![](a.png)'

    const result = await preflight_task(42, 'delete', { file_names: ['a.png'], folders: ['dir'], markdown: '', base_revision: 1, can_private: true })

    expect(result.items.map(item => [item.ok, item.reason])).toEqual([
      [false, '已被正文引用'],
      [false, '文件夹内仍有附件，无法删除'],
    ])
  })

  it('folder_create：路径已被占用时报告冲突', async () => {
    state.scope_paths = ['cards']
    state.name_error = new ApiError(409, '操作时发生文件名冲突')

    const result = await preflight_task(42, 'folder_create', { folder: 'cards' })

    expect(result.items[0]?.ok).toBe(false)
    expect(result.items[0]?.reason).toContain('冲突')
  })

  it('folder_rename：移动到自身内部被拦截', async () => {
    state.scope_folders = ['a']
    state.scope_paths = ['a']

    const result = await preflight_task(42, 'folder_rename', { source_folder: 'a', new_folder: 'a/b' })

    expect(result.items[0]?.ok).toBe(false)
    expect(result.items[0]?.reason).toContain('自身内部')
  })
})
