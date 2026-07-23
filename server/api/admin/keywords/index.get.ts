import { require_admin_user } from '@server/services/admin.service'
import { ok } from '@server/types/response'
import { ADMIN_FILTER_FIELDS } from '@shared/types/user'

export default defineEventHandler(async (event) => {
  await require_admin_user(event)

  const keywords = ['AND', 'OR', 'NOT', 'LIKE', 'IS', 'NULL', 'IN', 'BETWEEN', 'ORDER', 'BY', 'ASC', 'DESC']
  const commands = ['BAN', 'UNBAN', 'KICK', 'ALL']

  return ok({ fields: [...ADMIN_FILTER_FIELDS], keywords, commands })
})
