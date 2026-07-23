import { verify_captcha } from '@server/lib/captcha'
import { check_otp_sms } from '@server/lib/sms'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { require_auth_user } from '@server/services/auth-guards.service'
import { change_profile_password_by_otp } from '@server/services/profile.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  const auth_user = await require_auth_user(event)
  const body = await readBody(event)
  const { lot_number, captcha_output, pass_token, gen_time, ...rest } = body

  await verify_captcha({ lot_number, captcha_output, pass_token, gen_time })

  const payload = schema.profile_change_password_by_otp.parse(rest)

  await check_otp_sms({ phone: auth_user.phone, code: payload.otp })

  await change_profile_password_by_otp(auth_user.id, payload)

  publish_refresh({ resource: sync_resource('auth_user', auth_user.id) })

  return ok(null, '密码已修改')
})
