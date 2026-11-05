import type { Profile } from '@shared/types/user'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
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
  it('keeps the existing resource keys and derives administrator operation mode', async () => {
    const data = ref<Profile | null>(null)
    const loading = ref(false)
    const get_profile = vi.fn(async () => profile_value)
    let query: unknown[] = []
    vi.stubGlobal('useApi', () => ({ profile: { get_profile } }))
    vi.stubGlobal('useAuth', () => ({ user: ref({ id: 1, is_admin: true, permissions: [] }) }))
    vi.stubGlobal('useSyncedState', () => data)
    vi.stubGlobal('useState', () => loading)
    vi.stubGlobal('useSyncedData', (... args: unknown[]) => {
      query = args
      return Promise.resolve({ refresh: vi.fn() })
    })

    const profile_key = ref<string | number>('7')
    const account = useAccountProfile(profile_key)
    expect((query[0] as ReturnType<typeof computed>).value).toBe('profile:7')
    await expect((query[1] as () => Promise<Profile>)()).resolves.toEqual(profile_value)
    data.value = profile_value
    expect(account.is_operating_other.value).toBe(true)

    profile_key.value = 'bad'
    expect((query[0] as ReturnType<typeof computed>).value).toBeNull()
    await expect((query[1] as () => Promise<Profile>)()).rejects.toThrow('？？？')
    await account.ready
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
    await security.change_phone_for({ new_phone: '13900000000' })
    await security.change_password({ old_password: 'Old!1234', new_password: 'New!1234', confirm_new_password: 'New!1234' })
    await security.send_otp('change_phone', '13900000000')

    expect(api.update_birthday).toHaveBeenCalledWith('2020-01-02T00:00:00.000Z', 7)
    expect(api.delete_avatar).toHaveBeenCalledWith(7)
    expect(api.reset_password_for).toHaveBeenCalledWith(7, { new_password: 'Example!123', confirm_new_password: 'Example!123' })
    expect(api.change_phone_for).toHaveBeenCalledWith(7, '13900000000')
    expect(api.change_password).toHaveBeenCalledWith({ old_password: 'Old!1234', new_password: 'New!1234', confirm_new_password: 'New!1234', ... captcha })
    expect(auth.send_otp).toHaveBeenCalledWith({ phone: '13900000000', purpose: 'change_phone', ... captcha })
    expect(details.birthday_pending.value).toBe(false)
    expect(security.password_pending.value).toBe(false)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('subscribes to the editable account sessions and switches revocation target with operation mode', async () => {
    const profile = ref(profile_value)
    const operating_other = ref(true)
    const sessions = ref(null)
    const loading = ref(false)
    const api = {
      get_user_sessions: vi.fn(async () => ({ records: [] })),
      get_my_sessions: vi.fn(async () => ({ records: [] })),
      force_logout_user_session: vi.fn(async () => {}),
      force_logout_session: vi.fn(async () => {}),
    }
    let query: unknown[] = []
    vi.stubGlobal('useApi', () => ({ profile: api }))
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn(), ok: vi.fn() }))
    vi.stubGlobal('useSyncedState', () => sessions)
    vi.stubGlobal('useState', () => loading)
    vi.stubGlobal('useSyncedData', (... args: unknown[]) => {
      query = args
      return Promise.resolve({ refresh: vi.fn() })
    })

    const account_sessions = useAccountSessions(profile, operating_other)
    expect((query[0] as ReturnType<typeof computed>).value).toBe('profile_sessions:7')
    await (query[1] as () => Promise<unknown>)()
    expect(api.get_user_sessions).toHaveBeenCalledWith(7)
    await account_sessions.force_logout(12)
    expect(api.force_logout_user_session).toHaveBeenCalledWith(7, 12)

    operating_other.value = false
    await account_sessions.force_logout(13)
    expect(api.force_logout_session).toHaveBeenCalledWith(13)
    expect(account_sessions.pending_id.value).toBeNull()

    profile.value = { ... profile_value, editable: false }
    expect((query[0] as ReturnType<typeof computed>).value).toBeNull()
    await account_sessions.ready
  })
})
