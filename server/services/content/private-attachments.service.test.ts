import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  row: {} as Record<string, unknown>, namespace: 0, configured: true, actor_allowed: true,
  markdown: '[](att://a.png)', cover: '', copied: '', racing: false, revoke: false, commit_lost: false,
  transaction: false, migration_backup: false, writes: [] as string[], events: [] as unknown[],
  copy: vi.fn(), delete: vi.fn(), sign: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
  aliyun_acl: vi.fn(), aliyun_delete: vi.fn(),
}))
vi.mock('@server/lib/aliyun-oss', () => ({ create_aliyun_oss: () => ({ set_object_access: state.aliyun_acl, soft_delete_object: state.aliyun_delete }) }))
vi.mock('@server/lib/db', () => {
  const execute = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM users'))
      return [[{ id: 7, is_admin: state.actor_allowed ? 1 : 0, is_banned: 0, permissions: [] }]]
    if (sql.includes('UNION SELECT attachment_id'))
      return [state.row.object_key === params[0] ? [{ id: 11 }] : []]
    if (sql.startsWith('SELECT attachment_id FROM content_attachment_storage_migrations'))
      return [state.migration_backup ? [{ attachment_id: 11 }] : []]
    if (sql.startsWith('SELECT file_name'))
      return [[{ file_name: state.row.file_name }]]
    if (sql.includes('FROM content_story_attachments'))
      return [state.row.id ? [structuredClone(state.row)] : []]
    if (sql.includes('FROM content_stories'))
      return [[{ namespace_revision: state.namespace, markdown: state.markdown, cover: state.cover, cover_version: null }]]
    state.writes.push(sql)
    if (sql.startsWith('UPDATE content_story_attachments SET file_name = ?, is_private'))
      Object.assign(state.row, { file_name: params[0], is_private: params[1] })
    else if (sql.startsWith('UPDATE content_story_attachments'))
      Object.assign(state.row, { file_name: params[0], object_key: params[1], version: params[2], is_private: params[3], encryption_key: null })
    if (sql.startsWith('UPDATE content_stories SET markdown'))
      state.markdown = String(params[0])
    if (sql.startsWith('UPDATE content_stories SET namespace_revision'))
      state.namespace ++
    return [{ affectedRows: 1 }]
  }
  return { db: { execute, getConnection: async () => ({ execute,
    beginTransaction: async () => { state.transaction = true },
    commit: async () => {
      state.commit()
      state.transaction = false
      if (state.commit_lost)
        throw new Error('commit acknowledgement lost')
    },
    rollback: async () => {
      state.rollback()
      state.transaction = false
    },
    release: state.release,
  }) } }
})
vi.mock('@server/lib/sync', () => ({ publish_refresh: (event: unknown) => state.events.push(event), sync_resource: (kind: string, id: unknown) => `${kind}:${id}` }))
vi.mock('@server/lib/storage', () => ({
  copy_between_buckets: state.copy, delete_object_best_effort: state.delete, signed_object_url: state.sign,
  storage_bucket_name: (bucket: string) => {
    if (bucket === 'private' && ! state.configured)
      throw Object.assign(new Error('unconfigured'), { statusCode: 503 })
    return `${bucket}-bucket`
  },
}))
const { dispose_unadopted_attachment_object } = await import('./private-attachments.service')

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(state, { namespace: 0, configured: true, actor_allowed: true, markdown: '[](att://a.png)', cover: '', racing: false, revoke: false, commit_lost: false, transaction: false, migration_backup: false, writes: [], events: [] })
  state.row = { id: 11, story_id: 1, file_name: 'a.png', is_folder: 0, object_key: 'old', version: 'old-version', file_size: 20, encryption_key: null, is_private: 0, storage_bucket: 'private' }
  state.copy.mockImplementation(async (_source_bucket, _source, _target_bucket, target) => {
    expect(state.transaction).toBe(false)
    state.copied = target
    if (state.racing)
      state.row.version = 'new-version'
    if (state.revoke)
      state.actor_allowed = false
    return 'copied-version'
  })
  state.sign.mockResolvedValue('https://signed.private.test')
})

describe('offline migration compensation', () => {
  it('uses a delete marker only for an unreferenced Aliyun object', async () => {
    state.row.storage_provider = 'aliyun'
    await dispose_unadopted_attachment_object('private', 'old', 'aliyun')
    expect(state.aliyun_delete).not.toHaveBeenCalled()
    state.row.id = 0
    await dispose_unadopted_attachment_object('private', 'old', 'aliyun')
    expect(state.aliyun_delete).toHaveBeenCalledExactlyOnceWith('old')
    expect(state.delete).not.toHaveBeenCalled()
  })
})
