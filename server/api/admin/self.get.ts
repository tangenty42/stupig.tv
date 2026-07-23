import { require_admin_user } from '@server/services/admin.service'
import { ok } from '@server/types/response'

export default defineEventHandler(async (event) => {
  const admin_user = await require_admin_user(event)

  return ok({
    id: admin_user.id,
    username: admin_user.username,
    is_admin: true,
  })
})
