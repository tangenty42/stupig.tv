import type { AuthUser } from '@server/types/auth'
import type { H3Event } from 'h3'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_COMMANDS, ADMIN_FILTER_KEYWORDS } from '@shared/admin-command'
import { ADMIN_FILTER_FIELDS } from '@shared/types/user'
import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ execute: vi.fn(), user: vi.fn() }))
vi.mock('@server/lib/db', () => ({ db: { execute: state.execute } }))
vi.mock('@config/loader', () => ({
  runtime_config: () => ({ app: { online: { timeoutSeconds: 16 } } }),
}))
vi.mock('@server/services/auth-guards.service', () => ({ require_auth_user: state.user }))
vi.mock('@server/lib/static-storage', () => ({ put_avatar: vi.fn(), delete_avatar_best_effort: vi.fn() }))
vi.mock('@server/lib/captcha', () => ({ verify_captcha: vi.fn() }))
vi.mock('@server/lib/sms', () => ({ check_otp_sms: vi.fn() }))
vi.mock('@server/lib/sync', () => ({ publish_refresh: vi.fn(), sync_resource: vi.fn() }))
vi.mock('@server/services/session.service', () => ({ logout_session: vi.fn(), logout_all_user_sessions: vi.fn() }))
vi.mock('@server/services/background/status.service', () => ({ get_background_status: vi.fn() }))
vi.mock('@server/services/storage-audit/service', () => ({ get_storage_audit_findings: vi.fn() }))

const { admin_router } = await import('./admin')
const viewer: AuthUser = {
  id: 7, session_id: 11, username: 'reader', phone: '13800138000',
  avatar_file: null, is_verified: false, is_admin: false,
  permissions: [{ field: 'admin_access', level: 'readonly' }],
}
const caller = () => admin_router.createCaller({ event: { context: {} } as H3Event })

beforeEach(() => {
  vi.resetAllMocks()
  state.user.mockResolvedValue(viewer)
  state.execute.mockImplementation(async (sql: string) => sql.includes('COUNT(*)')
    ? [[{ total: 1 }]]
    : [[{ id: 2, username: 'alice', phone: '13800138001', avatar_file: null, avatar_version: null,
        is_verified: 0, is_admin: 0, is_banned: 0, is_online: 0, permissions: null, verified_note: null }]])
})

it.each([
  '1 = (SELECT LENGTH(password_hash) > 0 FROM users LIMIT 1)',
  'EXISTS (SELECT 1 FROM user_login_session_tokens WHERE token_hash IS NOT NULL)',
  'id = 1 OR (SELECT phone FROM users WHERE id = 2) LIKE \'138%\'',
  'password_hash LIKE \'a%\'',
  'user_login_session_tokens.token_hash IS NOT NULL',
  'id = 1 UNION SELECT id FROM users',
  'id = 1; UPDATE users SET is_admin = 1',
  'id = 1 FOR UPDATE',
  'id = 1 INTO OUTFILE \'/tmp/admin-filter-probe\'',
  'SLEEP(1) = 0',
])('rejects unsafe read-only filtering before any database call: %s', async (filter) => {
  await expect(caller().listUsers({ page: 1, page_size: 10, filter }))
    .rejects.toMatchObject({ code: 'BAD_REQUEST' })
  expect(state.execute).not.toHaveBeenCalled()
})

it('uses bound values in both queries and shows phone numbers to a console reader', async () => {
  const result = await caller().listUsers({ page: 2, page_size: 10, filter: 'is_verified = 1 AND username LIKE \'ali%\' ORDER BY username ASC' })
  expect(result).toMatchObject({ total: 1, users: [{ id: 2, phone: '13800138001' }] })
  const [count, rows] = state.execute.mock.calls
  expect(count![0]).toContain('FROM users u WHERE')
  expect(count![0]).not.toContain('ORDER BY')
  expect(count![0]).not.toContain('ali%')
  expect(count![1]).toEqual([1, 'ali%'])
  expect(rows![0]).toContain('ORDER BY u.username ASC')
  expect(rows![1]).toEqual([16, 1, 'ali%', '10', '10'])
})

it('allows a console reader to filter by phone while still forbidding secrets and subqueries', async () => {
  await expect(caller().listUsers({ page: 1, page_size: 10, filter: 'phone = \'13800138001\'' }))
    .resolves.toMatchObject({ users: [{ phone: '13800138001' }] })
  expect(state.execute.mock.calls[0]![1]).toEqual(['13800138001'])
  state.execute.mockClear()
  await expect(caller().listUsers({ page: 1, page_size: 10, filter: 'password_hash LIKE \'%\'' }))
    .rejects.toMatchObject({ code: 'BAD_REQUEST' })
  expect(state.execute).not.toHaveBeenCalled()
})

it('serves the shared command metadata to authorized console readers only', async () => {
  await expect(caller().getKeywords()).resolves.toEqual({
    fields: ADMIN_FILTER_FIELDS,
    keywords: ADMIN_FILTER_KEYWORDS,
    commands: ADMIN_COMMANDS,
  })
  state.user.mockResolvedValue({ ... viewer, permissions: [] })
  await expect(caller().getKeywords()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.execute).not.toHaveBeenCalled()
})

it('reserves every user mutation for administrators, including a stored full console grant', async () => {
  for (const permissions of [viewer.permissions, [{ field: 'admin_access', level: 'full' }]] satisfies AuthUser['permissions'][]) {
    state.user.mockResolvedValue({ ... viewer, permissions })
    await expect(caller().setBanned({ id: 2, banned: true })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller().setVerification({ id: 2, is_verified: true, verified_note: '认证说明' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller().setRole({ id: 7, is_admin: true })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller().setPermissions({ id: 2, permissions: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
  expect(state.execute).not.toHaveBeenCalled()
})

it('grants, edits and removes verification together with its note', async () => {
  using users = new DatabaseSync(':memory:')
  users.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, is_verified INTEGER, verified_note TEXT)')
  users.exec('INSERT INTO users VALUES (2, 0, NULL)')
  const read = users.prepare('SELECT is_verified, verified_note FROM users WHERE id = 2')
  state.execute.mockImplementation(async (sql, params) => [users.prepare(sql).run(... params)])
  state.user.mockResolvedValue({ ... viewer, is_admin: true })
  const admin = caller()

  await admin.setVerification({ id: 2, is_verified: true, verified_note: '  初次认证  ' })
  expect(read.get()).toEqual({ is_verified: 1, verified_note: '初次认证' })
  const revised = '改'.repeat(255)
  await admin.setVerification({ id: 2, is_verified: true, verified_note: ` ${revised} ` })
  expect(read.get()).toEqual({ is_verified: 1, verified_note: revised })
  await expect(admin.setVerification({ id: 2, is_verified: true, verified_note: `${revised}字` })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  expect(read.get()).toEqual({ is_verified: 1, verified_note: revised })
  await admin.setVerification({ id: 2, is_verified: false, verified_note: '旧客户端带回的说明' })
  expect(read.get()).toEqual({ is_verified: 0, verified_note: null })
})

it.each([undefined, null, '', ' \t　'])('requires a nonblank note to verify an account (%s)', async (verified_note) => {
  state.user.mockResolvedValue({ ... viewer, is_admin: true })
  await expect(caller().setVerification({ id: 2, is_verified: true, verified_note }))
    .rejects.toMatchObject({ code: 'BAD_REQUEST', message: '请填写认证说明' })
  expect(state.execute).not.toHaveBeenCalled()
})

it('refuses to grant the administrator-only console level and to let an administrator ban themselves', async () => {
  state.user.mockResolvedValue({ ... viewer, is_admin: true, permissions: [] })
  await expect(caller().setPermissions({ id: 2, permissions: [{ field: 'admin_access', level: 'full' }] }))
    .rejects.toMatchObject({ code: 'BAD_REQUEST', message: '权限项不合法' })
  await expect(caller().setBanned({ id: 7, banned: true })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: '不能封禁自己' })
  expect(state.execute).not.toHaveBeenCalled()
  await caller().setBanned({ id: 2, banned: true })
  expect(state.execute).toHaveBeenCalledWith('UPDATE users SET is_banned = 1 WHERE id = ?', [2])
})

it('retains the default sort and checks permission before executing a list query', async () => {
  await caller().listUsers({ page: 1, page_size: 10 })
  expect(state.execute.mock.calls[1]![0]).toContain('ORDER BY u.id DESC')
  state.execute.mockClear()
  state.user.mockResolvedValue({ ... viewer, permissions: [] })
  await expect(caller().listUsers({ page: 1, page_size: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.execute).not.toHaveBeenCalled()
})
