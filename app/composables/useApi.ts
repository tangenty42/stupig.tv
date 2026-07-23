import type { NitroFetchOptions, NitroFetchRequest } from 'nitropack'

export type {
  AdminUser as ApiAdminUser,
  AdminUserList as ApiAdminUserList,
  AuthResult as ApiAuthResult,
  User as ApiAuthUser,
  SessionOverview as ApiLoginSessionOverview,
  SessionRecord as ApiLoginSessionRecord,
  OtpCooldownResult as ApiOtpCooldownResult,
  Profile as ApiProfile,
} from '@shared/types/api'

function get_ssr_cookie_header(): string | undefined {
  if (import.meta.client) {
    return undefined
  }

  const event = useRequestEvent()
  return event?.node?.req?.headers?.cookie
}

export interface ApiResponse<T> {
  success: boolean
  data: T | null
  message: string | null
}

export interface ApiCaptchaPayload {
  lot_number: string
  captcha_output: string
  pass_token: string
  gen_time: string
}

export type ApiOtpPurpose = 'register' | 'login' | 'change_password' | 'verify_old_phone' | 'change_phone'

const DEFAULT_API_ERROR_MESSAGE = '《我们仍未知道那天所发生の网络错误の名字》'

export class ApiError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export function get_error_status(error: unknown): number | undefined {
  const e = error as { statusCode?: number, status?: number }
  return e?.statusCode ?? e?.status
}

// Set once a 401 has triggered logout, so a burst of concurrent 401s (e.g. the
// profile + sessions fetches both failing after a ban) only logs out — and
// toasts — a single time. Reloading resets it for the next page load.
let unauthorized_handled = false

// ---- presence control module ----
// Client-side online heartbeat: every request() refreshes last_request_at;
// when no request has occurred for PING_IDLE_INTERVAL_SECONDS, fire a ping to update last_online_at.
let last_request_at = 0
let presence_started = false
let ping_pending = false

function stamp_request_activity() {
  if (import.meta.client) {
    last_request_at = Date.now()
  }
}

async function maybe_ping(base_url: string, idle_seconds: number, token_cookie_name: string) {
  if (ping_pending || document.visibilityState !== 'visible') {
    return
  }

  const now = Date.now()
  if (now - last_request_at < idle_seconds * 1000) {
    return
  }

  const token = useCookie<string | null>(token_cookie_name)
  if (! token.value) {
    return
  }

  ping_pending = true
  last_request_at = now

  try {
    await $fetch(`${base_url}/ping`, { credentials: 'include' })
  }
  catch {
    // Fail silently: online status expires naturally once the detection window passes
  }
  finally {
    ping_pending = false
  }
}

function ensure_presence_watchdog(base_url: string, idle_seconds: number, token_cookie_name: string) {
  if (import.meta.server || presence_started) {
    return
  }
  presence_started = true

  const scope = effectScope()
  scope.run(() => {
    watch(useReactiveDateNow(), () => {
      void maybe_ping(base_url, idle_seconds, token_cookie_name)
    })
  })
}

export function useApi() {
  const { public: public_config } = useRuntimeConfig()
  const base_url = public_config.api_base
  const { logout } = useAuth()

  ensure_presence_watchdog(base_url, public_config.ping_idle_interval_seconds, public_config.auth_token_cookie_name)

  async function request<T>(url: NitroFetchRequest, options: NitroFetchOptions<NitroFetchRequest> = {}): Promise<T | null> {
    stamp_request_activity()

    let response: ApiResponse<T>

    try {
      response = await $fetch<ApiResponse<T>>(url, {
        ...options,
        baseURL: base_url,
        credentials: 'include',
        headers: {
          ...(options.headers as Record<string, string> ?? {}),
          Accept: 'application/json',
          ...(import.meta.server ? { 'X-Nuxt-SSR': '1' } : {}),
          ...(get_ssr_cookie_header() ? { Cookie: get_ssr_cookie_header() } : {}),
        },
      })
    }
    catch (error: any) {
      const status = get_error_status(error)
      const message = error?.data?.message ?? error?.message ?? DEFAULT_API_ERROR_MESSAGE
      if (status === 401) {
        if (! unauthorized_handled) {
          unauthorized_handled = true
          await logout()
        }
        throw new ApiError(message, 401)
      }
      throw new ApiError(message, status)
    }

    if (! response.success) {
      throw new Error(response.message || DEFAULT_API_ERROR_MESSAGE)
    }

    return response.data
  }

  async function request_data<T>(url: NitroFetchRequest, options: NitroFetchOptions<NitroFetchRequest> = {}): Promise<T> {
    const data = await request<T>(url, options)
    if (data === null) {
      throw new Error(DEFAULT_API_ERROR_MESSAGE)
    }
    return data
  }

  const auth = {
    async send_otp(payload: { phone?: string, purpose: ApiOtpPurpose } & ApiCaptchaPayload): Promise<void> {
      await request('/auth/otp/send', {
        method: 'POST',
        body: payload,
      })
    },

    async get_otp_cooldown(payload: { phone?: string, purpose: ApiOtpPurpose }): Promise<ApiOtpCooldownResult> {
      return request_data<ApiOtpCooldownResult>('/auth/otp/cooldown', {
        method: 'POST',
        body: payload,
      })
    },

    async login_with_password(payload: { username_or_phone: string, password: string } & ApiCaptchaPayload): Promise<ApiAuthResult> {
      return request_data<ApiAuthResult>('/auth/login/password', {
        method: 'POST',
        body: payload,
      })
    },

    async login_with_phone(payload: { phone: string, otp: string } & ApiCaptchaPayload): Promise<ApiAuthResult> {
      return request_data<ApiAuthResult>('/auth/login/phone', {
        method: 'POST',
        body: payload,
      })
    },

    async register(payload: Record<string, unknown> & ApiCaptchaPayload): Promise<ApiAuthResult> {
      return request_data<ApiAuthResult>('/auth/register', {
        method: 'POST',
        body: payload,
      })
    },
  }

  const profile = {
    async get_me(): Promise<ApiProfile> {
      return request_data<ApiProfile>('/profile/me')
    },

    async get_profile(id: number): Promise<ApiProfile> {
      return request_data<ApiProfile>(`/profile/${encodeURIComponent(id)}`)
    },

    async get_my_sessions(): Promise<ApiLoginSessionOverview> {
      return request_data<ApiLoginSessionOverview>('/profile/me/sessions')
    },

    async force_logout_session(id: number): Promise<void> {
      await request(`/profile/me/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
    },

    async get_user_sessions(user_id: number): Promise<ApiLoginSessionOverview> {
      return request_data<ApiLoginSessionOverview>('/profile/me/sessions', {
        query: { operate_for: user_id },
      })
    },

    async force_logout_user_session(user_id: number, session_id: number): Promise<void> {
      await request(`/profile/me/sessions/${encodeURIComponent(session_id)}`, {
        method: 'DELETE',
        query: { operate_for: user_id },
      })
    },

    async reset_password_for(user_id: number, payload: { new_password: string, confirm_new_password: string }): Promise<void> {
      await request('/profile/password', {
        method: 'PATCH',
        body: { ...payload, operate_for: user_id },
      })
    },

    async change_phone_for(user_id: number, new_phone: string): Promise<void> {
      await request('/profile/phone', {
        method: 'PATCH',
        body: { new_phone, operate_for: user_id },
      })
    },

    async update_birthday(birthday: string | null, operate_for?: number | null): Promise<void> {
      await request('/profile/me', {
        method: 'PATCH',
        body: { birthday, operate_for: operate_for ?? null },
      })
    },

    async change_password(payload: { old_password: string, new_password: string, confirm_new_password: string } & ApiCaptchaPayload): Promise<void> {
      await request('/profile/password', {
        method: 'PATCH',
        body: payload,
      })
    },

    async change_password_by_otp(payload: { otp: string, new_password: string, confirm_new_password: string } & ApiCaptchaPayload): Promise<void> {
      await request('/profile/password-by-otp', {
        method: 'PATCH',
        body: payload,
      })
    },

    async change_phone(payload: { new_phone: string, old_otp: string, new_otp: string } & ApiCaptchaPayload): Promise<void> {
      await request('/profile/phone', {
        method: 'PATCH',
        body: payload,
      })
    },

    async upload_avatar(file: File, operate_for?: number | null): Promise<void> {
      const form = new FormData()
      form.append('avatar', file)

      if (operate_for) {
        form.append('operate_for', String(operate_for))
      }

      await request('/profile/avatar', {
        method: 'POST',
        body: form,
      })
    },

    async delete_avatar(operate_for?: number | null): Promise<void> {
      await request('/profile/avatar', {
        method: 'DELETE',
        query: operate_for ? { operate_for } : undefined,
      })
    },
  }

  const admin = {
    async list_users(options: {
      page: number
      page_size: number
      filter?: string
    }): Promise<ApiAdminUserList> {
      return request_data<ApiAdminUserList>('/admin/users', {
        query: {
          page: options.page,
          page_size: options.page_size,
          filter: options.filter,
        },
      })
    },

    async set_banned(id: number, banned: boolean): Promise<void> {
      await request(`/admin/users/${id}/ban`, {
        method: 'POST',
        body: { banned },
      })
    },

    async force_logout(id: number): Promise<void> {
      await request(`/admin/users/${id}/force-logout`, {
        method: 'POST',
      })
    },

    async set_verification(id: number, is_verified: boolean, note?: string | null): Promise<void> {
      await request(`/admin/users/${id}/verification`, {
        method: 'PATCH',
        body: { is_verified, verified_note: note },
      })
    },

    async set_admin_role(id: number, is_admin: boolean): Promise<void> {
      await request(`/admin/users/${id}/role`, {
        method: 'PATCH',
        body: { is_admin },
      })
    },

    async get_keywords(): Promise<{ fields: string[], keywords: string[], commands: string[] }> {
      return request_data<{ fields: string[], keywords: string[], commands: string[] }>('/admin/keywords')
    },
  }

  return {
    request,
    request_data,
    auth,
    profile,
    admin,
  }
}
