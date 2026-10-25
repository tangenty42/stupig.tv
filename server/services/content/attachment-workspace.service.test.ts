import type { AuthUser } from '@server/types/auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  missing: false,
  private_plaintext: false,
  redacted: false,
  execute: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
}))
vi.mock('@server/lib/db', () => ({ db: {
  getConnection: async () => ({ execute: mocks.execute, beginTransaction: vi.fn(), commit: mocks.commit, rollback: mocks.rollback, release: mocks.release }),
} }))

const { get_attachment_workspace } = await import('./attachment-workspace.service')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.missing = false
  mocks.private_plaintext = true
  mocks.redacted = false
  mocks.execute.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM content_stories'))
      return [mocks.missing ? [] : [{ namespace_revision: 3 }]]
    const root = { id: 1, story_id: 1, parent_id: 0, name: '', name_key: '', file_name: '', is_folder: 1, node_revision: 1 }
    const folder = { ... root, id: 2, parent_id: 1, name: 'folder', name_key: 'folder', file_name: 'folder' }
    const file = { id: 11, story_id: 1, parent_id: 2, name: 'private.png.good', name_key: 'private.png.good', file_name: 'folder/private.png.good', is_folder: 0, object_key: 'key', storage_provider: 'aliyun', storage_bucket: 'public', oss_version_id: 'v1', mime_type: 'image/png', file_size: 12, version: 'v1', encryption_key: mocks.private_plaintext ? null : 'secret-key', is_private: 1, node_revision: 1 }
    Object.assign(file, { avif_key: 'key', jpeg_key: 'fallback', image_revision: 1, image_metadata: { width: 40, height: 30 }, lqip_jpeg: Buffer.from([255, 216, 255, 217]) })
    if (mocks.redacted) {
      Object.assign(file, { redacted_avif_key: 'redacted', redacted_jpeg_key: 'redacted-jpg', redacted_revision: 2,
        redacted_metadata: { width: 12, height: 8 }, redacted_lqip_jpeg: Buffer.from([255, 216, 0, 255, 217]) })
    }
    return [sql.includes('is_folder = 0') ? [file] : [root, folder, file]]
  })
})

describe('independent attachment workspace snapshot', () => {
  it('exposes only the same-row public redaction presentation to a guest', async () => {
    mocks.redacted = true
    const guest = await get_attachment_workspace(1, null)
    expect(guest.attachments).toHaveLength(1)
    const file = guest.attachments[0]!
    expect(file).toMatchObject({ id: 11, is_private: true, has_redacted: true, url: null,
      redacted_image: { width: 12, height: 8, revision: 2, has_original: false } })
    expect(file).not.toHaveProperty('image')
    expect(file.redacted_url).toContain('&role=redacted')
    expect(JSON.stringify(file)).not.toContain('fallback')
    expect(file.redacted_image?.lqip).not.toBe('data:image/jpeg;base64,/9j/2Q==')
  })
  it('projects new private plaintext as a guarded address only for an authorized viewer', async () => {
    mocks.private_plaintext = true
    const guest = await get_attachment_workspace(1, null)
    expect(guest.attachments[0]).toMatchObject({ is_private: true, is_encrypted: false, url: null })
    expect(guest.attachments[0]).not.toHaveProperty('image')
    const admin = await get_attachment_workspace(1, { id: 7, is_admin: true } as AuthUser)
    expect(admin.attachments[0]?.url).toMatch(/^\/api\/content\/attachments\/11\?version=[\da-f]{64}$/)
    expect(admin.attachments[0]?.image?.lqip).toBe('data:image/jpeg;base64,/9j/2Q==')
    expect(admin.attachments[0]).not.toHaveProperty('encryption_key')
  })
  it('returns a coherent public projection without reading body/title/tasks or sending encryption keys', async () => {
    const result = await get_attachment_workspace(1, null)
    expect(result).toMatchObject({ namespace_revision: 3, viewer_key: 'anon:false', folders: ['folder'] })
    expect(result.attachments[0]).toMatchObject({ id: 11, file_name: 'folder/private.png.good', is_encrypted: false, is_private: true })
    expect(result.attachments[0]).not.toHaveProperty('encryption_key')
    expect(result).not.toHaveProperty('markdown')
    expect(mocks.execute.mock.calls.every(([sql]) => String(sql).startsWith('SELECT'))).toBe(true)
    expect(mocks.execute.mock.calls.some(([sql]) => /markdown|content_tasks|content_title_namespace/.test(String(sql)))).toBe(false)
    expect(mocks.execute.mock.calls[0]?.[0]).toContain('FOR SHARE')
    expect(mocks.commit).toHaveBeenCalledOnce()
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('rejects legacy ciphertext rather than exposing decrypt keys', async () => {
    mocks.private_plaintext = false
    await expect(get_attachment_workspace(1, { id: 7, is_admin: true } as AuthUser)).rejects.toMatchObject({ statusCode: 503 })
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(mocks.rollback).toHaveBeenCalledOnce()
  })

  it('rolls back and releases a missing scope without returning stale data', async () => {
    mocks.missing = true
    await expect(get_attachment_workspace(1, null)).rejects.toMatchObject({ statusCode: 404 })
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(mocks.rollback).toHaveBeenCalledOnce()
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})
