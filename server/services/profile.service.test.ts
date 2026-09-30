import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  put_object: vi.fn(),
}))

vi.mock('@server/lib/storage', () => ({
  delete_object_best_effort: vi.fn(),
  put_object: mocks.put_object,
}))
vi.mock('@server/lib/db', () => ({
  db: {
    execute: vi.fn(),
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
vi.mock('@shared/env', () => ({ env: {} }))

const { upload_profile_avatar } = await import('@server/services/profile.service')

describe('upload_profile_avatar', () => {
  beforeEach(() => {
    mocks.put_object.mockReset()
  })

  it('rejects an avatar larger than the configured limit before writing to storage', async () => {
    const form = new FormData()
    form.append('avatar', new Blob([new Uint8Array(1024 * 1024 + 1)], { type: 'image/jpeg' }), 'avatar.jpg')

    await expect(upload_profile_avatar(7, form, () => ({ max_size_mb: 1 })))
      .rejects.toMatchObject({ statusCode: 413, message: '头像文件太大了，不能超过 1 MB' })
    expect(mocks.put_object).not.toHaveBeenCalled()
  })
})
