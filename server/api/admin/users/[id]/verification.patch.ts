import { publish_refresh, sync_resource } from '@server/lib/sync'
import { require_admin_user, set_profile_verification } from '@server/services/admin.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  await require_admin_user(event)
  const params = getRouterParams(event)
  const body = await readBody(event)

  const { id } = schema.profile_public_id.parse(params)
  const { is_verified, verified_note } = schema.admin_profile_verification.parse(body)

  await set_profile_verification(id, is_verified, verified_note)

  publish_refresh({ resource: sync_resource('profile', id) })
  publish_refresh({ resource: sync_resource('auth_user', id) })

  return ok(null, is_verified ? '认证徽章已授予' : '认证徽章已移除')
})
