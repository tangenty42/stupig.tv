import type { Ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, isRef, ref } from 'vue'
import { useAdminUsers } from './users'

let admin: Record<'list_users' | 'set_banned' | 'force_logout' | 'set_verification' | 'set_admin_role' | 'set_permissions', ReturnType<typeof vi.fn>>
let synced_refresh: ReturnType<typeof vi.fn>
let synced_call: { fetcher: () => Promise<unknown>, data: Ref<unknown>, options: { query_key: Ref<string>, on_data: (value: unknown) => void } }
let initial: Ref<unknown>
let hydrating: boolean
let unmounts: Array<() => void>

beforeEach(() => {
  admin = {
    list_users: vi.fn(), set_banned: vi.fn(), force_logout: vi.fn(), set_verification: vi.fn(),
    set_admin_role: vi.fn(), set_permissions: vi.fn(),
  }
  synced_refresh = vi.fn(async () => {})
  initial = ref(null)
  hydrating = false
  unmounts = []
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('useApi', () => ({ admin }))
  vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
  vi.stubGlobal('onBeforeUnmount', (callback: () => void) => unmounts.push(callback))
  vi.stubGlobal('useNuxtApp', () => ({ isHydrating: hydrating }))
  vi.stubGlobal('useSyncedState', (source: unknown) => isRef(source) ? source : initial)
  vi.stubGlobal('useSyncedData', vi.fn(async (_resource: unknown, fetcher: typeof synced_call.fetcher, data: Ref<unknown>, _loading: unknown, options: typeof synced_call.options) => {
    synced_call = { fetcher, data, options }
    return { refresh: synced_refresh }
  }))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// useSyncedData applies accepted responses before notifying its consumer. Hydration may delay this step.
function apply_response(value: unknown) {
  synced_call.data.value = value
  synced_call.options.on_data(value)
}

it('takes the SSR snapshot on hydration and isolates overlapping client views', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const query = { page: ref(1), page_size: ref(10), filter: ref('') }
  const on_data = vi.fn()
  const users = useAdminUsers(query, on_data)
  await users.ready
  expect(users.updated_at.value).toBeNull()
  const page = { users: [], total: 0 }
  admin.list_users.mockResolvedValueOnce(page)
  apply_response(await synced_call.fetcher())
  expect(on_data).toHaveBeenCalledExactlyOnceWith(page)
  expect(users.updated_at.value?.getTime()).toBe(1000)

  clock.mockReturnValue(2000)
  const payload = JSON.parse(JSON.stringify(synced_call.data.value))
  initial.value = payload
  hydrating = true
  const client = useAdminUsers(query, vi.fn())
  await client.ready
  expect(initial.value).toBeNull()
  expect(client.result.value).toEqual(page)
  expect(client.updated_at.value?.getTime()).toBe(1000)
  // Applying a deferred response preserves the instant it arrived.
  apply_response(payload)
  expect(client.updated_at.value?.getTime()).toBe(1000)

  admin.list_users.mockResolvedValueOnce({ users: [], total: 20 })
  const response = await synced_call.fetcher()
  expect(client.updated_at.value?.getTime()).toBe(1000)
  clock.mockReturnValue(3000)
  apply_response(response)
  expect(client.result.value?.total).toBe(20)
  expect(client.updated_at.value?.getTime()).toBe(2000)

  hydrating = false
  const next = useAdminUsers(query, vi.fn())
  await next.ready
  expect(next.result.value).toBeNull()
  apply_response({ result: { users: [], total: 5 }, received_at: 3000 })
  unmounts[1]!()
  expect(client.result.value).toBeNull()
  expect(next.result.value?.total).toBe(5)
})

it('keeps the last accepted list and its time on a failed refresh', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const on_data = vi.fn()
  const users = useAdminUsers({ page: ref(1), page_size: ref(10), filter: ref('') }, on_data)
  await users.ready
  admin.list_users.mockRejectedValueOnce(new Error('offline'))
  await expect(synced_call.fetcher()).rejects.toThrow('offline')
  expect(users.updated_at.value).toBeNull()
  admin.list_users.mockResolvedValueOnce({ users: [], total: 12 })
  apply_response(await synced_call.fetcher())
  clock.mockReturnValue(2000)
  admin.list_users.mockRejectedValueOnce(new Error('offline'))
  await expect(synced_call.fetcher()).rejects.toThrow('offline')
  expect(users.updated_at.value?.getTime()).toBe(1000)
  expect(users.result.value?.total).toBe(12)
  expect(on_data).toHaveBeenCalledOnce()
})

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
