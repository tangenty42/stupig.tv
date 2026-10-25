import type { AuthUser } from '@server/types/auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  story: {} as Record<string, unknown>, title_revision: 4, cover_key: 'cover-a',
  execute: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
}))
vi.mock('@server/lib/db', () => ({ db: {
  execute: mocks.execute,
  getConnection: async () => ({ execute: mocks.execute, beginTransaction: vi.fn(), commit: mocks.commit, rollback: mocks.rollback, release: mocks.release }),
} }))
vi.mock('@server/lib/storage', () => ({ delete_object_best_effort: vi.fn() }))
vi.mock('@server/lib/sync', () => ({ publish_refresh: vi.fn(), sync_resource: (type: string, id: number) => `${type}:${id}` }))

const { get_story_body, list_stories } = await import('./story.service')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.title_revision = 4
  mocks.cover_key = 'cover-a'
  mocks.story = {
    id: 1, title: 'story', label: 'one two', description: '', cover: 'cover.png', cover_label: '', cover_version: 'etag',
    event_precision: 'day', event_dates: '["2026-10-14"]',
    markdown: 'public\n\n<good>\nsecret\n</good>\n', revision: 9, namespace_revision: 3,
    created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z',
  }
  mocks.execute.mockImplementation(async (sql: string) => {
    if (sql.includes('content_title_namespace'))
      return [[{ revision: mocks.title_revision, revision_floor: 0 }]]
    if (sql.includes('FROM content_stories'))
      return [[mocks.story].filter(row => row.id)]
    if (sql.includes('FROM content_story_attachments')) {
      return [[{ story_id: 1, file_name: 'cover.png', object_key: mocks.cover_key, avif_key: mocks.cover_key, jpeg_key: 'jpeg',
        image_revision: 1, image_metadata: { width: 60, height: 40 }, lqip_jpeg: Buffer.from([255, 216, 255, 217]) }]]
    }
    throw new Error(`Unexpected body query: ${sql}`)
  })
})

describe('independent viewer-specific story body', () => {
  it('includes the same public cover dimensions and LQIP in the homepage list and story body', async () => {
    const [summary] = await list_stories()
    const body = await get_story_body(1, null)
    expect(summary?.cover_image).toMatchObject({ width: 60, height: 40, lqip: 'data:image/jpeg;base64,/9j/2Q==' })
    expect(body?.cover_image).toEqual(summary?.cover_image)
    expect(body?.cover_url).toBe(summary?.cover_url)
  })
  it('returns only the body projection and a scoped cover lookup, without attachment keys or task resources', async () => {
    const body = await get_story_body(1, null)
    expect(body).toMatchObject({ id: 1, revision: 9, namespace_revision: 3, title_revision: 4, viewer_key: 'anon:false', private_readable: false, has_private: true })
    expect(body?.markdown).not.toContain('secret')
    for (const field of ['attachments', 'folders', 'tasks', 'operation_lock', 'encryption_key'])
      expect(body).not.toHaveProperty(field)
    expect(mocks.execute.mock.calls.every(([sql]) => String(sql).startsWith('SELECT'))).toBe(true)
    expect(mocks.execute.mock.calls.some(([sql]) => /content_tasks|SELECT[^F]*encryption_key/.test(String(sql)))).toBe(false)
    expect(mocks.execute.mock.calls.filter(([sql]) => String(sql).includes('content_story_attachments'))).toHaveLength(1)
    expect(mocks.execute.mock.calls.find(([sql]) => String(sql).includes('content_story_attachments'))?.[1]).toEqual([1, 'cover.png'])
    expect(mocks.commit).toHaveBeenCalledOnce()
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('checks server viewer identity even when the caller supplies an authorized body hash', async () => {
    const admin = await get_story_body(1, { id: 7, is_admin: true } as AuthUser)
    expect(admin?.markdown).toContain('secret')
    expect(await get_story_body(1, { id: 7, is_admin: true } as AuthUser, admin!.representation_version)).toBeNull()
    const guest = await get_story_body(1, null, admin!.representation_version)
    expect(guest).not.toBeNull()
    expect(guest?.markdown).not.toContain('secret')
    expect(guest?.representation_version).not.toBe(admin?.representation_version)
  })

  it('detects two mechanical body changes within the same second and cover replacement with the same etag', async () => {
    const body = await get_story_body(1, null)
    mocks.story.markdown = 'public changed\n\n<good>\nsecret\n</good>\n'
    const changed = await get_story_body(1, null, body!.representation_version)
    expect(changed?.updated_at).toBe(body?.updated_at)
    expect(changed?.revision).toBe(body?.revision)
    expect(changed?.representation_version).not.toBe(body?.representation_version)
    mocks.cover_key = 'cover-b'
    const cover = await get_story_body(1, null, changed!.representation_version)
    expect(cover?.cover_version).toBe(changed?.cover_version)
    expect(cover?.cover_url).not.toBe(changed?.cover_url)
  })

  it('keeps unrelated namespace and title changes out of body freshness', async () => {
    const body = await get_story_body(1, null)
    mocks.story.namespace_revision = 12
    mocks.title_revision = 20
    expect(await get_story_body(1, null, body!.representation_version)).toBeNull()
    const fresh = await get_story_body(1, null)
    expect(fresh).toMatchObject({ namespace_revision: 12, title_revision: 20, representation_version: body!.representation_version })
  })

  it('rolls back and releases a missing story', async () => {
    mocks.story = {}
    await expect(get_story_body(1, null)).rejects.toMatchObject({ statusCode: 404 })
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(mocks.rollback).toHaveBeenCalledOnce()
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})
