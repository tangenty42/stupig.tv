import { require_auth_user } from '@server/services/auth-guards.service'
import { get_profile } from '@server/services/profile.service'
import { ok } from '@server/types/response'

export default defineEventHandler(async (event) => {
  const auth_user = await require_auth_user(event)
  const profile = await get_profile(auth_user, auth_user.id)

  return ok(profile)
})
