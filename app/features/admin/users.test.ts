import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { useAdminCommandMeta, useAdminUsers } from './users'

let admin: Record<'list_users' | 'set_banned' | 'force_logout' | 'set_verification' | 'set_admin_role' | 'set_permissions' | 'get_keywords', ReturnType<typeof vi.fn>>
let synced_refresh: ReturnType<typeof vi.fn>
let synced_call: { fetcher: () => unknown, options: { query_key: { value: string } } }

beforeEach(() => {
  admin = {
    list_users: vi.fn(), set_banned: vi.fn(), force_logout: vi.fn(), set_verification: vi.fn(),
    set_admin_role: vi.fn(), set_permissions: vi.fn(), get_keywords: vi.fn(),
  }
  synced_refresh = vi.fn(async () => {})
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('useApi', () => ({ admin }))
  vi.stubGlobal('useSyncedState', (_key: string, init: () => unknown) => ref(init()))
  vi.stubGlobal('useSyncedData', vi.fn(async (_resource: unknown, fetcher: () => unknown, _data: unknown, _loading: unknown, options: typeof synced_call.options) => {
    synced_call = { fetcher, options }
    return { refresh: synced_refresh }
  }))
})
afterEach(() => vi.unstubAllGlobals())

it('changes the query once for a combined page change and refreshes an unchanged query', async () => {
  const page = ref(1)
  const page_size = ref(10)
  const filter = ref('')
  const users = useAdminUsers({ page, page_size, filter }, vi.fn())
  await users.ready
  const initial_key = synced_call.options.query_key.value

  page.value = 3
  page_size.value = 50
  expect(synced_call.options.query_key.value).toBe(initial_key)
  await users.refresh()
  expect(synced_call.options.query_key.value).not.toBe(initial_key)
  expect(synced_refresh).not.toHaveBeenCalled()
  synced_call.fetcher()
  expect(admin.list_users).toHaveBeenLastCalledWith({ page: 3, page_size: 50, filter: undefined })

  await users.refresh()
  expect(synced_refresh).toHaveBeenCalledOnce()
})

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
