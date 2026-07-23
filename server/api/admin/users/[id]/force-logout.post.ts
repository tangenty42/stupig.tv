import { force_logout_user, require_admin_user } from '@server/services/admin.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  await require_admin_user(event)

  const params = getRouterParams(event)
  const { id } = schema.profile_public_id.parse(params)

  await force_logout_user(id)

  return ok(null, '该用户已被强制下线')
})
