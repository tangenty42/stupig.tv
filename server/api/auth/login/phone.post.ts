import { login_with_phone } from '@server/services/auth.service'
import { get_request_device_context } from '@server/services/session.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const payload = schema.login_with_phone.parse(body)
  const result = await login_with_phone(payload, get_request_device_context(event), event.context.identity_token!)

  return ok(result, '登录成功')
})
