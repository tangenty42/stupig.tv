import { ApiError } from '@server/errors/ApiError'
import { verify_captcha } from '@server/lib/captcha'
import { check_otp_sms } from '@server/lib/sms'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { require_auth_user } from '@server/services/auth-guards.service'
import { change_profile_phone, set_profile_phone } from '@server/services/profile.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  const auth_user = await require_auth_user(event)
  const body = await readBody(event)

  // Admin operating on another user: change directly without captcha / OTP.
  if (body?.operate_for !== undefined && body.operate_for !== null) {
    if (! auth_user.is_admin) {
      throw new ApiError(403, '需要管理员权限')
    }

    const { operate_for } = schema.profile_operate_target.parse(body)
    const payload = schema.profile_operate_phone_change.parse(body)

    await set_profile_phone(operate_for, payload.new_phone)

    publish_refresh({ resource: sync_resource('profile', operate_for) })
    publish_refresh({ resource: sync_resource('auth_user', operate_for) })

    return ok(null, '手机号已更新')
  }

  const { lot_number, captcha_output, pass_token, gen_time, ...rest } = body

  await verify_captcha({ lot_number, captcha_output, pass_token, gen_time })

  const payload = schema.profile_change_phone.parse(rest)

  if (! auth_user.phone) {
    throw createError({ statusCode: 400, statusMessage: '当前账号未绑定手机号，无法验证原手机号' })
  }

  await check_otp_sms({ phone: auth_user.phone, code: payload.old_otp })
  await check_otp_sms({ phone: payload.new_phone, code: payload.new_otp })

  await change_profile_phone(auth_user.id, payload)

  publish_refresh({ resource: sync_resource('profile', auth_user.id) })
  publish_refresh({ resource: sync_resource('auth_user', auth_user.id) })

  return ok(null, '手机号已更新')
})
