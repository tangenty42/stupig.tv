import { publish_refresh, sync_resource } from '@server/lib/sync'
import { require_admin_user, set_user_admin_role } from '@server/services/admin.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  await require_admin_user(event)
  const params = getRouterParams(event)
  const body = await readBody(event)

  const { id } = schema.profile_public_id.parse(params)
  const { is_admin } = schema.admin_user_role.parse(body)

  await set_user_admin_role(id, is_admin)

  publish_refresh({ resource: sync_resource('profile', id) })
  publish_refresh({ resource: sync_resource('auth_user', id) })

  return ok(null, is_admin ? '管理员权限已授予' : '管理员权限已移除')
})
