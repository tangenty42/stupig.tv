import type { form_schema } from '@shared/schemas'
import type { SessionOverview } from '@shared/types/session'
import type { Profile } from '@shared/types/user'
import type { z } from 'zod'
import { has_permission } from '@shared/permissions'
import { settings } from '@shared/settings'
import { sync_resource } from '@shared/types/sync'
import { get_error_status } from '~/composables/useApi'

type BirthdayUpdate = z.output<typeof form_schema.profile_birthday_update>
type OperatedPasswordReset = z.output<typeof form_schema.profile_operate_password_reset>
type OperatedPhoneChange = z.output<typeof form_schema.profile_operate_phone_change>
type PasswordChange = z.output<typeof form_schema.profile_change_password>
type PasswordOtpChange = z.output<typeof form_schema.profile_change_password_by_otp>
type PhoneChange = z.output<typeof form_schema.profile_change_phone>

/** Public profile query and the viewer's relationship to its target account. */
export function useAccountProfile(profile_key: Readonly<Ref<string | number>>) {
  const { profile: profile_api } = useApi()
  const { user } = useAuth()
  const profile_id = computed(() => Number(profile_key.value))
  const resource = computed(() => Number.isSafeInteger(profile_id.value) && profile_id.value > 0
    ? sync_resource('profile', profile_id.value)
    : null)
  const query_key = computed(() => resource.value === null
    ? null
    : JSON.stringify([resource.value, user.value?.id, user.value?.is_admin, user.value?.permissions]))
  const state_key = `account_profile:${query_key.value}`
  const snapshot = useSyncedState<{ key: string, profile: Profile | null } | null>(state_key, () => null)
  const loading = useState(`${state_key}:loading`, () => false)
  const failed_key = useState<string | null>(`${state_key}:failure`, () => null)
  const current = computed(() => snapshot.value?.key === query_key.value ? snapshot.value : null)
  const profile = computed(() => current.value?.profile ?? null)
  const failed = computed(() => failed_key.value !== null && failed_key.value === query_key.value)
  const missing = computed(() => query_key.value === null || current.value?.profile === null)
  const is_operating_other = computed(() => {
    return has_permission(user.value, 'admin_access', 'full')
      && !! profile.value
      && profile.value.id !== user.value?.id
  })
  const is_viewing_other = computed(() => !! profile.value && profile.value.id !== user.value?.id)

  async function fetch_profile() {
    const key = query_key.value
    if (key === null)
      return null
    try {
      return { key, profile: await profile_api.get_profile(profile_id.value) }
    }
    catch (error) {
      if (get_error_status(error) === 404)
        return { key, profile: null }
      throw error
    }
  }

  const ready = useSyncedData(
    resource,
    fetch_profile,
    snapshot,
    loading,
    {
      query_key,
      polling_interval: settings.app.online.pollIntervalSeconds * 1000,
      on_data: () => { failed_key.value = null },
      on_error: () => { failed_key.value = query_key.value },
      default_error_toast: true,
    },
  )

  return { profile, loading, failed, missing, is_operating_other, is_viewing_other, ready }
}

/** Editable profile fields that are not account credentials. */
export function useAccountProfileDetails(profile: Readonly<Ref<Profile>>, is_operating_other: Readonly<Ref<boolean>>) {
  const { profile: profile_api } = useApi()
  const { error, ok } = useMyToast()
  const birthday_pending = ref(false)
  const avatar_delete_pending = ref(false)

  async function update_birthday(values: BirthdayUpdate) {
    birthday_pending.value = true
    try {
      await profile_api.update_birthday(values.birthday, is_operating_other.value ? profile.value.id : null)
      ok('生日更新成功！')
      return true
    }
    catch (exception) {
      error(exception)
      return false
    }
    finally {
      birthday_pending.value = false
    }
  }

  async function delete_avatar() {
    avatar_delete_pending.value = true
    try {
      await profile_api.delete_avatar(is_operating_other.value ? profile.value.id : null)
      ok('头像已删除！')
      return true
    }
    catch (exception) {
      error(exception)
      return false
    }
    finally {
      avatar_delete_pending.value = false
    }
  }

  return { birthday_pending, avatar_delete_pending, update_birthday, delete_avatar }
}

/** Password, phone and OTP operations for the selected account. */
export function useAccountSecurity(profile: Readonly<Ref<Profile>>) {
  const { auth, profile: profile_api } = useApi()
  const { verify: verify_captcha } = useCaptcha()
  const { error, ok } = useMyToast()
  const password_pending = ref(false)
  const password_otp_pending = ref(false)
  const operate_password_pending = ref(false)
  const operate_phone_pending = ref(false)
  const phone_change_pending = ref(false)

  async function perform(pending: Ref<boolean>, action: () => Promise<unknown>, message: string) {
    pending.value = true
    try {
      await action()
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

  function reset_password_for(values: OperatedPasswordReset) {
    return perform(
      operate_password_pending,
      () => profile_api.reset_password_for(profile.value.id, values),
      '密码已修改！',
    )
  }

  function change_phone_for(values: OperatedPhoneChange) {
    return perform(
      operate_phone_pending,
      () => profile_api.change_phone_for(profile.value.id, values.new_phone),
      '手机号已更换！',
    )
  }

  function change_password(values: PasswordChange) {
    return perform(password_pending, async () => {
      const captcha = await verify_captcha()
      await profile_api.change_password({ ... values, ... captcha })
    }, '密码已修改！')
  }

  function change_password_by_otp(values: PasswordOtpChange) {
    return perform(password_otp_pending, async () => {
      const captcha = await verify_captcha()
      await profile_api.change_password_by_otp({ ... values, ... captcha })
    }, '密码已修改！')
  }

  function change_phone(values: PhoneChange) {
    return perform(phone_change_pending, async () => {
      const captcha = await verify_captcha()
      await profile_api.change_phone({ ... values, ... captcha })
    }, '手机号已更换！')
  }

  async function send_otp(purpose: 'change_password' | 'verify_old_phone' | 'change_phone', phone?: string) {
    try {
      const captcha = await verify_captcha()
      await auth.send_otp({ ... (phone ? { phone } : {}), purpose, ... captcha })
      ok('验证码已发送！')
      return true
    }
    catch (exception) {
      error(exception)
      return false
    }
  }

  return {
    password_pending,
    password_otp_pending,
    operate_password_pending,
    operate_phone_pending,
    phone_change_pending,
    reset_password_for,
    change_phone_for,
    change_password,
    change_password_by_otp,
    change_phone,
    send_otp,
  }
}

/**
 * Login-session query and revocation for the selected profile. Reading needs
 * `sensitive_readable`; the server rejects revoking another account's device
 * unless the viewer may edit it.
 */
export function useAccountSessions(profile: Readonly<Ref<Profile>>, is_viewing_other: Readonly<Ref<boolean>>) {
  const { profile: profile_api } = useApi()
  const { user } = useAuth()
  const { error: toast_error, ok } = useMyToast()
  const resource = computed(() => {
    const viewer = user.value
    const target = profile.value
    if (! viewer || ! target.sensitive_readable)
      return null
    const readable = is_viewing_other.value
      ? viewer.id !== target.id && has_permission(viewer, 'admin_access', 'readonly')
      : viewer.id === target.id
    return readable ? sync_resource('profile_sessions', target.id) : null
  })
  const query_key = computed(() => resource.value ? `${resource.value}:${user.value!.id}:${Boolean(user.value!.is_admin)}` : null)
  const state_key = query_key.value ?? 'inactive'
  interface SessionSnapshot { key: string, sessions: SessionOverview | null, denied?: string }
  const snapshot = useSyncedState<SessionSnapshot | null>(`account_sessions:${state_key}`, () => null)
  const sessions = computed(() => snapshot.value?.key === query_key.value ? snapshot.value?.sessions ?? null : null)
  const loading = useState(`account_sessions_loading:${state_key}`, () => false)
  const failed_key = useState<string | null>(`account_sessions_error:${state_key}`, () => null)
  const failure_toast_key = useState<string | null>(`account_sessions_failure_toast:${state_key}`, () => null)
  const load_failed = computed(() => failed_key.value !== null && failed_key.value === query_key.value)
  const pending_id = ref<number | null>(null)
  let identity_generation = 0
  watch(query_key, () => {
    identity_generation ++
    snapshot.value = null
    failed_key.value = null
    failure_toast_key.value = null
    pending_id.value = null
  }, { flush: 'sync' })

  async function fetch_sessions(): Promise<SessionSnapshot | null> {
    const key = query_key.value
    if (key === null)
      return null
    try {
      const sessions = await (is_viewing_other.value ? profile_api.get_user_sessions(profile.value.id) : profile_api.get_my_sessions())
      return { key, sessions }
    }
    catch (exception) {
      if (get_error_status(exception) !== 403)
        throw exception
      // Replace the shared Query's previous data with the confirmed denial.
      return { key, sessions: null, denied: exception instanceof Error && exception.message ? exception.message : '权限不足' }
    }
  }

  function report_failure(exception: unknown) {
    const key = query_key.value
    failed_key.value = key
    if (! import.meta.server && key !== null && failure_toast_key.value !== key) {
      failure_toast_key.value = key
      toast_error(exception)
    }
  }

  const ready = useSyncedData(
    resource,
    fetch_sessions,
    snapshot,
    loading,
    {
      query_key,
      polling_interval: settings.app.online.pollIntervalSeconds * 1000,
      on_data: (value) => {
        if (value?.denied) {
          report_failure(value.denied)
        }
        else {
          failed_key.value = null
          failure_toast_key.value = null
        }
      },
      on_error: report_failure,
    },
  )

  async function refresh() {
    failure_toast_key.value = null
    await (await ready).refresh()
  }

  async function force_logout(id: number) {
    if (! query_key.value || ! profile.value.editable || (is_viewing_other.value && ! has_permission(user.value, 'admin_access', 'full')))
      return false
    const generation = identity_generation
    pending_id.value = id
    try {
      if (is_viewing_other.value) {
        await profile_api.force_logout_user_session(profile.value.id, id)
      }
      else {
        await profile_api.force_logout_session(id)
      }
      if (generation === identity_generation)
        ok('设备已退出登录状态')
      return true
    }
    catch (exception) {
      if (generation === identity_generation)
        toast_error(exception)
      return false
    }
    finally {
      if (generation === identity_generation && pending_id.value === id)
        pending_id.value = null
    }
  }

  return { sessions, active: computed(() => resource.value !== null), loading, load_failed, pending_id, ready, refresh, force_logout }
}
