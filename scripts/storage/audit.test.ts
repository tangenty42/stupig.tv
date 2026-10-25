import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ deleted: [] as string[], aborted: [] as string[], late_reference: false, current_only: false, listed: 0 }))
vi.mock('@config/loader', () => ({ runtime_config: () => ({
  oss: { bucket: 'current', endpoint: 'https://oss.example.test', buckets: { private: {} } },
  aliyun: { oss: state.current_only ? { bucket: 'current', endpoint: 'https://oss.example.test' } : null },
}) }))
vi.mock('@server/lib/db', () => ({ db: {
  end: async () => {},
  execute: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('UNION SELECT'))
      return [state.late_reference && params[0] === 'content/att/late' ? [{ id: 99 }] : []]
    if (sql.includes('content_attachment_storage_migrations'))
      return [[{ source_key: 'content/att/rollback', target_key: 'content/att/migration' }]]
    if (sql.includes('content_attachment_encryption_backup'))
      return [[]]
    if (sql.includes('content_task_items'))
      return [[{ staging_key: 'content-upload/active', staging_bucket: 'private' }]]
    if (sql.includes('story_id IS NULL'))
      return [[]]
    if (sql.includes('content_story_attachments'))
      return [[{ object_key: 'content/att/ordinary-secret', storage_bucket: 'private', is_private: 0 }]]
    return [[]]
  },
} }))
vi.mock('@server/lib/storage', () => ({
  head_object: async () => ({}),
  list_objects: async (bucket: string, prefix: string) => {
    state.listed ++
    const keys = prefix === 'avatar/' ? [] : prefix === 'content-upload/' ? ['content-upload/active', 'content-upload/stale'] : bucket === 'public' ? ['content/att/rollback'] : ['content/att/ordinary-secret', 'content/att/migration', 'content/att/orphan', 'content/att/late']
    return keys.map(key => ({ key, size: 1, last_modified: new Date(0), etag: 'v1' }))
  },
  list_multipart_uploads: async (bucket: string, prefix: string) => {
    if (bucket !== 'private')
      return []
    const keys = prefix === 'content/att/' ? ['content/att/migration', 'content/att/orphan-copy'] : ['content-upload/active', 'content-upload/stale']
    return keys.map(key => ({ key, upload_id: 'upload', initiated: new Date(0) }))
  },
  delete_object: async (bucket: string, key: string) => { state.deleted.push(`${bucket}:${key}`) },
  abort_multipart_upload: async (bucket: string, key: string) => { state.aborted.push(`${bucket}:${key}`) },
}))

afterEach(() => {
  vi.restoreAllMocks()
  state.current_only = false
})

describe('retired cleanup writer', () => {
  it('refuses to treat the current OSS bucket as a historical S3 source', async () => {
    vi.resetModules()
    state.current_only = true
    state.listed = 0
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'cleanup'])
    await expect(import('./audit')).rejects.toThrow('旧 S3 已退出')
    expect(state.listed).toBe(0)
  })
  it('reports candidates without deleting objects or aborting uploads', async () => {
    vi.resetModules()
    state.deleted = []
    state.aborted = []
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'cleanup'])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await import('./audit')
    expect(log).toHaveBeenCalledTimes(1)
    const report = JSON.parse(log.mock.calls[0]![0])
    expect(report.mode).toBe('report')
    expect(report.unreferenced_attachment_objects.map((object: { key: string }) => object.key)).toEqual(['content/att/orphan', 'content/att/late'])
    expect(report.expired_multipart_uploads.map((object: { key: string }) => object.key)).toEqual(['content-upload/stale', 'content/att/orphan-copy'])
    expect(state.deleted).toEqual([])
    expect(state.aborted).toEqual([])
  })

  it('refuses deletion before touching objects', async () => {
    vi.resetModules()
    state.deleted = []
    state.aborted = []
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'cleanup', '--delete'])
    await expect(import('./audit')).rejects.toThrow('旧回收写入已退休')
    expect(state.deleted).toEqual([])
    expect(state.aborted).toEqual([])
  })
})
