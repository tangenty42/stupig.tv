import { list_users, require_admin_user } from '@server/services/admin.service'
import { ok } from '@server/types/response'

export default defineEventHandler(async (event) => {
  const admin = await require_admin_user(event)

  const query = getQuery(event)

  const page = Number(query.page) || 1
  const page_size = Number(query.page_size) || 10
  const filter = query.filter ? String(query.filter) : undefined

  const result = await list_users(admin, { page, page_size, filter })

  return ok(result)
})
