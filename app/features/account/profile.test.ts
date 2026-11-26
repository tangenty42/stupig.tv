import type { SessionOverview } from '@shared/types/session'
import type { Profile } from '@shared/types/user'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, isRef, ref, watch } from 'vue'
import { get_error_status } from '~/composables/useApi'
import { useSyncedData } from '~/composables/useSyncedData'
import { useSyncedState } from '~/composables/useSyncedState'
import { useAccountProfile, useAccountProfileDetails, useAccountSecurity, useAccountSessions } from './profile'

const profile_value: Profile = {
  id: 7,
  username: 'user',
  phone: '13800000000',
  avatar_file: 'avatar.jpg',
  avatar_version: 'v1',
  birthday: null,
  created_at: '2026-01-01T00:00:00.000Z',
  last_seen_at: null,
  is_online: true,
  is_verified: false,
  is_admin: false,
  is_banned: false,
  verified_note: null,
  editable: true,
  sensitive_readable: true,
  permissions: [],
}

beforeEach(() => {
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('ref', ref)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('account profile query', () => {
  function setup() {
    const get_profile = vi.fn(async () => profile_value)
    const user = ref({ id: 1, is_admin: true, permissions: [] })
    let query: unknown[] = []
    vi.stubGlobal('useApi', () => ({ profile: { get_profile } }))
    vi.stubGlobal('useAuth', () => ({ user }))
    const state = (_key: string, initial: () => unknown) => ref(initial())
    vi.stubGlobal('useSyncedState', state)
    vi.stubGlobal('useState', state)
    vi.stubGlobal('useSyncedData', (... args: unknown[]) => {
      query = args
      return Promise.resolve({ refresh: vi.fn() })
    })

    const profile_key = ref<string | number>('7')
    const account = useAccountProfile(profile_key)
    const resource = query[0] as ReturnType<typeof computed>
    const fetch = query[1] as () => Promise<{ key: string, profile: Profile | null } | null>
    const snapshot = query[2] as { value: Awaited<ReturnType<typeof fetch>> }
    const { on_data, on_error, query_key } = query[4] as {
      on_data: () => void
      on_error: () => void
      query_key: ReturnType<typeof computed>
    }
    async function resolve_profile() {
      snapshot.value = await fetch()
      on_data()
    }
    return { account, profile_key, user, get_profile, resource, fetch, resolve_profile, on_error, query_key }
  }

  it('keeps the public resource and separates typed routes and the viewer from the cached profile', async () => {
    const { account, profile_key, user, get_profile, resource, fetch, resolve_profile, query_key } = setup()
    expect(resource.value).toBe('profile:7')
    await resolve_profile()
    expect(get_profile).toHaveBeenCalledExactlyOnceWith(7)
    expect(account.profile.value).toEqual(profile_value)
    expect(account.is_operating_other.value).toBe(true)
    expect(account.is_viewing_other.value).toBe(true)

    const initial_key = query_key.value
    user.value = { ... user.value, is_admin: false }
    expect(query_key.value).not.toBe(initial_key)
    expect(account.profile.value).toBeNull()

    profile_key.value = 'bad'
    expect(resource.value).toBeNull()
    expect(account.missing.value).toBe(true)
    await expect(fetch()).resolves.toBeNull()
    expect(get_profile).toHaveBeenCalledOnce()
    await account.ready
  })

  it('separates initial failure, an old readable profile, and confirmed absence', async () => {
    const { account, profile_key, get_profile, fetch, resolve_profile, on_error } = setup()
    get_profile.mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 503 }))
    await expect(fetch()).rejects.toThrow('offline')
    on_error()
    expect(account.failed.value).toBe(true)
    expect(account.missing.value).toBe(false)
    await resolve_profile()
    expect(account.failed.value).toBe(false)
    on_error()
    expect(account.profile.value).toEqual(profile_value)

    profile_key.value = 8
    expect(account.profile.value).toBeNull()
    expect(account.failed.value).toBe(false)
    get_profile.mockRejectedValueOnce(Object.assign(new Error('用户不存在'), { status: 404 }))
    await resolve_profile()
    expect(get_profile).toHaveBeenLastCalledWith(8)
    expect(account.profile.value).toBeNull()
    expect(account.missing.value).toBe(true)
    expect(account.failed.value).toBe(false)
  })
})

describe('account profile operations', () => {
  it('routes profile and security mutations through the selected account', async () => {
    const profile = ref(profile_value)
    const operating_other = ref(true)
    const captcha = { captcha_verify_param: 'verified' }
    const api = {
      update_birthday: vi.fn(async () => {}),
      delete_avatar: vi.fn(async () => {}),
      reset_password_for: vi.fn(async () => {}),
      change_phone_for: vi.fn(async () => {}),
      change_password: vi.fn(async () => {}),
      change_password_by_otp: vi.fn(async () => {}),
      change_phone: vi.fn(async () => {}),
    }
    const auth = { send_otp: vi.fn(async () => {}) }
    const toast = { error: vi.fn(), ok: vi.fn() }
    vi.stubGlobal('useApi', () => ({ auth, profile: api }))
    vi.stubGlobal('useCaptcha', () => ({ verify: vi.fn(async () => captcha) }))
    vi.stubGlobal('useMyToast', () => toast)

    const details = useAccountProfileDetails(profile, operating_other)
    const security = useAccountSecurity(profile)
    await details.update_birthday({ birthday: '2020-01-02T00:00:00.000Z' })
    await details.delete_avatar()
    await security.reset_password_for({ new_password: 'Example!123', confirm_new_password: 'Example!123' })
    expect(toast.ok).toHaveBeenLastCalledWith('密码已修改！')
    await security.change_phone_for({ new_phone: '13900000000' })
    await security.change_password({ old_password: 'Old!1234', new_password: 'New!1234', confirm_new_password: 'New!1234' })
    expect(toast.ok).toHaveBeenLastCalledWith('密码已修改！')
    await security.change_password_by_otp({ otp: '123456', new_password: 'New!1234', confirm_new_password: 'New!1234' })
    expect(toast.ok).toHaveBeenLastCalledWith('密码已修改！')
    await security.send_otp('change_phone', '13900000000')
    expect(toast.ok).toHaveBeenLastCalledWith('验证码已发送！')

    expect(api.update_birthday).toHaveBeenCalledWith('2020-01-02T00:00:00.000Z', 7)
    expect(api.delete_avatar).toHaveBeenCalledWith(7)
    expect(api.reset_password_for).toHaveBeenCalledWith(7, { new_password: 'Example!123', confirm_new_password: 'Example!123' })
    expect(api.change_phone_for).toHaveBeenCalledWith(7, '13900000000')
    expect(api.change_password).toHaveBeenCalledWith({ old_password: 'Old!1234', new_password: 'New!1234', confirm_new_password: 'New!1234', ... captcha })
    expect(api.change_password_by_otp).toHaveBeenCalledWith({ otp: '123456', new_password: 'New!1234', confirm_new_password: 'New!1234', ... captcha })
    expect(auth.send_otp).toHaveBeenCalledWith({ phone: '13900000000', purpose: 'change_phone', ... captcha })
    expect(details.birthday_pending.value).toBe(false)
    expect(security.password_pending.value).toBe(false)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('subscribes to readable account sessions and switches the target with the viewed account', async () => {
    const profile = ref(profile_value)
    const viewing_other = ref(true)
    const user = ref({ id: 1, is_admin: true })
    const api = {
      get_user_sessions: vi.fn(async () => ({ records: [] })),
      get_my_sessions: vi.fn(async () => ({ records: [] })),
      force_logout_user_session: vi.fn(async () => {}),
      force_logout_session: vi.fn(async () => {}),
    }
    let query: unknown[] = []
    vi.stubGlobal('useApi', () => ({ profile: api }))
    vi.stubGlobal('useAuth', () => ({ user }))
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn(), ok: vi.fn() }))
    vi.stubGlobal('useSyncedState', useSyncedState)
    vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()))
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('useSyncedData', (... args: unknown[]) => {
      query = args
      return Promise.resolve({ refresh: vi.fn() })
    })

    const account_sessions = useAccountSessions(profile, viewing_other)
    expect((query[0] as ReturnType<typeof computed>).value).toBe('profile_sessions:7')
    await (query[1] as () => Promise<unknown>)()
    expect(api.get_user_sessions).toHaveBeenCalledWith(7)
    await account_sessions.force_logout(12)
    expect(api.force_logout_user_session).toHaveBeenCalledWith(7, 12)

    // A console reader may read another account's sessions without being able to edit it.
    profile.value = { ... profile_value, editable: false }
    expect((query[0] as ReturnType<typeof computed>).value).toBe('profile_sessions:7')
    expect(await account_sessions.force_logout(14)).toBe(false)
    expect(api.force_logout_user_session).toHaveBeenCalledOnce()

    user.value = { id: 7, is_admin: false }
    viewing_other.value = false
    profile.value = profile_value
    await (query[1] as () => Promise<unknown>)()
    expect(api.get_my_sessions).toHaveBeenCalledOnce()
    await account_sessions.force_logout(13)
    expect(api.force_logout_session).toHaveBeenCalledWith(13)
    expect(account_sessions.pending_id.value).toBeNull()

    profile.value = { ... profile_value, editable: false, sensitive_readable: false }
    expect((query[0] as ReturnType<typeof computed>).value).toBeNull()
    await account_sessions.ready
  })
})

describe('login records query', () => {
  const unmounts: (() => void)[] = []
  const listeners = new Map<string, () => Promise<void>>()
  const states = new Map<string, ReturnType<typeof ref<unknown>>>()
  const toast = { error: vi.fn(), ok: vi.fn() }

  beforeEach(() => {
    listeners.clear()
    states.clear()
    toast.error.mockClear()
    toast.ok.mockClear()
    const app = { isHydrating: false, hook: vi.fn() }
    for (const [name, value] of Object.entries({ effectScope, get_error_status, isRef, useSyncedData, useSyncedState, watch }))
      vi.stubGlobal(name, value)
    vi.stubGlobal('onUnmounted', (callback: () => void) => unmounts.push(callback))
    vi.stubGlobal('useNuxtApp', () => app)
    vi.stubGlobal('useReactiveDateNow', () => ref(0))
    vi.stubGlobal('useMyToast', () => toast)
    vi.stubGlobal('useState', (key: string, init: () => unknown) => {
      if (! states.has(key))
        states.set(key, ref(init()))
      return states.get(key)!
    })
    vi.stubGlobal('useDataSync', () => ({ subscribe: (resource: string, refresh: () => Promise<void>) => {
      listeners.set(resource, refresh)
      return () => listeners.delete(resource)
    } }))
  })

  afterEach(() => unmounts.splice(0).forEach(unmount => unmount()))

  function login_records(id: number): SessionOverview {
    return { records: [{ id, identity_token: null, is_logged_out: false, is_expired: false, is_online: true,
      login_at: '2026-01-01T00:00:00.000Z', last_seen_at: '2026-01-01T00:00:00.000Z', logout_at: null,
      expires_at: '2027-01-01T00:00:00.000Z', login_ip: '192.0.2.1', last_seen_ip: null, user_agent: null, is_current: false }] }
  }

  it('sets failure and retry states without treating them as success or discarding a loaded list', async () => {
    const user = ref({ id: 7, is_admin: false })
    const initial = Promise.withResolvers<SessionOverview>()
    const get_my_sessions = vi.fn<() => Promise<SessionOverview>>().mockReturnValueOnce(initial.promise)
    vi.stubGlobal('useAuth', () => ({ user }))
    vi.stubGlobal('useApi', () => ({ profile: { get_my_sessions } }))
    const overview = useAccountSessions(ref(profile_value), ref(false))
    expect(overview.loading.value).toBe(true)
    const failure = Object.assign(new Error('offline'), { status: 503 })
    initial.reject(failure)
    await overview.ready
    expect(overview.sessions.value).toBeNull()
    expect(overview.load_failed.value).toBe(true)
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(failure)

    get_my_sessions.mockResolvedValueOnce({ records: [] })
    await overview.refresh()
    expect(overview.sessions.value).toEqual({ records: [] })
    expect(overview.load_failed.value).toBe(false)
    const loaded = login_records(10)
    get_my_sessions.mockResolvedValueOnce(loaded).mockRejectedValue(failure)
    await listeners.get('profile_sessions:7')!()
    await listeners.get('profile_sessions:7')!()
    await listeners.get('profile_sessions:7')!()
    expect(overview.sessions.value).toEqual(loaded)
    expect(overview.load_failed.value).toBe(true)
    expect(toast.error).toHaveBeenCalledTimes(2)

    get_my_sessions.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }))
    await overview.refresh()
    expect(overview.sessions.value).toBeNull()
    expect(overview.load_failed.value).toBe(true)

    const previous_calls = get_my_sessions.mock.calls.length
    const shared = useAccountSessions(ref(profile_value), ref(false))
    await shared.ready
    expect(shared.sessions.value).toBeNull()
    expect(shared.load_failed.value).toBe(true)
    expect(get_my_sessions).toHaveBeenCalledTimes(previous_calls)
    expect(toast.error).toHaveBeenCalledTimes(3)
  })

  it('clears loaded sessions on target or viewer change and ignores the old response', async () => {
    const user = ref<{ id: number, is_admin: boolean } | null>({ id: 1, is_admin: true })
    const profile = ref(profile_value)
    const get_user_sessions = vi.fn(async (id: number) => login_records(id))
    vi.stubGlobal('useAuth', () => ({ user }))
    vi.stubGlobal('useApi', () => ({ profile: { get_user_sessions } }))
    const overview = useAccountSessions(profile, ref(true))
    const { refresh } = await overview.ready
    expect(overview.sessions.value).toEqual(login_records(7))

    const older = Promise.withResolvers<SessionOverview>()
    get_user_sessions.mockReturnValueOnce(older.promise)
    const old_refresh = refresh()
    profile.value = { ... profile_value, id: 8 }
    expect(overview.sessions.value).toBeNull()
    await overview.refresh()
    expect(overview.sessions.value).toEqual(login_records(8))
    older.resolve(login_records(70))
    await old_refresh
    expect(overview.sessions.value).toEqual(login_records(8))

    user.value = { id: 2, is_admin: true }
    expect(overview.sessions.value).toBeNull()
    await overview.refresh()
    expect(overview.sessions.value).toEqual(login_records(8))
    user.value = null
    expect(overview.sessions.value).toBeNull()
    expect(overview.active.value).toBe(false)
    expect(listeners.size).toBe(0)
  })

  it('does not expose the switched target snapshot when the first target remounts', async () => {
    const user = ref({ id: 1, is_admin: true })
    const profile = ref(profile_value)
    const get_user_sessions = vi.fn(async (id: number) => login_records(id))
    vi.stubGlobal('useAuth', () => ({ user }))
    vi.stubGlobal('useApi', () => ({ profile: { get_user_sessions } }))
    const original = useAccountSessions(profile, ref(true))
    await original.ready
    expect(original.sessions.value).toEqual(login_records(7))

    profile.value = { ... profile_value, id: 8 }
    await original.refresh()
    expect(original.sessions.value).toEqual(login_records(8))
    const failure = Object.assign(new Error('offline'), { status: 503 })
    get_user_sessions.mockRejectedValueOnce(failure)
    await original.refresh()
    expect(original.load_failed.value).toBe(true)
    unmounts.shift()!()

    const response = Promise.withResolvers<SessionOverview>()
    get_user_sessions.mockReturnValueOnce(response.promise)
    const remounted = useAccountSessions(ref(profile_value), ref(true))
    expect(remounted.sessions.value).toBeNull()
    expect(remounted.load_failed.value).toBe(false)
    expect(remounted.loading.value).toBe(true)
    response.resolve(login_records(7))
    await remounted.ready
    expect(remounted.sessions.value).toEqual(login_records(7))
  })
})
