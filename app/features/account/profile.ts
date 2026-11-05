import type { form_schema } from '@shared/schemas'
import type { SessionOverview } from '@shared/types/session'
import type { Profile } from '@shared/types/user'
import type { z } from 'zod'
import { has_permission } from '@shared/permissions'
import { settings } from '@shared/settings'
import { sync_resource } from '@shared/types/sync'

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
  const profile = useSyncedState<Profile | null>('profile', () => null)
  const loading = useState('sync_loading', () => false)
  const profile_id = computed(() => Number(profile_key.value))
  const resource = computed(() => Number.isInteger(profile_id.value) && profile_id.value > 0
    ? sync_resource('profile', profile_id.value)
    : null)
  const is_operating_other = computed(() => {
    return has_permission(user.value, 'admin_access', 'full')
      && !! profile.value
      && profile.value.id !== user.value?.id
  })

  async function fetch_profile() {
    if (! Number.isInteger(profile_id.value) || profile_id.value <= 0) {
      throw new Error('？？？')
    }
    return profile_api.get_profile(profile_id.value)
  }

  const ready = useSyncedData(
    resource,
    fetch_profile,
    profile,
    loading,
    {
      throw_resource_null_error: true,
      polling_interval: settings.app.online.pollIntervalSeconds * 1000,
    },
  )

  return { profile, loading, is_operating_other, ready }
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
    }, '密码修改成功！')
  }

  function change_password_by_otp(values: PasswordOtpChange) {
    return perform(password_otp_pending, async () => {
      const captcha = await verify_captcha()
      await profile_api.change_password_by_otp({ ... values, ... captcha })
    }, '密码修改成功！')
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

/** Login-session query and revocation for the selected editable profile. */
export function useAccountSessions(profile: Readonly<Ref<Profile>>, is_operating_other: Readonly<Ref<boolean>>) {
  const { profile: profile_api } = useApi()
  const { error, ok } = useMyToast()
  const sessions = useSyncedState<SessionOverview | null>('profile_sessions', () => null)
  const loading = useState('profile_sessions_loading', () => false)
  const pending_id = ref<number | null>(null)
  const resource = computed(() => profile.value.editable ? sync_resource('profile_sessions', profile.value.id) : null)

  function fetch_sessions() {
    return is_operating_other.value
      ? profile_api.get_user_sessions(profile.value.id)
      : profile_api.get_my_sessions()
  }

  const ready = useSyncedData(
    resource,
    fetch_sessions,
    sessions,
    loading,
    {
      throw_resource_null_error: false,
      polling_interval: settings.app.online.pollIntervalSeconds * 1000,
    },
  )

  async function force_logout(id: number) {
    pending_id.value = id
    try {
      if (is_operating_other.value) {
        await profile_api.force_logout_user_session(profile.value.id, id)
      }
      else {
        await profile_api.force_logout_session(id)
      }
      ok('设备已退出登录状态')
      return true
    }
    catch (exception) {
      error(exception)
      return false
    }
    finally {
      pending_id.value = null
    }
  }

  return { sessions, loading, pending_id, ready, force_logout }
}
