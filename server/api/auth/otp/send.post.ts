import { verify_captcha } from '@server/lib/captcha'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { require_auth_user } from '@server/services/auth-guards.service'
import { send_otp } from '@server/services/auth.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const { lot_number, captcha_output, pass_token, gen_time, ...rest } = body

  await verify_captcha({ lot_number, captcha_output, pass_token, gen_time })

  const identity_token = event.context.identity_token!

  // For change_password / verify_old_phone, use the authenticated user's phone
  if (rest.purpose === 'change_password' || rest.purpose === 'verify_old_phone') {
    const auth_user = await require_auth_user(event)
    const payload = schema.send_otp.parse({ ...rest, phone: auth_user.phone })
    await send_otp(payload, { identity_token })

    publish_refresh({ resource: sync_resource('otp_cooldown', payload.phone) })
    publish_refresh({ resource: sync_resource('otp_cooldown_by_identity', identity_token) })
    return ok(null, '验证码已发送')
  }

  const payload = schema.send_otp.parse(rest)
  await send_otp(payload, { identity_token })

  publish_refresh({ resource: sync_resource('otp_cooldown', payload.phone) })
  publish_refresh({ resource: sync_resource('otp_cooldown_by_identity', identity_token) })
  return ok(null, '验证码已发送')
})
