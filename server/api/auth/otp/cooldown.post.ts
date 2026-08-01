import { get_otp_cooldown } from '@server/services/auth.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  const identity_token = event.context.identity_token!
  const body = await readBody(event)
  const payload = schema.otp_cooldown.parse(body)

  const result = await get_otp_cooldown({
    identity_token,
    phone: payload.phone,
  })

  return ok(result)
})
