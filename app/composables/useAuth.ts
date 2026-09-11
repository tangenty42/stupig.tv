import type { AuthResult } from '@shared/types/auth'

export interface LoginUser {
  id: number
  username: string
  phone: string
  avatar_file: string | null
  avatar_version: string | null
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
      && (left.avatar_version ?? null) === (right.avatar_version ?? null)
      && left.is_verified === right.is_verified
      && Boolean(left.is_admin) === Boolean(right.is_admin)
  }

  function apply_auth(result: AuthResult) {
    const next_user = normalize_login_user(result.user)

    if (! is_same_login_user(user.value, next_user)) {
      user.value = next_user
    }

    broadcast_login(next_user.id)
  }

  function update_user(next_user: LoginUser) {
    const normalized_user = normalize_login_user(next_user)

    if (! is_same_login_user(user.value, normalized_user)) {
      user.value = normalized_user
    }
  }

  async function logout() {
    // Guards against a reload loop: the 401 handler calls this on every failed
    // request, and once the user cookie is gone there is nothing left to clear.
    if (! user.value) {
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
      // Ignore errors — clear local state regardless. The auth cookie is
      // httpOnly, so only the server can drop it; a 401 here means the session
      // was already gone, leaving an inert cookie that the next login replaces.
    }

    user.value = null

    broadcast_logout()

    info('再见！Ciao~')
    dead()

    reloadNuxtApp()
  }

  function handle_remote_logout() {
    if (! user.value) {
      return
    }

    user.value = null

    reloadNuxtApp()
  }

  return {
    user,
    apply_auth,
    update_user,
    logout,
    handle_remote_logout,
  }
}
