import { ApiError } from '@server/errors/ApiError'
import { beforeEach, expect, it, vi } from 'vitest'
import { ban_user, set_profile_verification, set_user_admin_role, set_user_permissions, unban_user } from './admin.service'

const mocks = vi.hoisted(() => ({ execute: vi.fn(), publish: vi.fn(), logout_all: vi.fn() }))
vi.mock('@config/loader', () => ({ runtime_config: () => ({}) }))
vi.mock('@server/lib/db', () => ({ db: { execute: mocks.execute } }))
vi.mock('@server/lib/sync', () => ({ publish_refresh: mocks.publish, sync_resource: (kind: string, id: number) => `${kind}:${id}` }))
vi.mock('@server/services/session.service', () => ({ logout_all_user_sessions: mocks.logout_all }))
vi.mock('@server/services/profile.service', () => ({ format_profile_row: vi.fn(), select_profile_row_sql: '' }))

beforeEach(() => vi.resetAllMocks())

it('rejects self-demotion before changing the account', async () => {
  await expect(set_user_admin_role(2, 2, false)).rejects.toMatchObject({ statusCode: 400, message: '不能移除自己的管理员身份', public_data: { code: 'ADMIN_TARGET_REJECTED' } })
  expect(mocks.execute).not.toHaveBeenCalled()
  expect(mocks.publish).not.toHaveBeenCalled()
})

it('rejects a self-ban before writing or revoking sessions', async () => {
  await expect(ban_user(2, 2)).rejects.toMatchObject({ statusCode: 400, message: '不能封禁自己', public_data: { code: 'ADMIN_TARGET_REJECTED' } })
  expect(mocks.execute).not.toHaveBeenCalled()
  expect(mocks.logout_all).not.toHaveBeenCalled()
  expect(mocks.publish).not.toHaveBeenCalled()
})

it.each([true, false])('rejects a missing role target before the update (is_admin=%s)', async (is_admin) => {
  mocks.execute.mockResolvedValueOnce([[]])
  await expect(set_user_admin_role(2, 7, is_admin)).rejects.toMatchObject({ statusCode: 404, message: '用户不存在', public_data: { code: 'ADMIN_TARGET_REJECTED' } })
  expect(mocks.execute).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('SELECT is_admin'), [7])
  expect(mocks.publish).not.toHaveBeenCalled()
})

it('rejects a missing permission target before the update', async () => {
  mocks.execute.mockResolvedValueOnce([[]])
  await expect(set_user_permissions(7, [])).rejects.toMatchObject({ statusCode: 404, message: '用户不存在', public_data: { code: 'ADMIN_TARGET_REJECTED' } })
  expect(mocks.execute).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('SELECT is_admin'), [7])
  expect(mocks.publish).not.toHaveBeenCalled()
})

it.each([undefined, null, '', ' \n '])('rejects a missing verification note before the update: %j', async (note) => {
  await expect(set_profile_verification(7, true, note)).rejects.toMatchObject({ statusCode: 400, message: '请填写认证说明', public_data: { code: 'ADMIN_TARGET_REJECTED' } })
  expect(mocks.execute).not.toHaveBeenCalled()
  expect(mocks.publish).not.toHaveBeenCalled()
})

it('promotes the target and clears their grants in the same update', async () => {
  mocks.execute.mockResolvedValueOnce([[{ is_admin: 0 }]])
  await set_user_admin_role(2, 7, true)
  expect(mocks.execute).toHaveBeenLastCalledWith(
    'UPDATE users SET is_admin = ?, permissions = IF(?, NULL, permissions) WHERE id = ?',
    [1, 1, 7],
  )
  expect(mocks.publish).toHaveBeenCalledWith({ resource: 'auth_user:7' })
})

it('rejects editing the permissions of an administrator after reading the target', async () => {
  mocks.execute.mockResolvedValueOnce([[{ is_admin: 1 }]])
  await expect(set_user_permissions(7, [])).rejects.toMatchObject({ statusCode: 400, message: '管理员拥有全部权限，无需编辑权限', public_data: { code: 'ADMIN_TARGET_REJECTED' } })
  expect(mocks.execute).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('SELECT is_admin'), [7])
  expect(mocks.publish).not.toHaveBeenCalled()
})

it('preserves a target-read failure without marking a business rejection', async () => {
  const failure = new Error('database unavailable')
  mocks.execute.mockRejectedValueOnce(failure)
  await expect(set_user_admin_role(2, 7, true)).rejects.toBe(failure)
  expect(failure).not.toHaveProperty('public_data')
  expect(mocks.execute).toHaveBeenCalledOnce()
  expect(mocks.publish).not.toHaveBeenCalled()
})

it('preserves an update failure without marking a business rejection', async () => {
  const failure = new Error('database response lost')
  mocks.execute.mockResolvedValueOnce([[{ is_admin: 0 }]]).mockRejectedValueOnce(failure)
  await expect(set_user_admin_role(2, 7, true)).rejects.toBe(failure)
  expect(failure).not.toHaveProperty('public_data')
  expect(mocks.execute).toHaveBeenCalledTimes(2)
  expect(mocks.publish).not.toHaveBeenCalled()
})

it('does not mark a session-revocation failure after the ban was written', async () => {
  const failure = new ApiError(400, 'session revocation failed')
  mocks.logout_all.mockRejectedValueOnce(failure)
  await expect(ban_user(2, 7)).rejects.toBe(failure)
  expect(failure.public_data).toBeUndefined()
  expect(mocks.execute).toHaveBeenCalledExactlyOnceWith('UPDATE users SET is_banned = 1 WHERE id = ?', [7])
  expect(mocks.publish).not.toHaveBeenCalled()
})

it('does not mark a notification failure after the role update was written', async () => {
  const failure = new ApiError(404, 'notification target missing')
  mocks.execute.mockResolvedValueOnce([[{ is_admin: 0 }]])
  mocks.publish.mockImplementationOnce(() => {
    throw failure
  })
  await expect(set_user_admin_role(2, 7, true)).rejects.toBe(failure)
  expect(failure.public_data).toBeUndefined()
  expect(mocks.execute).toHaveBeenLastCalledWith(expect.stringContaining('UPDATE users SET is_admin'), [1, 1, 7])
  expect(mocks.publish).toHaveBeenCalledExactlyOnceWith({ resource: 'profile:7' })
})

it('revokes every session of the banned user and restores login eligibility when unbanned', async () => {
  await ban_user(1, 7)
  expect(mocks.execute).toHaveBeenCalledWith('UPDATE users SET is_banned = 1 WHERE id = ?', [7])
  expect(mocks.logout_all).toHaveBeenCalledExactlyOnceWith(7)
  expect(mocks.publish).toHaveBeenCalledWith({ resource: 'profile_sessions:7' })
  expect(mocks.publish).toHaveBeenCalledWith({ resource: 'auth_user:7' })
  await unban_user(7)
  expect(mocks.execute).toHaveBeenLastCalledWith('UPDATE users SET is_banned = 0 WHERE id = ?', [7])
  expect(mocks.logout_all).toHaveBeenCalledOnce()
})
