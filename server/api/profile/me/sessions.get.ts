import { resolve_operate_target } from '@server/services/auth-guards.service'
import { get_login_sessions } from '@server/services/session.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const operate = schema.profile_operate_target.partial().parse(query)

  const { auth_user, target_id } = await resolve_operate_target(event, operate.operate_for ?? null)

  const sessions = await get_login_sessions(
    target_id,
    target_id === auth_user.id ? auth_user.token_hash : null,
  )

  return ok(sessions)
})
