import type { AuthResult } from '@shared/types/auth'

export interface LoginUser {
  id: number
  username: string
  phone: string
  avatar_file: string | null
  is_verified: boolean
  is_admin?: boolean
}

export function useAuth() {
  const runtime_config = useRuntimeConfig()
  const config = runtime_config.public
  const { info, dead } = useMyToast()

  const user = useCookie<LoginUser | null>(config.auth_user_cookie_name, {
    default: () => null,
    sameSite: 'lax',
    maxAge: config.cookie_max_age,
  })
  const token = useCookie<string | null>(config.auth_token_cookie_name, {
    default: () => null,
    sameSite: 'lax',
    maxAge: config.cookie_max_age,
  })

  function normalize_login_user(input: LoginUser) {
    return {
      ... input,
      is_admin: Boolean(input.is_admin),
    }
  }

  function is_same_login_user(left: LoginUser | null, right: LoginUser) {
    return !! left
      && left.id === right.id
      && left.username === right.username
      && left.phone === right.phone
      && left.avatar_file === right.avatar_file
      && left.is_verified === right.is_verified
      && Boolean(left.is_admin) === Boolean(right.is_admin)
  }

  function apply_auth(result: AuthResult) {
    const next_user = normalize_login_user(result.user)

    if (! is_same_login_user(user.value, next_user)) {
      user.value = next_user
    }

    token.value = result.token

    broadcast_login(next_user.id)
  }

  function update_user(next_user: LoginUser) {
    const normalized_user = normalize_login_user(next_user)

    if (! is_same_login_user(user.value, normalized_user)) {
      user.value = normalized_user
    }
  }

  async function logout() {
    if (! user.value && ! token.value) {
      return
    }

    try {
      await $fetch(`${config.api_base}/trpc/auth.logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      })
    }
    catch {
      // Ignore errors — clear local state regardless
    }

    user.value = null
    token.value = null

    broadcast_logout()

    info('再见！Ciao~')
    dead()

    reloadNuxtApp()
  }

  function handle_remote_logout() {
    if (! user.value && ! token.value) {
      return
    }

    user.value = null
    token.value = null

    reloadNuxtApp()
  }

  return {
    user,
    token,
    apply_auth,
    update_user,
    logout,
    handle_remote_logout,
  }
}
