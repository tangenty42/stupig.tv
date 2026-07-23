import { publish_refresh, sync_resource } from '@server/lib/sync'
import { ban_user, require_admin_user, unban_user } from '@server/services/admin.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'
import { z } from 'zod'

const ban_schema = z.object({
  banned: z.boolean(),
})

export default defineEventHandler(async (event) => {
  await require_admin_user(event)
  const params = getRouterParams(event)
  const body = await readBody(event)

  const { id } = schema.profile_public_id.parse(params)
  const { banned } = ban_schema.parse(body)

  if (banned) {
    await ban_user(id)
  }
  else {
    await unban_user(id)
  }

  publish_refresh({ resource: sync_resource('profile', id) })
  publish_refresh({ resource: sync_resource('auth_user', id) })

  return ok(null, banned ? '用户已被禁用' : '用户已恢复')
})
