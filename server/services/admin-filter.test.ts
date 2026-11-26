import type { AuthUser } from '@server/types/auth'
import { expect, it } from 'vitest'
import { admin_filter_fields, compile_admin_filter } from './admin-filter'

const reader: AuthUser = {
  id: 7, session_id: 11, username: 'reader', phone: '13800138000',
  avatar_file: null, is_verified: false, is_admin: false,
  permissions: [{ field: 'admin_access', level: 'readonly' }],
}

it.each([
  ['id >= 1 AND NOT (is_banned = true OR username NOT LIKE \'a%\')', [1, true, 'a%']],
  ['id IN (1, 2) AND created_at BETWEEN \'2020-01-01\' AND \'2026-01-01\'', [1, 2, '2020-01-01', '2026-01-01']],
  ['id NOT IN (3, 4) OR id NOT BETWEEN -2 AND 0', [3, 4, - 2, 0]],
  ['NOT is_admin AND is_banned IS NOT TRUE', []],
  ['not(IS_BANNED = 1)', [1]],
  ['username IS NULL OR username IS NOT NULL', []],
  ['users.id <> 1 AND u.is_verified != false', [1, false]],
])('compiles supported conditions into placeholders: %s', (source, values) => {
  const result = compile_admin_filter(reader, source)
  expect(result.params).toEqual(values)
  expect((result.where.match(/\?/g) ?? []).length).toBe(values.length)
  expect(result.order_by).toBe('u.id DESC')
})

it.each([
  ['username = \'O\'\'Reilly\'', 'O\'Reilly'],
  [String.raw`username = 'O\'Reilly'`, 'O\'Reilly'],
  [String.raw`username = 'a\\b'`, String.raw`a\b`],
  ['username = "a""b"', 'a"b'],
  [String.raw`username LIKE 'a\_%'`, String.raw`a\_%`],
  ['username = \'x\'\' OR 1=1 -- \'', 'x\' OR 1=1 -- '],
])('binds quoted values without allowing their contents to become SQL: %s', (source, value) => {
  expect(compile_admin_filter(reader, source)).toEqual({
    where: source.includes(' LIKE ') ? '(u.username LIKE ?)' : '(u.username = ?)', params: [value], order_by: 'u.id DESC',
  })
})

it('separates ordering from the predicate and stabilizes pagination with the user id', () => {
  expect(compile_admin_filter(reader, 'id > 0 ORDER BY username, created_at DESC')).toEqual({
    where: '(u.id > ?)', params: [0], order_by: 'u.username ASC, u.created_at DESC, u.id DESC',
  })
  expect(compile_admin_filter(reader, 'id > 0 ORDER BY id ASC').order_by).toBe('u.id ASC')
  expect(compile_admin_filter(reader, '  ')).toEqual({ where: '1=1', params: [], order_by: 'u.id DESC' })
})

it.each([
  'password_hash IS NOT NULL',
  'id = (SELECT user_id FROM user_login_sessions LIMIT 1)',
  'id IN (SELECT id FROM users)',
  'id = 1 UNION SELECT user_id FROM user_login_session_tokens',
  'id = 1; SELECT 1',
  'id = 1 INTO @probe',
  'id = 1 INTO OUTFILE \'/tmp/probe\'',
  'id = 1 LOCK IN SHARE MODE',
  'id = 1 FOR UPDATE',
  'id = 1 LIMIT 1',
  'id = 1 GROUP BY id',
  'id = 1 HAVING COUNT(*) > 0',
  'id > 0 ORDER BY (SELECT phone FROM users LIMIT 1)',
  'id > 0 ORDER BY RAND()',
  'id > 0 ORDER BY password_hash',
  'LENGTH(username) > 0',
  'NOT(SLEEP(1))',
  'CASE WHEN is_admin THEN 1 ELSE 0 END = 1',
  'id = @secret',
  'other_users.id = 1',
  'id = ?',
  'id IS \'text\'',
  'id = 1e999',
  'id = ',
])('rejects SQL outside the fixed user-filter grammar even for full operators: %s', (source) => {
  expect(() => compile_admin_filter({ ... reader, is_admin: true }, source)).toThrowError(expect.objectContaining({ statusCode: 400 }))
})

it.each(['phone = \'13800138000\'', 'id > 0 ORDER BY phone'])('lets console readers filter by phone, but nobody without console access: %s', (source) => {
  expect(() => compile_admin_filter(reader, source)).not.toThrow()
  expect(admin_filter_fields(reader)).toContain('phone')
  // A stored full grant on a non-admin is not a console grant at all.
  for (const permissions of [[], [{ field: 'admin_access', level: 'full' }]] satisfies AuthUser['permissions'][]) {
    const outsider = { ... reader, permissions } satisfies AuthUser
    expect(() => compile_admin_filter(outsider, source)).toThrowError(expect.objectContaining({ statusCode: 400 }))
    expect(admin_filter_fields(outsider)).not.toContain('phone')
  }
})

it.each([
  ' '.repeat(4097),
  `${'NOT('.repeat(40)}id = 1${')'.repeat(40)}`,
  `id IN (${Array.from({ length: 101 }, (_, index) => index).join(',')})`,
  Array.from({ length: 150 }).fill('id = 1').join(' OR '),
])('bounds parser and expression work', (source) => {
  expect(() => compile_admin_filter(reader, source)).toThrowError(expect.objectContaining({ statusCode: 400 }))
})
