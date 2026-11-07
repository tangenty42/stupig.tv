import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useAdminCommandMeta, useAdminUsers } from './users'

let admin: Record<'list_users' | 'set_banned' | 'force_logout' | 'set_verification' | 'set_admin_role' | 'set_permissions' | 'get_keywords', ReturnType<typeof vi.fn>>

beforeEach(() => {
  admin = {
    list_users: vi.fn(), set_banned: vi.fn(), force_logout: vi.fn(), set_verification: vi.fn(),
    set_admin_role: vi.fn(), set_permissions: vi.fn(), get_keywords: vi.fn(),
  }
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('useApi', () => ({ admin }))
  vi.stubGlobal('useSyncedState', (_key: string, init: () => unknown) => ref(init()))
  vi.stubGlobal('useSyncedData', vi.fn(async () => ({ refresh: vi.fn() })))
})
afterEach(() => vi.unstubAllGlobals())

it.each([
  ['BAN', 'set_banned', [7, true]],
  ['UNBAN', 'set_banned', [7, false]],
  ['KICK', 'force_logout', [7]],
  ['VERIFY', 'set_verification', [7, true, 'note']],
  ['UNVERIFY', 'set_verification', [7, false]],
  ['PROMOTE', 'set_admin_role', [7, true]],
  ['DEMOTE', 'set_admin_role', [7, false]],
] as const)('maps %s to its single admin API call', async (command, method, args) => {
  const users = useAdminUsers({ page: ref(1), page_size: ref(10), filter: ref('') }, vi.fn())
  await users.run(command, 7, 'note')
  expect(admin[method]).toHaveBeenCalledExactlyOnceWith(... args)
  const others = Object.entries(admin).filter(([name]) => name !== method && name !== 'list_users')
  for (const [, fn] of others)
    expect(fn).not.toHaveBeenCalled()
})

it('loads command bar suggestions and falls back to the built-in commands when the request fails', async () => {
  admin.get_keywords.mockResolvedValueOnce({ fields: ['id'], keywords: ['SELECT'], commands: ['BAN'] })
  const loaded = useAdminCommandMeta()
  await loaded.ready
  expect([loaded.fields.value, loaded.sql_keywords.value, loaded.commands.value]).toEqual([['id'], ['SELECT'], ['BAN', 'VERIFY', 'UNVERIFY', 'PROMOTE', 'DEMOTE']])
  admin.get_keywords.mockRejectedValueOnce(new Error('offline'))
  const fallback = useAdminCommandMeta()
  await fallback.ready
  expect(fallback.fields.value).toEqual([])
  expect(fallback.commands.value).toEqual(['BAN', 'UNBAN', 'KICK', 'ALL', 'VERIFY', 'UNVERIFY', 'PROMOTE', 'DEMOTE'])
})
