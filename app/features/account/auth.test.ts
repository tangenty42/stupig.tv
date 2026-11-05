import type { LoginUser } from '~/composables/useAuth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { useAccountAuthFlow, useAccountIdentity } from './auth'

const current_user: LoginUser = {
  id: 7,
  username: 'old-name',
  phone: '13800000000',
  avatar_file: null,
  avatar_version: null,
  is_verified: false,
  is_admin: false,
  permissions: [],
}

beforeEach(() => {
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('ref', ref)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('account identity', () => {
  it('refreshes the cookie-backed identity and rejects data for a replaced account', async () => {
    const user = ref<LoginUser | null>({ ... current_user })
    const update_user = vi.fn()
    const get_me = vi.fn(async () => ({
      ... current_user,
      username: 'fresh-name',
      phone: null,
      birthday: null,
      created_at: '2026-01-01T00:00:00.000Z',
      last_seen_at: null,
      is_online: true,
      is_banned: false,
      verified_note: null,
      editable: true,
    }))
    let query: unknown[] = []
    vi.stubGlobal('useAuth', () => ({ user, update_user, logout: vi.fn(), apply_auth: vi.fn(), handle_remote_logout: vi.fn() }))
    vi.stubGlobal('useApi', () => ({ profile: { get_me } }))
    vi.stubGlobal('useSyncedState', (value: unknown) => value)
    vi.stubGlobal('useSyncedData', (... args: unknown[]) => {
      query = args
      return Promise.resolve({ refresh: vi.fn() })
    })

    const identity = useAccountIdentity()
    expect((query[0] as ReturnType<typeof computed>).value).toBe('auth_user:7')
    const next_user = await (query[1] as () => Promise<LoginUser>)()
    expect(next_user).toMatchObject({ id: 7, username: 'fresh-name', phone: '13800000000' })

    const on_data = (query[3] as { on_data: (value: LoginUser) => void }).on_data
    on_data(next_user)
    expect(update_user).toHaveBeenCalledWith(next_user)

    user.value = { ... current_user, id: 8 }
    on_data(next_user)
    expect(update_user).toHaveBeenCalledOnce()
    await identity.ready
  })
})

describe('account authentication flow', () => {
  it('owns challenge, pending state and successful identity application', async () => {
    let complete_login!: (value: { user: LoginUser }) => void
    const result = { user: current_user }
    const auth = {
      login_with_password: vi.fn(() => new Promise<{ user: LoginUser }>(resolve => complete_login = resolve)),
      login_with_phone: vi.fn(async () => result),
      register: vi.fn(async () => result),
      send_otp: vi.fn(async () => {}),
    }
    const apply_auth = vi.fn()
    const verify = vi.fn(async () => ({ captcha_verify_param: 'verified' }))
    const toast = { error: vi.fn(), ok: vi.fn(), info: vi.fn() }
    vi.stubGlobal('useApi', () => ({ auth }))
    vi.stubGlobal('useAuth', () => ({ apply_auth }))
    vi.stubGlobal('useCaptcha', () => ({ verify, showing: ref(false) }))
    vi.stubGlobal('useMyToast', () => toast)

    const flow = useAccountAuthFlow()
    const login = flow.login_with_password({ username_or_phone: 'user', password: 'secret' })
    expect(flow.pending.value).toBe(true)
    await Promise.resolve()
    complete_login(result)
    await expect(login).resolves.toBe(true)
    expect(flow.pending.value).toBe(false)
    expect(auth.login_with_password).toHaveBeenCalledWith({ username_or_phone: 'user', password: 'secret', captcha_verify_param: 'verified' })
    expect(apply_auth).toHaveBeenCalledWith(result)

    await flow.send_otp('13800000000', 'login')
    expect(auth.send_otp).toHaveBeenCalledWith({ phone: '13800000000', purpose: 'login', captcha_verify_param: 'verified' })
    expect(toast.info).toHaveBeenCalledWith('验证码发送成功！')
  })

  it('reports a rejected login without replacing identity', async () => {
    const failure = new Error('wrong password')
    const apply_auth = vi.fn()
    const toast = { error: vi.fn(), ok: vi.fn(), info: vi.fn() }
    vi.stubGlobal('useApi', () => ({ auth: {
      login_with_password: vi.fn().mockRejectedValue(failure),
      login_with_phone: vi.fn(),
      register: vi.fn(),
      send_otp: vi.fn(),
    } }))
    vi.stubGlobal('useAuth', () => ({ apply_auth }))
    vi.stubGlobal('useCaptcha', () => ({ verify: vi.fn(async () => ({})), showing: ref(false) }))
    vi.stubGlobal('useMyToast', () => toast)

    const flow = useAccountAuthFlow()
    await expect(flow.login_with_password({ username_or_phone: 'user', password: 'bad' })).resolves.toBe(false)
    expect(apply_auth).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(failure)
    expect(flow.pending.value).toBe(false)
  })
})
