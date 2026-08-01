import { register_user } from '@server/services/auth.service'
import { get_request_device_context } from '@server/services/session.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const payload = schema.register.parse(body)
  const { confirm_password: _confirm_password, ...register_input } = payload
  const result = await register_user(register_input, get_request_device_context(event), event.context.identity_token!)

  setResponseStatus(event, 201)
  return ok(result, '注册成功')
})
