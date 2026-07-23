import { verify_captcha } from '@server/lib/captcha'
import { login_with_password } from '@server/services/auth.service'
import { get_request_device_context } from '@server/services/session.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const { lot_number, captcha_output, pass_token, gen_time, ...rest } = body

  await verify_captcha({ lot_number, captcha_output, pass_token, gen_time })

  const payload = schema.login_with_password.parse(rest)
  const result = await login_with_password(payload, get_request_device_context(event), event.context.identity_token !)

  return ok(result, '登录成功')
})
