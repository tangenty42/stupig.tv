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
  /** 行级数据（加解密/redact 的判定需要 file_size 与 encryption_key） */
  scope_file_rows: [] as Record<string, unknown>[],
  /** attachment_object_key_in_use 回答为 true 的 key 集合 */
  keys_in_use: [] as string[],
  story_markdown: '',
  scope_locks: [] as { path: string, kind: string, task_id: number | null, expires_at: string }[],
  name_error: null as Error | null,
  inserted_rows: [] as Record<string, unknown>[],
  materialized: [] as string[],
  multipart_created: [] as string[],
  completed: [] as { key: string, upload_id: string, parts: unknown[] }[],
  aborted: [] as { key: string, upload_id: string }[],
  abort_error: null as Error | null,
  deleted_objects: [] as string[],
  uploaded_parts: [] as { part_number: number, etag: string, size: number }[],
  replaced: null as { old_name: string, key: string } | null,
  redacted: null as { source: string, key: string } | null,
  changed: [] as number[],
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
  publish_attachment_change: vi.fn(async () => {
    state.changed.push(... [])
  }),
  resolve_attachment_name: vi.fn((name: string, existing: Iterable<string> = []) => {
    if (state.name_error)
      throw state.name_error
    // 模拟真实的后缀策略：合法名直接返回，被占用的加后缀
    if (! [... existing].includes(name))
      return name
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    return `${stem}-suffixed${ext}`
  }),
  resolve_renamed_attachment_name: vi.fn((_old_name: string, new_name: string) => {
    if (state.name_error)
      throw state.name_error
    return new_name
  }),
  rewrite_story_attachment_refs: vi.fn(async () => {}),
}))

vi.mock('@server/services/content/encryption.service', () => ({
  transform_attachment_encryption_bytes: vi.fn((kind: string, data: Uint8Array) => ({
    data,
    encryption_key: kind === 'encrypt' ? 'new-key' : null,
  })),
}))

vi.mock('@server/lib/db', () => ({
  db: {
    execute: vi.fn(async () => [[]]),
    getConnection: vi.fn(async () => ({
      execute: vi.fn(async () => [[]]),
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
    })),
  },
}))

vi.mock('@server/services/content-attachments.service', () => ({
  list_scope_attachments: vi.fn(async () => state.scope_files.map(file_name => ({ file_name }))),
  list_scope_file_rows: vi.fn(async (_scope: number, names: string[]) => state.scope_file_rows.filter(row => names.includes(row.file_name as string))),
  attachment_object_key_in_use: vi.fn(async (key: string) => state.keys_in_use.includes(key)),
  list_scope_folders: vi.fn(async () => state.scope_folders),
  list_scope_paths: vi.fn(async () => state.scope_paths),
  insert_attachment_row: vi.fn(async (row: Record<string, unknown>) => {
    state.inserted_rows.push(row)
  }),
  get_scope_attachment: vi.fn(async (_scope: number, file_name: string) => state.inserted_rows.find(row => row.file_name === file_name) ?? null),
}))

vi.mock('@server/services/content/upload.service', () => ({
  apply_attachment_replace: vi.fn(async (_scope: number, old_name: string, key: string) => {
    state.replaced = { old_name, key }
    return { file_name: old_name }
  }),
  apply_abridged_attachment: vi.fn(async (_scope: number, source: string, key: string) => {
    state.redacted = { source, key }
    return { file_name: source }
  }),
  materialize_attachment_folders: vi.fn(async (_scope: number, file_name: string) => {
    state.materialized.push(file_name)
  }),
}))

vi.mock('@server/lib/storage', () => ({
  create_multipart_upload: vi.fn(async (key: string) => {
    state.multipart_created.push(key)
    return `upload-${state.multipart_created.length}`
  }),
  complete_multipart_upload: vi.fn(async (key: string, upload_id: string, parts: unknown[]) => {
    state.completed.push({ key, upload_id, parts })
    return 'completed-etag'
  }),
  abort_multipart_upload: vi.fn(async (key: string, upload_id: string) => {
    state.aborted.push({ key, upload_id })
    if (state.abort_error)
      throw state.abort_error
  }),
  list_parts: vi.fn(async () => state.uploaded_parts),
  head_object: vi.fn(async () => ({ size: 123, content_type: 'image/png', etag: 'staged-etag' })),
  copy_object: vi.fn(async () => 'copied-etag'),
  get_object: vi.fn(async () => new Uint8Array([1, 2, 3])),
  put_object: vi.fn(async () => 'put-etag'),
  delete_object_best_effort: vi.fn(async (key: string) => {
    state.deleted_objects.push(key)
  }),
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

const { task_lock_paths, task_item_paths, discard_task_staging, execute_task, preflight_task, upload_part_size, finalize_transfer_item, transfer_item_resume_state } = await import('@server/services/content/task-operations.service')

const ITEM_ID = 11

function make_transfer_item(path: string, action: string, overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
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
    ... overrides,
  } as never
}

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
  state.scope_file_rows = []
  state.keys_in_use = []
  state.story_markdown = ''
  state.scope_locks = []
  state.name_error = null
  state.inserted_rows = []
  state.materialized = []
  state.multipart_created = []
  state.completed = []
  state.aborted = []
  state.abort_error = null
  state.deleted_objects = []
  state.uploaded_parts = []
  state.replaced = null
  state.redacted = null
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

  it('传输类与加密类都锁源与目标名（加解密语义同改名）', () => {
    expect(task_lock_paths('upload', { uploads: [{ path: 'a.png', size: 1, mime_type: null }] })).toEqual(['a.png'])
    expect(task_lock_paths('encrypt', { file_names: ['a.png', 'dir/b.png'] }).sort()).toEqual(['a.png', 'a.png.good', 'dir/b.png', 'dir/b.png.good'])
    expect(task_lock_paths('decrypt', { file_names: ['a.png.good'] }).sort()).toEqual(['a.png', 'a.png.good'])
    expect(task_lock_paths('redact', { source_file_name: 'a.png.good', content_type: 'image/png', size: 10 }).sort()).toEqual(['a.png', 'a.png.good'])
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

  it('encrypt/decrypt：每文件一项；redact：单一项带字节总量', () => {
    expect(task_item_paths('encrypt', { file_names: ['a.png', 'b.png', 'a.png'] }))
      .toEqual([{ path: 'a.png', action: 'encrypt' }, { path: 'b.png', action: 'encrypt' }])
    expect(task_item_paths('decrypt', { file_names: ['a.png.good'] }))
      .toEqual([{ path: 'a.png.good', action: 'decrypt' }])
    expect(task_item_paths('redact', { source_file_name: 'a.png.good', content_type: 'image/png', size: 42 }))
      .toEqual([{ path: 'a.png.good', action: 'redact', bytes_total: 42 }])
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

describe('upload_part_size', () => {
  it('小文件返回 null（单次 PUT），超过片大小的返回片大小', () => {
    const part = 8 * 1024 * 1024
    expect(upload_part_size(1)).toBeNull()
    expect(upload_part_size(part)).toBeNull()
    expect(upload_part_size(part + 1)).toBe(part)
    expect(upload_part_size(part * 3)).toBe(part)
  })
})

describe('传输类任务的锁路径与任务项', () => {
  it('upload：锁计划落点；replace：keep-name 只锁原路径，new-name 锁两者', () => {
    expect(task_lock_paths('upload', { uploads: [{ path: 'a.png', size: 1, mime_type: null }] })).toEqual(['a.png'])
    expect(task_lock_paths('replace', { old_file_name: 'a.png', mode: 'keep-name', file_name: 'b.png', size: 1, mime_type: null, content_type: null })).toEqual(['a.png'])
    expect(task_lock_paths('replace', { old_file_name: 'a.png', mode: 'new-name', file_name: 'b.png', size: 1, mime_type: null, content_type: null }).sort()).toEqual(['a.png', 'b.png'])
  })

  it('upload 的任务项带 bytes_total，replace 是单一项', () => {
    expect(task_item_paths('upload', { uploads: [{ path: 'a.png', size: 9, mime_type: null }] }))
      .toEqual([{ path: 'a.png', action: 'upload', bytes_total: 9 }])
    expect(task_item_paths('replace', { old_file_name: 'a.png', mode: 'keep-name', file_name: 'b.png', size: 7, mime_type: null, content_type: null }))
      .toEqual([{ path: 'a.png', action: 'replace', bytes_total: 7 }])
  })
})

describe('execute_task：上传准备', () => {
  const upload_task = (uploads: unknown[]) => make_task('upload', { uploads })

  it('小文件只分配暂存 key（无 multipart），大文件建 multipart', async () => {
    const part = 8 * 1024 * 1024
    const task = upload_task([
      { path: 'small.png', size: 1024, mime_type: 'image/png' },
      { path: 'big.bin', size: part * 2, mime_type: null },
    ])
    const items = [make_transfer_item('small.png', 'upload'), make_transfer_item('big.bin', 'upload')]

    const outcome = await execute_task(task, items)

    // 传输类任务不在这里收尾：字节还没到
    expect(outcome.complete).toBe(false)
    expect(state.multipart_created).toHaveLength(1)
    const updates = state.item_updates.map(update => update.patch)
    expect(updates[0]).toMatchObject({ status: 'active', upload_id: null, part_size: null })
    expect(String(updates[0]?.staging_key)).toMatch(/^content-upload\/42\//)
    expect(updates[1]).toMatchObject({ status: 'active', upload_id: 'upload-1', part_size: part })
  })

  it('恢复时不重新分配暂存 key（保住客户端的分片锚）', async () => {
    const task = upload_task([{ path: 'a.png', size: 1024, mime_type: null }])
    const items = [make_transfer_item('a.png', 'upload', { staging_key: 'content-upload/42/existing', status: 'active' })]

    await execute_task(task, items)

    expect(state.multipart_created).toEqual([])
    expect(state.item_updates[0]?.patch).toEqual({ status: 'active' })
  })

  it('非法文件名在准备阶段被跳过，不分配暂存', async () => {
    state.name_error = new ApiError(400, '文件名包含不支持的字符')
    const task = upload_task([{ path: 'a.png', size: 1024, mime_type: null }])

    const outcome = await execute_task(task, [make_transfer_item('a.png', 'upload')])

    expect(outcome.complete).toBe(false)
    expect(state.multipart_created).toEqual([])
    expect(state.item_updates[0]?.patch).toMatchObject({ status: 'skipped' })
  })
})

describe('execute_task：替换准备', () => {
  it('已加密的目标被跳过（替换会留下明文配密钥的坏行）', async () => {
    state.scope_files = ['a.png']
    const task = make_task('replace', { old_file_name: 'a.png', mode: 'keep-name', file_name: 'a.png', size: 10, mime_type: null, content_type: null })
    // 列表里带 is_encrypted 才触发跳过
    const attachments = await import('@server/services/content-attachments.service')
    vi.mocked(attachments.list_scope_attachments).mockResolvedValueOnce([{ file_name: 'a.png', is_encrypted: true }] as never)

    const outcome = await execute_task(task, [make_transfer_item('a.png', 'replace')])

    expect(outcome.complete).toBe(true)
    expect(state.item_updates[0]?.patch).toMatchObject({ status: 'skipped' })
    expect(state.multipart_created).toEqual([])
  })
})

describe('finalize_transfer_item', () => {
  it('upload：完成 multipart → 拷贝到终态对象 → 落行 → 物化文件夹', async () => {
    const task = make_task('upload', { uploads: [{ path: 'cards/a.png', size: 10, mime_type: 'image/png' }] })
    const item = make_transfer_item('cards/a.png', 'upload', { staging_key: 'content-upload/42/x', upload_id: 'up-1' })

    const row = await finalize_transfer_item(task, item, [{ part_number: 1, etag: 'e1', size: 10 }])

    expect(state.completed).toEqual([{ key: 'content-upload/42/x', upload_id: 'up-1', parts: [{ part_number: 1, etag: 'e1', size: 10 }] }])
    expect(state.inserted_rows[0]).toMatchObject({ story_id: 42, file_name: 'cards/a.png', file_size: 123 })
    expect(state.materialized).toEqual(['cards/a.png'])
    expect(row.file_name).toBe('cards/a.png')
  })

  it('upload：单次 PUT 不走 CompleteMultipartUpload', async () => {
    const task = make_task('upload', { uploads: [{ path: 'a.png', size: 10, mime_type: null }] })
    const item = make_transfer_item('a.png', 'upload', { staging_key: 'content-upload/42/x' })

    await finalize_transfer_item(task, item, [])

    expect(state.completed).toEqual([])
    expect(state.inserted_rows[0]?.file_name).toBe('a.png')
  })

  it('upload：落点被占时按后缀改名，而不是让上传失败', async () => {
    state.scope_paths = ['a.png']
    const task = make_task('upload', { uploads: [{ path: 'a.png', size: 10, mime_type: null }] })
    const item = make_transfer_item('a.png', 'upload', { staging_key: 'content-upload/42/x' })

    const row = await finalize_transfer_item(task, item, [])

    expect(row.file_name).not.toBe('a.png')
    expect(String(row.file_name)).toMatch(/^a-.+\.png$/)
  })

  it('replace：交给替换内核，不自己落行', async () => {
    const task = make_task('replace', { old_file_name: 'a.png', mode: 'keep-name', file_name: 'a.png', size: 10, mime_type: null, content_type: 'image/png' })
    const item = make_transfer_item('a.png', 'replace', { staging_key: 'content-upload/42/x' })

    await finalize_transfer_item(task, item, [])

    expect(state.replaced).toEqual({ old_name: 'a.png', key: 'content-upload/42/x' })
    expect(state.inserted_rows).toEqual([])
  })

  it('缺暂存对象时抛 409', async () => {
    const task = make_task('upload', { uploads: [{ path: 'a.png', size: 10, mime_type: null }] })
    const item = make_transfer_item('a.png', 'upload')

    await expect(finalize_transfer_item(task, item, [])).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('transfer_item_resume_state', () => {
  it('multipart 项回报已上传分片；单次 PUT 项不回传分片', async () => {
    state.uploaded_parts = [{ part_number: 1, etag: 'e1', size: 100 }]

    const multipart = await transfer_item_resume_state(make_transfer_item('a.png', 'upload', { staging_key: 'k', upload_id: 'up-1', part_size: 100 }))
    expect(multipart).toEqual({ staging_key: 'k', upload_id: 'up-1', part_size: 100, uploaded_parts: state.uploaded_parts, sign_batch_size: 20 })

    const single = await transfer_item_resume_state(make_transfer_item('b.png', 'upload', { staging_key: 'k2' }))
    expect(single.uploaded_parts).toEqual([])
    // 单次 PUT 也有上限，客户端的预签批处理不必先试探。
    expect(single.sign_batch_size).toBe(20)
  })

  it('未开始的任务项抛 409', async () => {
    await expect(transfer_item_resume_state(make_transfer_item('a.png', 'upload'))).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('preflight：上传与替换', () => {
  it('upload：重名不算失败，给出建议名；非法名才是失败', async () => {
    state.scope_paths = ['taken.png']

    const result = await preflight_task(42, 'upload', { uploads: [
      { path: 'fresh.png', size: 10, mime_type: null },
      { path: 'taken.png', size: 10, mime_type: null },
    ] })

    expect(result.items[0]).toMatchObject({ ok: true, suggested_name: null })
    expect(result.items[1]?.ok).toBe(true)
    expect(result.items[1]?.suggested_name).toMatch(/^taken-.+\.png$/)
  })

  it('upload：同批两个同名文件，第二个拿到建议名', async () => {
    const result = await preflight_task(42, 'upload', { uploads: [
      { path: 'a.png', size: 10, mime_type: null },
      { path: 'a.png', size: 10, mime_type: null },
    ] })

    expect(result.items[1]?.suggested_name).toMatch(/^a-.+\.png$/)
  })

  it('upload：空文件被拒绝', async () => {
    const result = await preflight_task(42, 'upload', { uploads: [{ path: 'a.png', size: 0, mime_type: null }] })

    expect(result.items[0]).toMatchObject({ ok: false, reason: '文件为空' })
  })

  it('replace：目标缺失或已加密被拒绝', async () => {
    state.scope_files = ['a.png']
    state.scope_paths = ['a.png']

    const missing = await preflight_task(42, 'replace', { old_file_name: 'ghost.png', mode: 'keep-name', file_name: 'ghost.png', size: 10, mime_type: null, content_type: null })
    expect(missing.items[0]).toMatchObject({ ok: false, reason: '附件不存在或已被删除' })

    const attachments = await import('@server/services/content-attachments.service')
    vi.mocked(attachments.list_scope_attachments).mockResolvedValueOnce([{ file_name: 'a.png', is_encrypted: true }] as never)
    const encrypted = await preflight_task(42, 'replace', { old_file_name: 'a.png', mode: 'keep-name', file_name: 'a.png', size: 10, mime_type: null, content_type: null })
    expect(encrypted.items[0]).toMatchObject({ ok: false, reason: '已加密' })
  })
})

describe('discard_task_staging', () => {
  it('multipart 项：先 abort 上传会话，再删暂存对象', async () => {
    await discard_task_staging([
      make_transfer_item('a.png', 'upload', { staging_key: 'content-upload/42/x', upload_id: 'up-1' }),
    ])

    expect(state.aborted).toEqual([{ key: 'content-upload/42/x', upload_id: 'up-1' }])
    expect(state.deleted_objects).toEqual(['content-upload/42/x'])
  })

  it('单次 PUT 项没有上传会话可 abort，只删对象', async () => {
    await discard_task_staging([
      make_transfer_item('a.png', 'upload', { staging_key: 'content-upload/42/y' }),
    ])

    expect(state.aborted).toEqual([])
    expect(state.deleted_objects).toEqual(['content-upload/42/y'])
  })

  it('还没拿到暂存 key 的任务项无事可做', async () => {
    await discard_task_staging([
      make_transfer_item('a.png', 'upload'),
      make_transfer_item('b.png', 'upload', { staging_key: null }),
    ])

    expect(state.aborted).toEqual([])
    expect(state.deleted_objects).toEqual([])
  })

  it('abort 失败不阻断对象删除（例如客户端已经把 multipart 完成了）', async () => {
    state.abort_error = Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload' })

    await expect(discard_task_staging([
      make_transfer_item('a.png', 'upload', { staging_key: 'content-upload/42/z', upload_id: 'up-2' }),
    ])).resolves.toBeUndefined()

    expect(state.deleted_objects).toEqual(['content-upload/42/z'])
  })

  it('任务自产对象（加密中断的孤儿）：未被引用则删除，已落行则保留', async () => {
    state.keys_in_use = ['content/att/live']

    await discard_task_staging([
      make_transfer_item('a.png', 'encrypt', { result: { staged_object_key: 'content/att/orphan' } }),
      make_transfer_item('b.png', 'encrypt', { result: { staged_object_key: 'content/att/live' } }),
    ])

    expect(state.deleted_objects).toEqual(['content/att/orphan'])
  })
})

function file_row(file_name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    story_id: 42,
    is_folder: 0,
    file_name,
    object_key: `content/att/${file_name}`,
    mime_type: 'image/png',
    file_size: 10,
    version: 'v1',
    encryption_key: null,
    ... overrides,
  }
}

describe('preflight：加密与解密', () => {
  it('逐项判定：不存在 / 已加密 / 超限 / 目标冲突 / 正常', async () => {
    state.scope_file_rows = [
      file_row('a.png'),
      file_row('b.png.good', { encryption_key: 'key' }),
      file_row('big.png', { file_size: 21 * 1024 * 1024 }),
      file_row('taken.png'),
    ]
    // taken.png.good 已被别人占着（哪怕是个文件夹）。
    state.scope_paths = ['a.png', 'b.png.good', 'big.png', 'taken.png', 'taken.png.good']

    const result = await preflight_task(42, 'encrypt', { file_names: ['a.png', 'ghost.png', 'b.png.good', 'big.png', 'taken.png'] })

    expect(result.items.map(item => [item.path, item.ok, item.reason])).toEqual([
      ['a.png', true, null],
      ['ghost.png', false, '附件不存在或已被删除'],
      ['b.png.good', false, '已加密'],
      ['big.png', false, '文件太大'],
      ['taken.png', false, '操作时发生文件名冲突'],
    ])
  })

  it('解密：未加密与缺密钥的各自原因；批内按序让位', async () => {
    state.scope_file_rows = [
      file_row('a.png.good', { encryption_key: 'key' }),
      file_row('b.png'),
      file_row('c.png.good', { encryption_key: null }),
    ]
    state.scope_paths = ['a.png.good', 'b.png', 'c.png.good']

    const result = await preflight_task(42, 'decrypt', { file_names: ['a.png.good', 'b.png', 'c.png.good'] })

    expect(result.items.map(item => [item.path, item.ok, item.reason])).toEqual([
      ['a.png.good', true, null],
      ['b.png', false, '未加密'],
      ['c.png.good', false, '附件缺少密钥，无法解密'],
    ])
  })

  it('解密落点被已有明文占用时报告冲突（删减版双胞胎占名）', async () => {
    state.scope_file_rows = [file_row('a.png.good', { encryption_key: 'key' })]
    state.scope_paths = ['a.png.good', 'a.png']

    const result = await preflight_task(42, 'decrypt', { file_names: ['a.png.good'] })

    expect(result.items[0]).toMatchObject({ ok: false, reason: '操作时发生文件名冲突' })
  })
})

describe('preflight：删减版', () => {
  const redact_payload = { source_file_name: 'a.png.good', content_type: 'image/png', size: 100 }

  it('源已加密且双胞胎名空闲时通过', async () => {
    state.scope_file_rows = [file_row('a.png.good', { encryption_key: 'key' })]
    state.scope_paths = ['a.png.good']

    const result = await preflight_task(42, 'redact', redact_payload)

    expect(result.items).toEqual([{ path: 'a.png.good', action: 'redact', bytes_total: 100, ok: true, reason: null }])
  })

  it('逐项拒绝：未加密 / 格式不支持 / 声明类型不符 / 双胞胎名被占 / 源不存在', async () => {
    state.scope_file_rows = [file_row('b.png'), file_row('c.gif.good', { encryption_key: 'key', mime_type: 'image/gif' }), file_row('d.png.good', { encryption_key: 'key' }), file_row('e.png.good', { encryption_key: 'key' })]
    state.scope_paths = ['b.png', 'c.gif.good', 'd.png.good', 'd.png', 'e.png.good']

    const unencrypted = await preflight_task(42, 'redact', { ... redact_payload, source_file_name: 'b.png' })
    expect(unencrypted.items[0]).toMatchObject({ ok: false, reason: '只有已加密的图片才能创建删减版' })

    const bad_format = await preflight_task(42, 'redact', { ... redact_payload, source_file_name: 'c.gif.good', content_type: null })
    expect(bad_format.items[0]).toMatchObject({ ok: false, reason: '该图片格式不支持创建删减版' })

    const type_mismatch = await preflight_task(42, 'redact', { ... redact_payload, source_file_name: 'd.png.good', content_type: 'image/jpeg' })
    expect(type_mismatch.items[0]).toMatchObject({ ok: false, reason: '删减版内容与文件格式不符' })

    const taken = await preflight_task(42, 'redact', { ... redact_payload, source_file_name: 'd.png.good' })
    expect(taken.items[0]).toMatchObject({ ok: false, reason: '操作时发生文件名冲突' })

    const missing = await preflight_task(42, 'redact', { ... redact_payload, source_file_name: 'ghost.png.good' })
    expect(missing.items[0]).toMatchObject({ ok: false, reason: '附件不存在或已被删除' })
  })
})

describe('execute_task：删减版准备', () => {
  const redact_task = () => make_task('redact', { source_file_name: 'a.png.good', content_type: 'image/png', size: 100 })

  it('校验通过后分配暂存并等待客户端灌字节', async () => {
    state.scope_file_rows = [file_row('a.png.good', { encryption_key: 'key' })]
    state.scope_paths = ['a.png.good']

    const outcome = await execute_task(redact_task(), [make_transfer_item('a.png.good', 'redact')])

    expect(outcome.complete).toBe(false)
    const patch = state.item_updates[0]?.patch
    expect(patch?.status).toBe('active')
    expect(String(patch?.staging_key)).toMatch(/^content-upload\/42\//)
    // 100 字节远小于片大小：单次 PUT，无 multipart
    expect(patch?.upload_id).toBeNull()
  })

  it('源未加密 / 格式不支持 / 双胞胎名被占：准备阶段直接 skipped', async () => {
    state.scope_file_rows = [file_row('a.png')]
    state.scope_paths = ['a.png']

    const outcome = await execute_task(make_task('redact', { source_file_name: 'a.png', content_type: 'image/png', size: 100 }), [make_transfer_item('a.png', 'redact')])

    expect(outcome.complete).toBe(true)
    expect(state.item_updates[0]?.patch).toMatchObject({ status: 'skipped', result: { reason: '只有已加密的图片才能创建删减版' } })
    expect(state.multipart_created).toEqual([])
  })

  it('恢复时不重新分配暂存（客户端继续灌原 key）', async () => {
    const outcome = await execute_task(redact_task(), [make_transfer_item('a.png.good', 'redact', { status: 'active', staging_key: 'content-upload/42/existing' })])

    expect(outcome.complete).toBe(false)
    expect(state.item_updates).toEqual([])
    expect(state.multipart_created).toEqual([])
  })
})

describe('finalize_transfer_item：删减版', () => {
  it('交给 apply_abridged_attachment 落行', async () => {
    const task = make_task('redact', { source_file_name: 'a.png.good', content_type: 'image/png', size: 100 })
    const item = make_transfer_item('a.png.good', 'redact', { staging_key: 'content-upload/42/redact' })

    await finalize_transfer_item(task, item, [])

    expect(state.redacted).toEqual({ source: 'a.png.good', key: 'content-upload/42/redact' })
  })
})
