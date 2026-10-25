import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ put: vi.fn(), remove: vi.fn(), log: vi.fn() }))
vi.mock('@server/lib/aliyun-oss', () => ({ create_aliyun_oss: () => ({ put_object: mocks.put, soft_delete_object: mocks.remove }) }))
vi.mock('@server/lib/log', () => ({ log_error: mocks.log }))
const { put_avatar, delete_avatar_best_effort } = await import('./static-storage')

describe('avatar storage', () => {
  beforeEach(() => vi.resetAllMocks())

  it('writes private objects to the current OSS adapter and returns the cache version', async () => {
    mocks.put.mockResolvedValue({ etag: 'new-version' })
    const bytes = new Uint8Array([1, 2])
    expect(await put_avatar('avatar/7.png', bytes, 'image/png')).toBe('new-version')
    expect(mocks.put).toHaveBeenCalledWith('avatar/7.png', bytes, 'image/png', 'private')
  })

  it('rejects keys outside the avatar namespace before any storage access', async () => {
    for (const key of ['content/att/7.png', 'avatar/../7.png', 'avatar/a/b.png']) {
      await expect(put_avatar(key, new Uint8Array(), 'image/png')).rejects.toMatchObject({ statusCode: 400 })
      await expect(delete_avatar_best_effort(key)).rejects.toMatchObject({ statusCode: 400 })
    }
    expect(mocks.put).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('uses recoverable deletion and logs failure without exposing SDK diagnostics', async () => {
    mocks.remove.mockRejectedValue(new Error('sensitive SDK diagnostics'))
    await delete_avatar_best_effort('avatar/7.png')
    expect(mocks.remove).toHaveBeenCalledWith('avatar/7.png')
    expect(mocks.log).toHaveBeenCalledWith('avatar-storage-delete-failed', { key: 'avatar/7.png' })
  })
})
