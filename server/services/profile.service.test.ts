import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  put_object: vi.fn(),
  execute: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('@server/lib/static-storage', () => ({
  delete_avatar_best_effort: mocks.remove,
  put_avatar: mocks.put_object,
}))
vi.mock('@server/lib/db', () => ({
  db: {
    execute: mocks.execute,
  },
}))
vi.mock('@server/lib/captcha', () => ({
  verify_captcha: vi.fn(),
}))
vi.mock('@server/lib/sms', () => ({
  check_otp_sms: vi.fn(),
}))
vi.mock('@server/lib/sync', () => ({
  publish_refresh: vi.fn(),
  sync_resource: vi.fn(),
}))
vi.mock('@server/services/session.service', () => ({
  logout_session: vi.fn(),
}))
vi.mock('@config/loader', () => ({
  runtime_config: () => ({ app: { auth: { bcryptRounds: 10 }, online: { timeoutSeconds: 16 } } }),
}))

const { upload_profile_avatar } = await import('@server/services/profile.service')

describe('upload_profile_avatar', () => {
  beforeEach(() => {
    mocks.put_object.mockReset()
    mocks.execute.mockReset()
    mocks.remove.mockReset()
  })

  it('rejects an avatar larger than the configured limit before writing to storage', async () => {
    const form = new FormData()
    form.append('avatar', new Blob([new Uint8Array(1024 * 1024 + 1)], { type: 'image/jpeg' }), 'avatar.jpg')

    await expect(upload_profile_avatar(7, form, () => ({ max_size_mb: 1 })))
      .rejects.toMatchObject({ statusCode: 413, message: '头像文件太大了，不能超过 1 MB' })
    expect(mocks.put_object).not.toHaveBeenCalled()
  })

  it('publishes a new immutable avatar key and removes the previous avatar through OSS', async () => {
    mocks.put_object.mockResolvedValue('etag-new')
    mocks.execute.mockResolvedValueOnce([[{ avatar_file: '7.jpg' }]]).mockResolvedValueOnce([{}])
    const form = new FormData()
    form.append('avatar', new Blob(['image'], { type: 'image/png' }), 'avatar.png')
    await upload_profile_avatar(7, form, () => ({ max_size_mb: 1 }))
    const key = mocks.put_object.mock.calls[0]![0]
    expect(key).toMatch(/^avatar\/7-[a-f0-9-]{36}\.png$/)
    expect(mocks.execute).toHaveBeenLastCalledWith(expect.stringContaining('UPDATE users'), [key.slice('avatar/'.length), 'etag-new', 7])
    expect(mocks.remove).toHaveBeenCalledWith('avatar/7.jpg')
    expect(mocks.put_object.mock.invocationCallOrder[0]).toBeLessThan(mocks.execute.mock.invocationCallOrder[1]!)
  })
})
