import type { AuthUser } from '@server/types/auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), sign: vi.fn(),
  connection: vi.fn(),
}))
vi.mock('@server/lib/db', () => ({ db: { execute: mocks.execute, getConnection: mocks.connection } }))
vi.mock('@server/lib/esa', () => ({ create_esa: () => ({ signed_read_url: mocks.sign }) }))
vi.mock('@server/lib/aliyun-oss', () => ({ create_aliyun_oss: () => {
  throw new Error('Content downloads must use ESA')
} }))
vi.mock('@server/lib/sync', () => ({ publish_refresh: vi.fn(), sync_resource: (kind: string, id: number) => `${kind}:${id}` }))
const { create_story, update_story } = await import('./content/story.service')
const { sign_attachment_download } = await import('./content/upload.service')

beforeEach(() => {
  vi.resetAllMocks()
  mocks.sign.mockReturnValue('https://signed.example.test/temporary')
})
describe('strict Content cutover', () => {
  it.each(['create', 'update'])('lets %s reach its transaction without a migration-specific rejection', async (operation) => {
    const markdown = '---\ntitle: 测试\ntime: 2026/10/14\n---\n[](old.png)\n[](@其他档案)'
    const failure = new Error('database boundary unavailable')
    mocks.connection.mockRejectedValueOnce(failure)
    await expect(operation === 'create' ? create_story(7, markdown, true) : update_story(1, markdown, 2, true)).rejects.toBe(failure)
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.connection).toHaveBeenCalledOnce()
  })
  it.each(['docs/report.PDF', '照片.PNG', '报告 (1).pdf'])('signs a named ESA download for %s', async (file_name) => {
    mocks.execute.mockImplementation(async (sql: string) => [sql.includes('FROM content_stories')
      ? [{ id: 1 }]
      : [{
          id: 12, read_revision: 1, file_name, object_key: 'content/att/test', storage_provider: 'aliyun', encryption_key: null, is_private: 0,
        }]])
    expect(await sign_attachment_download(1, file_name)).toEqual({ url: 'https://signed.example.test/temporary' })
    expect(mocks.sign).toHaveBeenCalledWith('content/att/test', expect.any(Number), 'GET', file_name.split('/').pop()!.replace(/\.[^.]+$/, extension => extension.toLowerCase()), 'attachment', expect.objectContaining({ id: 12, session: 0 }))
  })
  it('checks private access on every download request', async () => {
    mocks.execute.mockImplementation(async (sql: string) => [sql.includes('FROM content_stories')
      ? [{ id: 1 }]
      : [{
          id: 12, read_revision: 1, file_name: 'a.png.good', object_key: 'content/att/test', storage_provider: 'aliyun', encryption_key: null, is_private: 1,
        }]])
    await expect(sign_attachment_download(1, 'a.png.good')).rejects.toMatchObject({ statusCode: 403 })
    expect(mocks.sign).not.toHaveBeenCalled()
    await sign_attachment_download(1, 'a.png.good', { id: 1, session_id: 9, token_generation_id: 1, is_admin: true } as AuthUser)
    expect(mocks.sign).toHaveBeenCalledWith('content/att/test', expect.any(Number), 'GET', 'a.png', 'attachment', expect.objectContaining({ id: 12, session: 9 }))
  })
  it.each([{ storage_provider: 'legacy', encryption_key: null }, { storage_provider: 'aliyun', encryption_key: 'old-key' }])('refuses unmigrated storage without issuing any old signature', async (legacy) => {
    mocks.execute.mockImplementation(async (sql: string) => [sql.includes('FROM content_stories')
      ? [{ id: 1 }]
      : [{
          file_name: 'old.png', object_key: 'content/att/test', is_private: 0, ... legacy,
        }]])
    await expect(sign_attachment_download(1, 'old.png')).rejects.toMatchObject({ statusCode: 503 })
    expect(mocks.sign).not.toHaveBeenCalled()
  })
  it('does not sign an unknown story or attachment', async () => {
    mocks.execute.mockResolvedValue([[]])
    await expect(sign_attachment_download(1, 'gone')).rejects.toMatchObject({ statusCode: 404 })
    mocks.execute.mockImplementation(async (sql: string) => [sql.includes('FROM content_stories') ? [{ id: 1 }] : []])
    await expect(sign_attachment_download(1, 'gone')).rejects.toMatchObject({ statusCode: 404 })
    expect(mocks.sign).not.toHaveBeenCalled()
  })
})
