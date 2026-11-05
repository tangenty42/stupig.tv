import type { form_schema } from '@shared/schemas'
import type { z } from 'zod'
import type { LoginUser } from '~/composables/useAuth'
import { settings } from '@shared/settings'
import { sync_resource } from '@shared/types/sync'

type PasswordLogin = z.output<typeof form_schema.login_with_password>
type PhoneLogin = z.output<typeof form_schema.login_with_phone>
type Registration = z.output<typeof form_schema.register>

function login_user_from_profile(profile: Awaited<ReturnType<ReturnType<typeof useApi>['profile']['get_me']>>, current: LoginUser) {
  return {
    id: profile.id,
    username: profile.username,
    phone: profile.phone || current.phone || '',
    avatar_file: profile.avatar_file,
    avatar_version: profile.avatar_version,
    is_verified: profile.is_verified,
    is_admin: profile.is_admin,
    permissions: profile.permissions,
  }
}

/** Application-scoped identity snapshot and its profile/permission refresh. */
export function useAccountIdentity() {
  const auth = useAuth()
  const { profile } = useApi()
  const synced_user = useSyncedState(auth.user)
  const resource = computed(() => auth.user.value?.id ? sync_resource('auth_user', auth.user.value.id) : null)

  async function fetch_current_user(): Promise<LoginUser | null> {
    const current = auth.user.value
    if (! current) {
      return null
    }
    return login_user_from_profile(await profile.get_me(), current)
  }

  const ready = useSyncedData(
    resource,
    fetch_current_user,
    synced_user,
    {
      // Account notifications are hints: publisher restarts can lose an event
      // while the browser's persistent broker session remains intact.
      polling_interval: settings.app.auth.syncPollIntervalSeconds * 1000,
      on_data: (next_user) => {
        const current = auth.user.value
        if (! next_user || ! current || next_user.id !== current.id) {
          return
        }
        auth.update_user(next_user)
      },
    },
  )

  return { ... auth, ready }
}

/** Login, registration and their verification challenge as one interaction flow. */
export function useAccountAuthFlow() {
  const { auth } = useApi()
  const { apply_auth } = useAuth()
  const { verify: verify_captcha, showing: captcha_showing } = useCaptcha()
  const { error, ok, info } = useMyToast()
  const pending = ref(false)
  const otp_pending = ref(false)
  const locked = computed(() => pending.value || otp_pending.value || captcha_showing.value)

  async function authenticate(action: () => ReturnType<typeof auth.login_with_password>, message: string) {
    pending.value = true
    try {
      apply_auth(await action())
      ok(message)
      return true
    }
    catch (exception) {
      error(exception)
      return false
    }
    finally {
      pending.value = false
    }
  }

  async function send_otp(phone: string, purpose: 'login' | 'register') {
    otp_pending.value = true
    try {
      const captcha = await verify_captcha()
      await auth.send_otp({ phone, purpose, ... captcha })
      info('验证码发送成功！')
      return true
    }
    catch (exception) {
      error(exception)
      return false
    }
    finally {
      otp_pending.value = false
    }
  }

  function login_with_password(values: PasswordLogin) {
    return authenticate(async () => {
      const captcha = await verify_captcha()
      return auth.login_with_password({ ... values, ... captcha })
    }, '登录成功！')
  }

  function login_with_phone(values: PhoneLogin) {
    return authenticate(async () => {
      await verify_captcha()
      return auth.login_with_phone(values)
    }, '登录成功！')
  }

  function register(values: Registration) {
    return authenticate(async () => {
      await verify_captcha()
      return auth.register(values)
    }, '注册成功！欢迎新生小猪~')
  }

  return { pending, otp_pending, locked, send_otp, login_with_password, login_with_phone, register }
}
