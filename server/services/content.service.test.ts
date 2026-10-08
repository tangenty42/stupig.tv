import type { AuthUser } from '@server/types/auth'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { encrypt_attachment } from '@server/lib/attachment-crypto'
import { attachment_name_conflict_message } from '@shared/content-markdown'
import { CONTENT_PRIVATE_DENIED_TEXT } from '@shared/content-private'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: {
    oss: { bucket: 'unit-test-bucket' },
    app: {
      content: {
        // 故事/链接的长度上限只影响 markdown 渲染，这里不 pin；留空对象保持与
        // 迁移前同样的取值（undefined），不改变这些测试覆盖的行为
        story: {},
        link: {},
        operationLock: { ttlSeconds: 60 },
        upload: { urlTtlSeconds: 900, partSizeMb: 8, signBatchSize: 20, maxSizeMb: 20480 },
        task: { heartbeatSeconds: 30, queuedTimeoutSeconds: 300, retentionHours: 24, sweepIntervalSeconds: 60 },
        encrypt: { maxSizeMb: 10 },
        download: { urlTtlSeconds: 300 },
      },
    },
  },
  signed_object_url: vi.fn(async (_command?: unknown, _expires_in?: number) => 'https://signed.example.test/upload'),
  get_object: vi.fn(),
  put_object: vi.fn(),
  delete_object_best_effort: vi.fn(),
  head_object: vi.fn(),
  copy_object: vi.fn(),
  publish_refresh: vi.fn(),
  db_execute: vi.fn(),
  /** The transaction connection structural operations run on. */
  get_connection: vi.fn(),
}))

/**
 * The legacy endpoints run through the task queue now, so the queue's
 * bookkeeping tables get the same in-memory treatment as the business tables:
 * every content_tasks / content_task_items statement is answered here and
 * never reaches the per-test stubs.
 */
const task_sim = vi.hoisted(() => {
  interface TaskRow {
    id: number
    scope_id: number
    kind: string
    status: string
    payload: string
    actor_id: number | null
    client_id: string | null
    error: string | null
  }
  interface ItemRow {
    id: number
    task_id: number
    path: string
    action: string
    status: string
    bytes_done: number
    bytes_total: number
    staging_key: string | null
    upload_id: string | null
    part_size: number | null
    result: string | null
  }
  const tasks: TaskRow[] = []
  const items: ItemRow[] = []
  let next_task_id = 1
  let next_item_id = 1

  function handle(sql: string, params: unknown[]): unknown[] | null {
    if (sql.includes('INSERT INTO content_tasks')) {
      const id = next_task_id ++
      tasks.push({ id, scope_id: Number(params[0]), kind: String(params[1]), status: 'queued', payload: String(params[2]), actor_id: params[3] as number | null, client_id: params[4] as string | null, error: null })
      return [{ insertId: id }]
    }
    if (sql.includes('INSERT INTO content_task_items')) {
      const id = next_item_id ++
      items.push({ id, task_id: Number(params[0]), path: String(params[1]), action: String(params[2]), status: 'pending', bytes_done: 0, bytes_total: Number(params[3] ?? 0), staging_key: null, upload_id: null, part_size: null, result: null })
      return [{ affectedRows: 1 }]
    }
    if (sql.includes('FROM content_tasks WHERE id ='))
      return [tasks.filter(task => task.id === Number(params[0])).map(task => ({ ... task, heartbeat_at: null, created_at: '', updated_at: '' }))]
    if (sql.includes('FROM content_task_items WHERE task_id ='))
      return [items.filter(item => item.task_id === Number(params[0]))]
    if (sql.includes('UPDATE content_tasks SET status')) {
      const [to, error, task_id, ... from] = params
      const task = tasks.find(entry => entry.id === Number(task_id))
      if (task && (from as string[]).includes(task.status)) {
        task.status = String(to)
        task.error = error as string | null
        return [{ affectedRows: 1 }]
      }
      return [{ affectedRows: 0 }]
    }
    if (sql.includes('UPDATE content_task_items SET')) {
      const item_id = Number(params[params.length - 2])
      const item = items.find(entry => entry.id === item_id)
      if (item) {
        const values = params.slice(0, - 2)
        let index = 0
        // The service builds the SET clause in this fixed column order.
        if (sql.includes('status = ?'))
          item.status = String(values[index ++])
        if (sql.includes('bytes_done = ?'))
          item.bytes_done = Number(values[index ++])
        if (sql.includes('staging_key = ?'))
          item.staging_key = values[index ++] as string | null
        if (sql.includes('upload_id = ?'))
          item.upload_id = values[index ++] as string | null
        if (sql.includes('part_size = ?'))
          item.part_size = Number(values[index ++])
        if (sql.includes('result = CAST'))
          item.result = values[index ++] as string | null
      }
      return [{ affectedRows: item ? 1 : 0 }]
    }
    return null
  }

  function reset() {
    tasks.length = 0
    items.length = 0
    next_task_id = 1
    next_item_id = 1
  }

  return { tasks, items, handle, reset }
})

vi.mock('@shared/config', () => ({ runtime_config: () => mocks.config }))
vi.mock('@server/lib/db', () => ({
  db: {
    execute: (sql: string, params?: unknown[]) => task_sim.handle(sql, params ?? []) ?? mocks.db_execute(sql, params),
    getConnection: async () => {
      const inner = await mocks.get_connection() as { execute: (sql: string, params?: unknown[]) => Promise<unknown> }
      return {
        ... inner,
        execute: (sql: string, params?: unknown[]) => task_sim.handle(sql, params ?? []) ?? inner.execute(sql, params),
      }
    },
  },
}))
vi.mock('@server/lib/storage', () => ({
  signed_object_url: mocks.signed_object_url,
  copy_object: mocks.copy_object,
  delete_object_best_effort: mocks.delete_object_best_effort,
  get_object: mocks.get_object,
  head_object: mocks.head_object,
  put_object: mocks.put_object,
}))
// The lease itself is exercised by the lock's own tests; here the scope lock
// only has to be taken and released, and task path locks always acquire.
vi.mock('@server/lib/operation-lock', () => ({
  acquire_operation_lock: vi.fn(async (scope_id: number) => ({ scope_id, token: 'test-token' })),
  release_operation_lock: vi.fn(async () => {}),
  get_operation_lock: vi.fn(async () => null),
  acquire_path_locks: vi.fn(async (scope_id: number, paths: string[], task_id: number) => ({ acquired: true as const, lock: { scope_id, task_id, token: 'test-token', paths } })),
  release_path_locks: vi.fn(async () => {}),
  release_task_locks: vi.fn(async () => {}),
  renew_task_locks: vi.fn(async () => 1),
  list_scope_locks: vi.fn(async () => []),
}))

vi.mock('@server/lib/sync', async () => ({
  ... (await vi.importActual<typeof import('@server/lib/sync')>('@server/lib/sync')),
  publish_refresh: mocks.publish_refresh,
}))

const { confirm_attachment_upload, create_abridged_attachment, create_folder, decrypt_attachments, encrypt_attachments, get_story, move_attachment, move_attachments, move_folder, rename_attachment, replace_attachment, sign_attachment_download, sign_attachment_upload } = await import('@server/services/content.service')

beforeEach(() => {
  task_sim.reset()
})

function stub_story_row(story_id: number, markdown = '') {
  mocks.db_execute.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM content_stories')) {
      return [[{
        id: story_id,
        title: 'story',
        label: '',
        description: '',
        cover: '',
        cover_label: '',
        cover_version: null,
        event_precision: 'day',
        event_dates: '[]',
        markdown,
        created_at: '2026-01-01 00:00:00',
        updated_at: '2026-01-01 00:00:00',
        revision: 1,
      }], []]
    }
    return [[], []]
  })
}

describe('sign_attachment_upload staging key validation', () => {
  beforeEach(() => {
    mocks.signed_object_url.mockClear()
    mocks.db_execute.mockReset()
    mocks.db_execute.mockResolvedValue([[], []])
  })
  // Uploads start only after the story exists; story_id 0 never gets a signature.
  it('rejects new-scope keys for unsaved stories (story_id 0)', async () => {
    const key = `content-upload/new/${crypto.randomUUID()}`
    await expect(sign_attachment_upload({ story_id: 0, method: 'PUT', key }))
      .rejects.toMatchObject({ name: 'ApiError', statusCode: 400, message: '上传凭证无效' })
    expect(mocks.signed_object_url).not.toHaveBeenCalled()
  })

  it('rejects multipart creation under the new scope', async () => {
    const key = `content-upload/new/${crypto.randomUUID()}`
    await expect(sign_attachment_upload({ story_id: 0, method: 'POST', key }))
      .rejects.toMatchObject({ statusCode: 400, message: '上传凭证无效' })
  })

  // Regression guard: a key under content-upload/0/ matches story_id 0's
  // prefix, so the story lookup is what stops it from being signed.
  it('rejects the numeric zero prefix for unsaved stories', async () => {
    await expect(sign_attachment_upload({ story_id: 0, method: 'PUT', key: `content-upload/0/${crypto.randomUUID()}` }))
      .rejects.toMatchObject({ name: 'ApiError', statusCode: 404, message: '档案不存在或已被删除' })
    expect(mocks.signed_object_url).not.toHaveBeenCalled()
  })

  it('rejects keys scoped to a persisted story for unsaved stories', async () => {
    await expect(sign_attachment_upload({ story_id: 0, method: 'PUT', key: `content-upload/42/${crypto.randomUUID()}` }))
      .rejects.toMatchObject({ statusCode: 400, message: '上传凭证无效' })
  })

  it('rejects keys whose suffix is not a plain token', async () => {
    await expect(sign_attachment_upload({ story_id: 0, method: 'PUT', key: 'content-upload/new/name.with.dots' }))
      .rejects.toMatchObject({ statusCode: 400, message: '上传凭证无效' })
  })

  it('accepts keys under the matching story prefix', async () => {
    stub_story_row(42)
    const key = `content-upload/42/${crypto.randomUUID()}`
    const result = await sign_attachment_upload({ story_id: 42, method: 'PUT', key })
    expect(result.key).toBe(key)
  })

  it('rejects the new scope for persisted stories', async () => {
    await expect(sign_attachment_upload({ story_id: 42, method: 'PUT', key: `content-upload/new/${crypto.randomUUID()}` }))
      .rejects.toMatchObject({ statusCode: 400, message: '上传凭证无效' })
    expect(mocks.signed_object_url).not.toHaveBeenCalled()
  })
})

describe('sign_attachment_download', () => {
  const story_row = {
    id: 42,
    title: 't',
    label: '',
    description: '',
    cover: '',
    cover_label: '',
    cover_version: null,
    event_precision: 'day',
    event_dates: '[]',
    markdown: '',
    created_at: '',
    updated_at: '',
    revision: 1,
  }

  function file_row(overrides: Partial<{ file_name: string, object_key: string, encryption_key: string | null }>) {
    return {
      id: 77,
      story_id: 42,
      is_folder: 0,
      file_name: 'docs/report.PDF',
      object_key: 'content/att/77',
      mime_type: 'application/pdf',
      file_size: 10,
      version: 'v1',
      encryption_key: null,
      ... overrides,
    }
  }

  /** Answers the story read and the row-by-name read; everything else is empty. */
  function stub_story_and_file(row: ReturnType<typeof file_row> | null) {
    mocks.db_execute.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM content_stories'))
        return [[story_row], []]
      if (sql.includes('file_name IN'))
        return [row ? [row] : [], []]
      return [[], []]
    })
  }

  beforeEach(() => {
    mocks.signed_object_url.mockClear()
    mocks.db_execute.mockReset()
  })

  it('signs a GET that saves the row under its display name', async () => {
    stub_story_and_file(file_row({}))
    const result = await sign_attachment_download(42, 'docs/report.PDF')

    expect(result.url).toBe('https://signed.example.test/upload')
    const command = mocks.signed_object_url.mock.calls[0]![0] as GetObjectCommand
    expect(command).toBeInstanceOf(GetObjectCommand)
    expect(command.input.Bucket).toBe('unit-test-bucket')
    expect(command.input.Key).toBe('content/att/77')
    // Folder stripped, extension lowercased, RFC 5987 encoded.
    expect(command.input.ResponseContentDisposition).toBe(`attachment; filename*=UTF-8''report.pdf`)
    expect(mocks.signed_object_url.mock.calls[0]![1]).toBe(mocks.config.app.content.download.urlTtlSeconds)
  })

  it('percent-encodes a CJK name for the filename* parameter', async () => {
    stub_story_and_file(file_row({ file_name: '照片.PNG', object_key: 'content/att/cjk' }))
    await sign_attachment_download(42, '照片.PNG')

    const command = mocks.signed_object_url.mock.calls[0]![0] as GetObjectCommand
    expect(command.input.ResponseContentDisposition).toBe(`attachment; filename*=UTF-8''%E7%85%A7%E7%89%87.png`)
  })

  it('escapes the characters encodeURIComponent leaves bare in an ext-value', async () => {
    // `'` delimits the ext-value and the rest are not valid there, so a name
    // like this has to survive the round trip through the header verbatim.
    stub_story_and_file(file_row({ file_name: `报告 (1).pdf` }))
    await sign_attachment_download(42, `报告 (1).pdf`)

    const command = mocks.signed_object_url.mock.calls[0]![0] as GetObjectCommand
    expect(command.input.ResponseContentDisposition)
      .toBe(`attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%281%29.pdf`)
  })

  it('refuses an unknown attachment', async () => {
    stub_story_and_file(null)
    await expect(sign_attachment_download(42, 'gone.pdf'))
      .rejects.toMatchObject({ statusCode: 404, message: '附件不存在或已被删除' })
    expect(mocks.signed_object_url).not.toHaveBeenCalled()
  })

  it('refuses an encrypted row: its object is ciphertext', async () => {
    stub_story_and_file(file_row({ file_name: 'secret.png.good', encryption_key: 'key' }))
    await expect(sign_attachment_download(42, 'secret.png.good'))
      .rejects.toMatchObject({ statusCode: 400, message: '加密的附件请在页面中下载' })
    expect(mocks.signed_object_url).not.toHaveBeenCalled()
  })

  it('refuses a story that does not exist', async () => {
    mocks.db_execute.mockResolvedValue([[], []])
    await expect(sign_attachment_download(99, 'x.pdf'))
      .rejects.toMatchObject({ statusCode: 404, message: '档案不存在或已被删除' })
    expect(mocks.signed_object_url).not.toHaveBeenCalled()
  })
})

describe('get_story private stripping', () => {
  const private_markdown = 'public\n\n<good>\nsecret\n</good>\n'

  function viewer(overrides: Partial<AuthUser>) {
    return {
      id: 7,
      session_id: 1,
      username: 'viewer',
      phone: '',
      avatar_file: null,
      is_verified: false,
      is_admin: false,
      ... overrides,
    } as AuthUser
  }

  beforeEach(() => {
    mocks.db_execute.mockReset()
    stub_story_row(1, private_markdown)
  })

  it('redacts private elements for a guest viewer', async () => {
    const story = await get_story(1, undefined, null)

    expect(story!.has_private).toBe(true)
    expect(story!.markdown).not.toContain('secret')
    expect(story!.markdown).toContain(CONTENT_PRIVATE_DENIED_TEXT)
    expect(story!.markdown).toContain('public')
  })

  it('redacts private elements for a user without content_private', async () => {
    const story = await get_story(1, undefined, viewer({ permissions: [] }))

    expect(story!.markdown).not.toContain('secret')
    expect(story!.markdown).toContain(CONTENT_PRIVATE_DENIED_TEXT)
    expect(story!.has_private).toBe(true)
  })

  it('keeps private elements for a user holding content_private read', async () => {
    const story = await get_story(1, undefined, viewer({ permissions: [{ field: 'content_private', level: 'read' }] }))

    expect(story!.markdown).toBe(private_markdown)
    expect(story!.has_private).toBe(true)
  })

  it('keeps private elements for an admin', async () => {
    const story = await get_story(1, undefined, viewer({ is_admin: true }))

    expect(story!.markdown).toBe(private_markdown)
  })

  it('internal calls without a viewer get the full markdown', async () => {
    const story = await get_story(1)

    expect(story.markdown).toBe(private_markdown)
  })
})

describe('get_story version check', () => {
  const base = { updated_at: '2026-01-01 00:00:00', viewer_key: 'anon:false' }

  beforeEach(() => {
    mocks.db_execute.mockReset()
    stub_story_row(1, 'public\n\n<good>\nsecret\n</good>\n')
  })

  it('returns null when both the story and the viewer are unchanged', async () => {
    await expect(get_story(1, base, null)).resolves.toBeNull()
  })

  it('returns a full copy when the viewer changed despite an unchanged story', async () => {
    const story = await get_story(1, base, {
      id: 7,
      session_id: 1,
      username: 'viewer',
      phone: '',
      avatar_file: null,
      is_verified: false,
      is_admin: true,
    } as AuthUser)

    expect(story!.viewer_key).toBe('7:true')
    expect(story!.markdown).toContain('secret')
  })

  it('reports the viewer key each payload was rendered for', async () => {
    const story = await get_story(1, undefined, null)

    expect(story.viewer_key).toBe('anon:false')
  })
})

describe('create_abridged_attachment', () => {
  const png_header = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
  const jpeg_header = [0xFF, 0xD8, 0xFF, 0xE0]

  const encrypted_png: {
    id: number
    story_id: number
    is_folder: number
    file_name: string
    object_key: string
    mime_type: string
    file_size: number
    version: string
    encryption_key: string | null
  } = {
    id: 11,
    story_id: 5,
    is_folder: 0,
    file_name: 'cards/photo.png.good',
    object_key: 'content/att/cipher',
    mime_type: 'image/png',
    file_size: 40,
    version: 'v1',
    encryption_key: 'a2V5',
  }

  function abridged_form(bytes: number[]) {
    const form = new FormData()
    form.append('story_id', '5')
    form.append('source_file_name', 'cards/photo.png.good')
    form.append('file', new File([new Uint8Array(bytes)], 'ignored.png', { type: 'image/png' }))
    return form
  }

  /** Answers the scope's read-check-insert sequence for one redaction request. */
  function stub_scope(source: typeof encrypted_png | null, existing_paths: string[] = []) {
    mocks.db_execute.mockImplementation(async (sql: string) => {
      if (sql.includes('file_name IN ('))
        return [source ? [source] : [], []]
      if (sql.includes('SELECT file_name FROM content_story_attachments'))
        return [existing_paths.map(file_name => ({ file_name })), []]
      if (sql.startsWith('INSERT INTO content_story_attachments'))
        return [{ affectedRows: 1, insertId: 12 }, []]
      if (sql.startsWith('SELECT * FROM content_story_attachments'))
        return [[{ ... encrypted_png, id: 12, file_name: 'cards/photo.png', object_key: 'content/att/twin', encryption_key: null }], []]
      return [[], []]
    })
  }

  beforeEach(() => {
    mocks.db_execute.mockReset()
    mocks.db_execute.mockResolvedValue([[], []])
    mocks.put_object.mockReset()
    mocks.put_object.mockResolvedValue('etag-twin')
    mocks.delete_object_best_effort.mockReset()
    mocks.publish_refresh.mockReset()
  })

  it('stores the redaction under the name without the .good suffix', async () => {
    stub_scope(encrypted_png)

    const row = await create_abridged_attachment(5, 'cards/photo.png.good', abridged_form([... png_header, 1, 2, 3]))

    expect(row.file_name).toBe('cards/photo.png')
    expect(row.is_encrypted).toBe(false)
  })

  it('uploads the exported bytes unchanged, typed as the source format', async () => {
    stub_scope(encrypted_png)
    const bytes = [... png_header, 9, 8, 7]

    await create_abridged_attachment(5, 'cards/photo.png.good', abridged_form(bytes))

    // No transcoding: the object is exactly what the editor exported, and the
    // content type comes from the name rather than the form payload.
    const [, stored, content_type] = mocks.put_object.mock.calls[0]!
    expect([... (stored as Uint8Array)]).toEqual(bytes)
    expect(content_type).toBe('image/png')
  })

  it('bumps the story so subscribers refetch the attachment list', async () => {
    stub_scope(encrypted_png)

    await create_abridged_attachment(5, 'cards/photo.png.good', abridged_form(png_header))

    const touch = mocks.db_execute.mock.calls.find(([sql]) => String(sql).includes('UPDATE content_stories SET updated_at'))
    expect(touch).toBeDefined()
    expect(touch![1]).toEqual([5])
  })

  it('refuses a source that is not encrypted', async () => {
    stub_scope({ ... encrypted_png, file_name: 'cards/photo.png', encryption_key: null })

    await expect(create_abridged_attachment(5, 'cards/photo.png', abridged_form(png_header)))
      .rejects.toMatchObject({ statusCode: 400, message: '只有已加密的图片才能创建删减版' })
    expect(mocks.put_object).not.toHaveBeenCalled()
  })

  it('refuses a format the editor cannot write back', async () => {
    stub_scope({ ... encrypted_png, file_name: 'cards/anim.gif.good', mime_type: 'image/gif' })

    await expect(create_abridged_attachment(5, 'cards/anim.gif.good', abridged_form(png_header)))
      .rejects.toMatchObject({ statusCode: 400, message: '该图片格式不支持创建删减版' })
    expect(mocks.put_object).not.toHaveBeenCalled()
  })

  it('refuses payload bytes that do not match the target name', async () => {
    stub_scope(encrypted_png)

    await expect(create_abridged_attachment(5, 'cards/photo.png.good', abridged_form(jpeg_header)))
      .rejects.toMatchObject({ statusCode: 400, message: '删减版内容与文件格式不符' })
    expect(mocks.put_object).not.toHaveBeenCalled()
  })

  it('never takes over an existing twin, reporting the conflict instead', async () => {
    stub_scope(encrypted_png, ['cards/photo.png'])

    await expect(create_abridged_attachment(5, 'cards/photo.png.good', abridged_form(png_header)))
      .rejects.toMatchObject({ statusCode: 409, message: attachment_name_conflict_message })
    expect(mocks.put_object).not.toHaveBeenCalled()
  })

  it('reports a missing source', async () => {
    stub_scope(null)

    await expect(create_abridged_attachment(5, 'cards/photo.png.good', abridged_form(png_header)))
      .rejects.toMatchObject({ statusCode: 404 })
  })
})

/**
 * Every one of these operations names an attachment, and all of them go through
 * the same guard, so the reserved suffix and the illegal characters have to be
 * refused identically whichever door the name arrives by. The individual rules
 * are covered in the shared module's tests; what these assert is the wiring —
 * one guard the operations share rather than a check per operation.
 */
describe('attachment name guard', () => {
  const story_row = {
    id: 5,
    title: 't',
    label: '',
    description: '',
    cover: '',
    cover_label: '',
    cover_version: null,
    event_precision: 'day',
    event_dates: '[]',
    markdown: '',
    created_at: '',
    updated_at: '',
    revision: 1,
  }

  function file_row(file_name: string, id = 10, encryption_key: string | null = null) {
    return {
      id,
      story_id: 5,
      is_folder: 0,
      file_name,
      object_key: `content/att/${id}`,
      mime_type: 'image/png',
      file_size: 10,
      version: 'v1',
      encryption_key,
    }
  }

  function folder_row(file_name: string, id = 3) {
    return { ... file_row(file_name, id), is_folder: 1, object_key: null, mime_type: null, file_size: 0, version: '' }
  }

  /**
   * Answers the read-check-write sequence of one scope. The checks are ordered
   * most specific first, because the query strings nest: the encryption-key and
   * folder listings both contain the file listing's `is_folder = 0` clause.
   */
  function stub_scope(rows: ReturnType<typeof file_row | typeof folder_row>[]) {
    const files = rows.filter(row => ! row.is_folder)
    const folders = rows.filter(row => row.is_folder)
    mocks.db_execute.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('encryption_key IS NOT NULL'))
        return [[], []]
      if (sql.includes('FROM content_stories'))
        return [[story_row], []]
      // move_folder reads its subtree by prefix through the transaction
      // connection, which forwards here, so the filter has to be honoured: a
      // stub that returned every row would hide a cross-subtree collision.
      if (sql.includes('SUBSTRING(file_name, 1, ?)')) {
        const source = String(params?.[1] ?? '')
        return [rows.filter(row => row.file_name === source || row.file_name.startsWith(`${source}/`)), []]
      }
      if (sql.includes('SELECT file_name FROM content_story_attachments'))
        return [rows.map(row => ({ file_name: row.file_name })), []]
      if (sql.includes('is_folder = 1'))
        return [folders, []]
      if (sql.includes('is_folder = 0'))
        return [files, []]
      if (sql.includes('SELECT * FROM content_story_attachments'))
        return [rows, []]
      return [[], []]
    })
  }

  let connection: { execute: (... args: unknown[]) => Promise<unknown>, beginTransaction: () => Promise<void>, commit: () => Promise<void>, rollback: () => Promise<void>, release: () => void }

  beforeEach(() => {
    connection = {
      // The service runs its statement sequence on the transaction connection,
      // so it forwards to the same stub the pooled calls use.
      execute: (... args: unknown[]) => mocks.db_execute(... args),
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
    }
    mocks.get_connection.mockResolvedValue(connection)
    mocks.db_execute.mockReset()
    mocks.db_execute.mockResolvedValue([[], []])
    // Deletes go through the best-effort wrapper, whose failure handling has
    // its own test in lib/storage.test.ts.
    mocks.put_object.mockReset()
    mocks.put_object.mockResolvedValue('etag-1')
    mocks.head_object.mockReset()
    mocks.head_object.mockResolvedValue({ size: 3, content_type: 'image/png', etag: 'source-etag' })
    mocks.copy_object.mockReset()
    mocks.copy_object.mockResolvedValue('etag-1')
    mocks.delete_object_best_effort.mockReset()
    mocks.delete_object_best_effort.mockResolvedValue(undefined)
  })

  it('refuses a .good folder on create', async () => {
    stub_scope([])

    await expect(create_folder(5, 'cards.good'))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('.good') })
  })

  it('refuses a .good folder on rename', async () => {
    stub_scope([folder_row('cards')])

    await expect(move_folder(5, 'cards', 'cards.good'))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('.good') })
  })

  it('refuses a .good name on file rename', async () => {
    stub_scope([file_row('photo.png')])

    await expect(rename_attachment(5, 'photo.png', 'photo.png.good'))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('.good') })
  })

  it('refuses illegal characters on file rename', async () => {
    stub_scope([file_row('photo.png')])

    await expect(rename_attachment(5, 'photo.png', 'bad name.png'))
      .rejects.toMatchObject({ statusCode: 400, message: '文件名包含不支持的字符' })
  })

  it('renames an encrypted file, keeping the marker the row already carries', async () => {
    // The marker is the row's state, so the author edits only the stem and the
    // server keeps `.good` in place. This is the case a blanket "no .good" rule
    // refused outright, and the client's locked `.[ext].good` tail produces it.
    stub_scope([file_row('photo.png.good', 10, 'a2V5')])

    await expect(rename_attachment(5, 'photo.png.good', 'renamed.png.good')).resolves.toBeTruthy()
    expect(connection.commit).toHaveBeenCalled()
  })

  it('refuses a rename that adds the marker', async () => {
    // Faking encryption on a plaintext row would render ciphertext-less bytes
    // as confidential, and the key would be missing.
    stub_scope([file_row('photo.png')])

    await expect(rename_attachment(5, 'photo.png', 'photo.png.good'))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('.good') })
  })

  it('refuses a rename that drops the marker', async () => {
    // A row whose name says plaintext but that still holds a key would render
    // ciphertext as if it were readable. 取消加密 owns that transition.
    stub_scope([file_row('photo.png.good', 10, 'a2V5')])

    await expect(rename_attachment(5, 'photo.png.good', 'photo.png'))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('.good') })
  })

  it('still validates the editable stem of an encrypted rename', async () => {
    stub_scope([file_row('photo.png.good', 10, 'a2V5')])

    await expect(rename_attachment(5, 'photo.png.good', 'bad name.png.good'))
      .rejects.toMatchObject({ statusCode: 400, message: '文件名包含不支持的字符' })
  })

  it('still refuses an encrypted rename that collides', async () => {
    stub_scope([file_row('photo.png.good', 10, 'a2V5'), file_row('other.png.good', 11, 'a2V5')])

    await expect(rename_attachment(5, 'photo.png.good', 'other.png.good'))
      .rejects.toMatchObject({ statusCode: 409, message: attachment_name_conflict_message })
  })

  it('still lets an ordinary rename through', async () => {
    // The guard has to refuse the reserved suffix without becoming a blanket ban.
    stub_scope([file_row('photo.png')])

    await expect(rename_attachment(5, 'photo.png', 'photo-2.png')).resolves.toBeTruthy()
    expect(connection.commit).toHaveBeenCalled()
  })

  it('lowercases the extension on rename', async () => {
    // Extensions are normalized to lowercase on the way in, so a rename to
    // `photo.PNG` stores `photo.png` and the stored name stays canonical.
    stub_scope([file_row('photo.png')])

    await expect(rename_attachment(5, 'photo.png', 'photo.PNG'))
      .resolves.toMatchObject({ file_name: 'photo.png' })
  })

  it('lowercases the plaintext extension when renaming an encrypted file', async () => {
    // The `.good` marker is the last dot, so the case fix has to look past it:
    // the client sends the locked tail `.[ext].good` verbatim.
    stub_scope([file_row('photo.png.good', 10, 'a2V5')])

    await rename_attachment(5, 'photo.png.good', 'renamed.PNG.good')

    // Assert the stored name rather than the return value: the stub answers any
    // name lookup with the same row, so only the write proves the normalization.
    const update = mocks.db_execute.mock.calls.find(call => String(call[0]).startsWith('UPDATE content_story_attachments SET file_name'))
    expect(update?.[1]).toEqual(['renamed.png.good', 5, 'photo.png.good'])
  })

  it('refuses a rename that only an uppercase marker would make legal', async () => {
    // `photo.png.GOOD` lowercases to `photo.png.good`, which is the reserved
    // marker. Normalizing after the marker check would let it through as a
    // freshly-appended encryption suffix on a plaintext row.
    stub_scope([file_row('photo.png')])

    await expect(rename_attachment(5, 'photo.png', 'photo.png.GOOD'))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('.good') })
  })

  it('lets a folder move land on the folder that already answers to the name', async () => {
    // The documented merge: the guard must not turn it into a 409.
    stub_scope([folder_row('a', 3), folder_row('b', 4)])

    await expect(move_folder(5, 'b', 'a')).resolves.toBeTruthy()
    expect(connection.commit).toHaveBeenCalled()
  })

  /**
   * The legality half belongs to the name an author supplies, not to a name the
   * server derives from a row it already holds: an encrypted file's `.good`
   * marker is the server's own, and re-validating it refused every operation
   * that carried one along — a folder holding an encrypted file could not be
   * renamed at all. Only availability is checked for those.
   */
  it('renames a folder that holds an encrypted file', async () => {
    stub_scope([folder_row('cards', 3), file_row('cards/photo.png.good', 10)])

    await expect(move_folder(5, 'cards', 'cards2')).resolves.toBeTruthy()
    expect(connection.commit).toHaveBeenCalled()
  })

  it('gives the renamed folder a row of its own', async () => {
    // Without it the renamed folder exists only through its files, so it would
    // vanish as soon as the last one was deleted — the same bug the upload path
    // was fixed for, arriving through the rename door instead.
    stub_scope([folder_row('cards', 3), file_row('cards/photo.png.good', 10)])

    await move_folder(5, 'cards', 'cards2')

    const inserted = mocks.db_execute.mock.calls
      .filter(([sql]) => String(sql).includes('is_folder, file_name'))
      .map(([, params]) => String((params as unknown[])[1]))
    expect(inserted).toEqual(['cards2'])
  })

  it('moves an encrypted file into another folder', async () => {
    stub_scope([file_row('cards/photo.png.good', 10)])

    await expect(move_attachment(5, 'cards/photo.png.good', null)).resolves.toBeTruthy()
    expect(connection.commit).toHaveBeenCalled()
  })

  it('moves encrypted files in a batch', async () => {
    stub_scope([file_row('cards/photo.png.good', 10), file_row('cards/doc.pdf.good', 11)])

    await expect(move_attachments(5, [
      { file_name: 'cards/photo.png.good', target_folder: null },
      { file_name: 'cards/doc.pdf.good', target_folder: null },
    ])).resolves.toBeTruthy()
    expect(connection.commit).toHaveBeenCalled()
  })

  it('returns the successful moves when another destination is occupied', async () => {
    stub_scope([file_row('cards/a.png', 10), file_row('cards/b.png', 11), file_row('a.png', 12)])

    const result = await move_attachments(5, [
      { file_name: 'cards/a.png', target_folder: null },
      { file_name: 'cards/b.png', target_folder: null },
    ])

    expect(result.succeeded).toEqual(['cards/b.png'])
    expect(result.skipped).toEqual([{ file_name: 'cards/a.png', reason: attachment_name_conflict_message }])
    expect(connection.commit).toHaveBeenCalled()
  })

  it('refuses to replace an encrypted attachment', async () => {
    // A replacement swaps the object but not the row's key, which would leave
    // plaintext bytes marked encrypted and render the file unopenable.
    stub_scope([file_row('photo.png.good', 10, 'a2V5')])

    await expect(replace_attachment(5, 'photo.png.good', 'content-upload/5/replacement', 'photo.png', 'image/png', 'keep-name'))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('已加密') })
    expect(mocks.copy_object).not.toHaveBeenCalled()
  })

  it('still replaces a plaintext attachment', async () => {
    stub_scope([file_row('photo.png', 10)])

    await expect(replace_attachment(5, 'photo.png', 'content-upload/5/replacement', 'photo.png', 'image/png', 'keep-name'))
      .resolves.toBeTruthy()
    expect(mocks.copy_object).toHaveBeenCalled()
  })

  it('still refuses a derived name that collides with what survives', async () => {
    // Dropping the legality check must not drop the conflict check with it:
    // `cards/photo.png.good` merging into `x` would land on the row that
    // already holds that name there.
    stub_scope([
      folder_row('cards', 3),
      file_row('cards/photo.png.good', 10),
      folder_row('x', 4),
      file_row('x/photo.png.good', 11),
    ])

    await expect(move_folder(5, 'cards', 'x'))
      .rejects.toMatchObject({ statusCode: 409, message: attachment_name_conflict_message })
  })
})

/**
 * The encrypt/decrypt split decides from the row's own state: encrypt takes
 * plaintext rows, decrypt takes `.good` rows, and everything else is reported
 * as skipped — an inverted split encrypts the already-encrypted and refuses
 * exactly the files it exists for.
 */
describe('attachment encryption transform', () => {
  const story_row = {
    id: 5,
    title: 't',
    label: '',
    description: '',
    cover: '',
    cover_label: '',
    cover_version: null,
    event_precision: 'day',
    event_dates: '[]',
    markdown: '',
    created_at: '',
    updated_at: '',
    revision: 1,
  }

  function file_row(file_name: string, id = 10, encryption_key: string | null = null) {
    return {
      id,
      story_id: 5,
      is_folder: 0,
      file_name,
      object_key: `content/att/${id}`,
      mime_type: 'image/png',
      file_size: 10,
      version: 'v1',
      encryption_key,
    }
  }

  function stub_scope(rows: ReturnType<typeof file_row>[]) {
    mocks.db_execute.mockImplementation(async (sql: string) => {
      if (sql.includes('file_name IN ('))
        return [rows, []]
      if (sql.includes('SELECT file_name FROM content_story_attachments'))
        return [rows.map(row => ({ file_name: row.file_name })), []]
      if (sql.includes('FROM content_stories'))
        return [[story_row], []]
      if (sql.includes('is_folder = 1'))
        return [[], []]
      if (sql.includes('is_folder = 0'))
        return [rows, []]
      return [[], []]
    })
  }

  beforeEach(() => {
    mocks.get_connection.mockResolvedValue({
      execute: (... args: unknown[]) => mocks.db_execute(... args),
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
    })
    mocks.db_execute.mockReset()
    mocks.db_execute.mockResolvedValue([[], []])
    mocks.get_object.mockReset()
    mocks.get_object.mockResolvedValue(new Uint8Array([1, 2, 3]))
    mocks.put_object.mockReset()
    mocks.put_object.mockResolvedValue('etag-1')
    mocks.delete_object_best_effort.mockReset()
    mocks.delete_object_best_effort.mockResolvedValue(undefined)
  })

  /** The row rewrite of the transform: [file_name, object_key, file_size, version, encryption_key, id]. */
  function encryption_update_calls() {
    return mocks.db_execute.mock.calls
      .filter(([sql]) => String(sql).includes('UPDATE content_story_attachments SET file_name'))
      .map(([, params]) => params as unknown[])
  }

  it('encrypts a plaintext row under the .good name with a fresh key', async () => {
    stub_scope([file_row('photo.png')])

    const result = await encrypt_attachments(5, ['photo.png'])

    expect(result.succeeded).toEqual(['photo.png'])
    expect(result.skipped).toEqual([])
    const [update] = encryption_update_calls()
    expect(update![0]).toBe('photo.png.good')
    expect(typeof update![4]).toBe('string')
    expect((update![4] as string).length).toBeGreaterThan(0)
    expect(mocks.delete_object_best_effort).toHaveBeenCalledWith('content/att/10')
  })

  it('skips an already-encrypted row instead of encrypting it again', async () => {
    stub_scope([file_row('photo.png.good', 10, 'a2V5')])

    const result = await encrypt_attachments(5, ['photo.png.good'])

    expect(result.succeeded).toEqual([])
    expect(result.skipped).toEqual([{ file_name: 'photo.png.good', reason: '已加密' }])
    expect(mocks.get_object).not.toHaveBeenCalled()
    expect(mocks.put_object).not.toHaveBeenCalled()
  })

  it('decrypts an encrypted row back under its plaintext name', async () => {
    const plaintext = new Uint8Array([9, 8, 7, 6])
    const { key, data } = encrypt_attachment(plaintext)
    stub_scope([file_row('photo.png.good', 10, key)])
    mocks.get_object.mockResolvedValue(data)

    const result = await decrypt_attachments(5, ['photo.png.good'])

    expect(result.succeeded).toEqual(['photo.png.good'])
    expect(result.skipped).toEqual([])
    const [, stored] = mocks.put_object.mock.calls[0]!
    expect([... (stored as Uint8Array)]).toEqual([... plaintext])
    const [update] = encryption_update_calls()
    expect(update![0]).toBe('photo.png')
    expect(update![4]).toBeNull()
  })

  it('skips a plaintext row on decrypt', async () => {
    stub_scope([file_row('photo.png')])

    const result = await decrypt_attachments(5, ['photo.png'])

    expect(result.succeeded).toEqual([])
    expect(result.skipped).toEqual([{ file_name: 'photo.png', reason: '未加密' }])
    expect(mocks.get_object).not.toHaveBeenCalled()
    expect(mocks.put_object).not.toHaveBeenCalled()
  })

  it('reports names the scope does not hold', async () => {
    stub_scope([])

    const result = await encrypt_attachments(5, ['ghost.png'])

    expect(result.succeeded).toEqual([])
    expect(result.skipped).toEqual([{ file_name: 'ghost.png', reason: '附件不存在或已被删除' }])
  })
})

/**
 * Folders exist implicitly through the files under them, so an uploaded folder
 * used to vanish the moment its last file was deleted. Recording the folder
 * when it first receives a file is what keeps the structure the author uploaded.
 */
describe('folder rows materialized by uploads', () => {
  const story_row = {
    id: 5,
    title: 't',
    label: '',
    description: '',
    cover: '',
    cover_label: '',
    cover_version: null,
    event_precision: 'day',
    event_dates: '[]',
    markdown: '',
    created_at: '',
    updated_at: '',
    revision: 1,
  }

  /** Every folder row the service asked to insert, as `folder name` strings. */
  function inserted_folders() {
    return mocks.db_execute.mock.calls
      .filter(([sql]) => String(sql).includes('is_folder, file_name'))
      .map(([, params]) => String((params as unknown[])[1]))
  }

  function stub_scope() {
    mocks.db_execute.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM content_stories'))
        return [[story_row], []]
      if (sql.includes('SELECT * FROM content_story_attachments'))
        return [[{ ... story_row, id: 10, is_folder: 0, file_name: 'cards/sub/photo.png', object_key: 'k', mime_type: 'image/png', file_size: 3, version: 'v1', encryption_key: null, story_id: 5 }], []]
      return [[], []]
    })
  }

  beforeEach(() => {
    mocks.db_execute.mockReset()
    mocks.db_execute.mockResolvedValue([[], []])
    mocks.put_object.mockReset()
    mocks.put_object.mockResolvedValue('etag-1')
    mocks.delete_object_best_effort.mockReset()
    mocks.delete_object_best_effort.mockResolvedValue(undefined)
    mocks.head_object.mockResolvedValue({ size: 3, content_type: 'image/png', etag: 'e1' })
    mocks.copy_object.mockResolvedValue('e2')
  })

  it('records the folders of a signed upload too, since that is the path folder uploads take', async () => {
    // The browser uploads straight to storage and confirms afterwards, so the
    // folder rows have to be created on this path or not at all.
    stub_scope()
    const key = `content-upload/5/${crypto.randomUUID()}`

    await confirm_attachment_upload(5, key, 'cards/sub/photo.png')

    expect(inserted_folders()).toEqual(['cards', 'cards/sub'])
  })
})
