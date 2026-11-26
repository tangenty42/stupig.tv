import type { UserRow } from '@server/services/profile.service'
import type { AuthUser } from '@server/types/auth'
import type { H3Event } from 'h3'
import { DatabaseSync } from 'node:sqlite'
import { ApiError } from '@server/errors/ApiError'
import { verify_password } from '@server/lib/password'
import { settings } from '@shared/settings'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  put_object: vi.fn(),
  execute: vi.fn(),
  remove: vi.fn(),
  target: vi.fn(),
  user: vi.fn(),
  check_otp: vi.fn(),
  sessions: vi.fn(),
  logout: vi.fn(),
  publish: vi.fn(),
  has_password_setup_proof: vi.fn(),
  clear_password_setup_proof: vi.fn(),
}))

vi.mock('@server/services/auth-guards.service', () => ({ resolve_operate_target: mocks.target, require_auth_user: mocks.user }))

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
vi.mock('@server/lib/session', () => ({
  has_password_setup_proof: mocks.has_password_setup_proof,
  clear_password_setup_proof: mocks.clear_password_setup_proof,
}))
vi.mock('@server/lib/sms', () => ({
  check_otp_sms: mocks.check_otp,
}))
vi.mock('@server/lib/sync', () => ({
  publish_refresh: mocks.publish,
  sync_resource: vi.fn(),
}))
vi.mock('@server/services/session.service', () => ({
  logout_session: mocks.logout,
  get_login_sessions: mocks.sessions,
}))
vi.mock('@config/loader', () => ({
  runtime_config: () => ({ app: { online: { timeoutSeconds: 16 } } }),
}))

const { format_profile_row, list_sitemap_user_ids, upload_profile_avatar } = await import('@server/services/profile.service')
const { profile_router } = await import('@server/trpc/routers/profile')

it('includes unfilled profiles in the sitemap and excludes banned accounts', async () => {
  using users = new DatabaseSync(':memory:')
  users.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, is_banned INTEGER, birthday TEXT, avatar_file TEXT)')
  const insert = users.prepare('INSERT INTO users VALUES (?, ?, ?, ?)')
  insert.run(1, 0, null, null)
  insert.run(2, 1, '2000-01-01', 'avatar.jpg')
  insert.run(3, 0, '2000-01-01', 'avatar.jpg')
  mocks.execute.mockImplementationOnce(async (sql: string) => [users.prepare(sql).all()])

  expect(await list_sitemap_user_ids()).toEqual([1, 3])
})

describe('profile visibility', () => {
  const row = { id: 7, username: 'alice', phone: '13800138001', permissions: null } as UserRow
  const viewer = (overrides: Partial<AuthUser>): AuthUser => ({
    id: 1, session_id: 5, username: 'viewer', phone: '13800138000', avatar_file: null, is_verified: false, is_admin: false, permissions: [], ... overrides,
  })

  it.each([
    ['a visitor', null, null, false, false],
    ['another user', viewer({}), null, false, false],
    ['a console reader', viewer({ permissions: [{ field: 'admin_access', level: 'readonly' }] }), row.phone, true, false],
    ['a stored full console grant', viewer({ permissions: [{ field: 'admin_access', level: 'full' }] }), null, false, false],
    ['the owner', viewer({ id: 7 }), row.phone, true, true],
    ['an administrator', viewer({ is_admin: true }), row.phone, true, true],
  ])('shows sensitive fields to %s as permitted', (_name, auth_user, phone, sensitive_readable, editable) => {
    expect(format_profile_row(auth_user, row, row.id)).toMatchObject({ phone, sensitive_readable, editable })
  })

  it('exposes the verification note only while the account is verified, including legacy rows', () => {
    const user = { ... row, is_verified: 0, verified_note: '旧认证说明' }
    expect(format_profile_row(null, user, user.id).verified_note).toBeNull()
    expect(format_profile_row(null, { ... user, is_verified: 1 }, user.id).verified_note).toBe('旧认证说明')
  })

  it('reads another account\'s sessions at the console read level and revokes them only at the operate level', async () => {
    mocks.target.mockReset().mockResolvedValue({ auth_user: viewer({ is_admin: true }), target_id: 7 })
    mocks.sessions.mockReset().mockResolvedValue({ records: [] })
    mocks.execute.mockReset().mockResolvedValueOnce([[{ user_id: 7 }]])
    const event = { context: {} } as H3Event
    const caller = profile_router.createCaller({ event })
    await caller.getSessions({ operate_for: 7 })
    expect(mocks.target).toHaveBeenLastCalledWith(event, 7, 'readonly')
    expect(mocks.sessions).toHaveBeenCalledWith(7, null)
    await caller.forceLogoutSession({ id: 3, operate_for: 7 })
    expect(mocks.target).toHaveBeenLastCalledWith(event, 7)
    expect(mocks.logout).toHaveBeenLastCalledWith(3)
  })

  it.each([false, true])('refuses to revoke the calling session and allows another session (admin=%s)', async (is_admin) => {
    const actor = viewer({ is_admin })
    mocks.target.mockResolvedValue({ auth_user: actor, target_id: actor.id })
    mocks.execute.mockResolvedValue([[{ user_id: actor.id }]])
    mocks.logout.mockClear()
    mocks.publish.mockClear()
    const caller = profile_router.createCaller({ event: { context: {} } as H3Event })

    await expect(caller.forceLogoutSession({ id: actor.session_id })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.logout).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()

    const other_session_id = 12
    await caller.forceLogoutSession({ id: other_session_id })
    expect(mocks.logout).toHaveBeenCalledExactlyOnceWith(other_session_id)
  })
})

describe('profile changes', () => {
  const owner = { id: 7, phone: '13800000007', is_admin: false }
  const event = { context: {} } as H3Event
  const caller = profile_router.createCaller({ event })
  const phone = { new_phone: '13900000001', old_otp: '245692', new_otp: '927482' }
  const password = { new_password: 'Changed!953', confirm_new_password: 'Changed!953' }

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.user.mockResolvedValue(owner)
    mocks.check_otp.mockImplementation(async ({ phone: number, code }) => {
      if (! ((number === owner.phone && code === phone.old_otp) || (number === phone.new_phone && code === phone.new_otp)))
        throw new ApiError(400, 'Invalid code')
    })
  })

  it.each(['old_otp', 'new_otp'] as const)('requires a valid %s before changing the phone', async (field) => {
    await expect(caller.changePhone({ ... phone, [field]: '000000' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('refuses a number already in use and accepts an available number after verifying both codes', async () => {
    mocks.execute.mockResolvedValueOnce([[{ id: 12 }]])
    await expect(caller.changePhone(phone)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('SELECT id FROM users WHERE phone = ? AND id != ?'), [phone.new_phone, owner.id])

    mocks.execute.mockResolvedValueOnce([[]])
    mocks.check_otp.mockClear()
    await caller.changePhone(phone)
    expect(mocks.check_otp.mock.calls).toEqual([
      [{ phone: owner.phone, code: phone.old_otp }],
      [{ phone: phone.new_phone, code: phone.new_otp }],
    ])
    expect(mocks.execute).toHaveBeenLastCalledWith('UPDATE users SET phone = ? WHERE id = ?', [phone.new_phone, owner.id])
  })

  it('requires the owner\'s SMS code to set a password without the old password', async () => {
    await expect(caller.changePasswordByOtp({ ... password, otp: '000000' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.execute).not.toHaveBeenCalled()
    await caller.changePasswordByOtp({ ... password, otp: phone.old_otp })
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith('UPDATE users SET password_hash = ? WHERE id = ?', [expect.any(String), owner.id])
    expect(await verify_password(password.new_password, mocks.execute.mock.calls[0]![1][0])).toBe(true)
  })

  it('requires proof from SMS login before setting an initial password', async () => {
    mocks.has_password_setup_proof.mockReturnValue(false)
    await expect(caller.setInitialPassword(password)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.has_password_setup_proof).toHaveBeenCalledWith(event, owner.phone)
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('sets a password once without another SMS and preserves all bytes', async () => {
    mocks.has_password_setup_proof.mockReturnValue(true)
    using users = new DatabaseSync(':memory:')
    users.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, phone TEXT, is_banned INTEGER, password_hash TEXT);
      INSERT INTO users VALUES (7, '13800000007', 0, NULL);`)
    mocks.execute.mockImplementation(async (sql: string, params: string[]) => [{ affectedRows: users.prepare(sql).run(... params).changes }])
    const prefix = '春风夏雨秋月冬雪'.repeat(3)
    const new_password = `${prefix}山`
    await caller.setInitialPassword({ new_password, confirm_new_password: new_password })
    await expect(caller.setInitialPassword(password)).rejects.toMatchObject({ code: 'CONFLICT' })
    const row = users.prepare('SELECT password_hash FROM users WHERE id = 7').get()
    expect(await verify_password(new_password, row!.password_hash as string)).toBe(true)
    expect(await verify_password(`${prefix}海`, row!.password_hash as string)).toBe(false)
    expect(mocks.check_otp).not.toHaveBeenCalled()
    expect(mocks.clear_password_setup_proof).toHaveBeenCalledExactlyOnceWith(event)
  })

  it('lets an administrator change another account\'s credentials, birthday and avatar', async () => {
    const admin = { id: 99, is_admin: true }
    mocks.user.mockResolvedValue(admin)
    mocks.target.mockResolvedValue({ auth_user: admin, target_id: owner.id })
    await caller.resetPasswordFor({ operate_for: owner.id, ... password })
    expect(mocks.execute).toHaveBeenLastCalledWith('UPDATE users SET password_hash = ? WHERE id = ?', [expect.any(String), owner.id])
    expect(await verify_password(password.new_password, mocks.execute.mock.calls[0]![1][0])).toBe(true)
    mocks.execute.mockResolvedValueOnce([[]])
    await caller.changePhoneFor({ operate_for: owner.id, new_phone: phone.new_phone })
    expect(mocks.execute).toHaveBeenLastCalledWith('UPDATE users SET phone = ? WHERE id = ?', [phone.new_phone, owner.id])
    expect(mocks.check_otp).not.toHaveBeenCalled()

    const birthday = '2000-02-03T00:00:00.000Z'
    await caller.updateBirthday({ operate_for: owner.id, birthday })
    expect(mocks.target).toHaveBeenCalledExactlyOnceWith(event, owner.id)
    expect(mocks.execute).toHaveBeenLastCalledWith('UPDATE users SET birthday = ? WHERE id = ?', [new Date(birthday), owner.id])

    const form = new FormData()
    form.append('operate_for', String(owner.id))
    form.append('avatar', new Blob(['image'], { type: 'image/png' }), 'photo.png')
    mocks.put_object.mockResolvedValue('new-etag')
    mocks.execute.mockResolvedValueOnce([[{ avatar_file: null }]])
    mocks.target.mockClear()
    await caller.uploadAvatar(form)
    expect(mocks.target).toHaveBeenCalledExactlyOnceWith(event, owner.id)
    expect(mocks.execute).toHaveBeenLastCalledWith(expect.stringContaining('UPDATE users SET avatar_file'), [expect.stringMatching(/^7-.*\.png$/), 'new-etag', owner.id])
  })
})

describe('upload_profile_avatar', () => {
  beforeEach(() => {
    mocks.put_object.mockReset()
    mocks.execute.mockReset()
    mocks.remove.mockReset()
    mocks.target.mockReset().mockResolvedValue({ target_id: 7 })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('enforces the settings limit through the real route before reading or storing bytes', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: {} }))
    mocks.put_object.mockResolvedValue('etag-new')
    mocks.execute.mockResolvedValueOnce([[{ avatar_file: null }]]).mockResolvedValueOnce([{}])
    const form = new FormData()
    form.append('avatar', new Blob([new Uint8Array(settings.app.avatar.maxSizeMb * 1024 ** 2 + 1)], { type: 'image/jpeg' }), 'avatar.jpg')
    const read = vi.spyOn(form.get('avatar') as Blob, 'arrayBuffer')
    const caller = profile_router.createCaller({ event: { context: {} } as H3Event })
    await expect(caller.uploadAvatar(form)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
    expect(read).not.toHaveBeenCalled()
    expect(mocks.put_object).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('rejects an avatar larger than the configured limit before writing to storage', async () => {
    const form = new FormData()
    form.append('avatar', new Blob([new Uint8Array(settings.app.avatar.maxSizeMb * 1024 ** 2 + 1)], { type: 'image/jpeg' }), 'avatar.jpg')
    const read = vi.spyOn(form.get('avatar') as Blob, 'arrayBuffer')

    await expect(upload_profile_avatar(7, form))
      .rejects.toMatchObject({ statusCode: 413 })
    expect(mocks.put_object).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('accepts the exact size limit through the real route', async () => {
    mocks.put_object.mockResolvedValue('etag-new')
    mocks.execute.mockResolvedValueOnce([[{ avatar_file: null }]]).mockResolvedValueOnce([{}])
    const form = new FormData()
    const limit = settings.app.avatar.maxSizeMb * 1024 ** 2
    form.append('avatar', new Blob([new Uint8Array(limit)], { type: 'image/png' }), 'avatar.png')
    const caller = profile_router.createCaller({ event: { context: {} } as H3Event })
    await expect(caller.uploadAvatar(form)).resolves.toBeUndefined()
    expect(mocks.put_object).toHaveBeenCalledOnce()
    expect(mocks.put_object.mock.calls[0]![1].length).toBe(limit)
  })

  it('publishes a new immutable avatar key and removes the previous avatar through OSS', async () => {
    mocks.put_object.mockResolvedValue('etag-new')
    mocks.execute.mockResolvedValueOnce([[{ avatar_file: '7.jpg' }]]).mockResolvedValueOnce([{}])
    const form = new FormData()
    form.append('avatar', new Blob(['image'], { type: 'image/png' }), 'avatar.png')
    await upload_profile_avatar(7, form)
    const key = mocks.put_object.mock.calls[0]![0]
    expect(key).toMatch(/^avatar\/7-[a-f0-9-]{36}\.png$/)
    expect(mocks.execute).toHaveBeenLastCalledWith(expect.stringContaining('UPDATE users'), [key.slice('avatar/'.length), 'etag-new', 7])
    expect(mocks.remove).toHaveBeenCalledWith('avatar/7.jpg')
    expect(mocks.put_object.mock.invocationCallOrder[0]).toBeLessThan(mocks.execute.mock.invocationCallOrder[1]!)
  })
})
