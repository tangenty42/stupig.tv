import { ApiError } from '@server/errors/ApiError'
import { verify_captcha } from '@server/lib/captcha'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { require_auth_user } from '@server/services/auth-guards.service'
import { change_profile_password, reset_profile_password } from '@server/services/profile.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  const auth_user = await require_auth_user(event)
  const body = await readBody(event)

  // Admin operating on another user: reset directly without captcha / old password.
  if (body?.operate_for !== undefined && body.operate_for !== null) {
    if (! auth_user.is_admin) {
      throw new ApiError(403, '需要管理员权限')
    }

    const { operate_for } = schema.profile_operate_target.parse(body)
    const payload = schema.profile_operate_password_reset.parse(body)

    await reset_profile_password(operate_for, payload.new_password)

    publish_refresh({ resource: sync_resource('auth_user', operate_for) })

    return ok(null, '密码已重置')
  }

  const { lot_number, captcha_output, pass_token, gen_time, ...rest } = body

  await verify_captcha({ lot_number, captcha_output, pass_token, gen_time })

  const payload = schema.profile_change_password.parse(rest)

  await change_profile_password(auth_user.id, payload)

  publish_refresh({ resource: sync_resource('auth_user', auth_user.id) })

  return ok(null, '密码已修改')
})
