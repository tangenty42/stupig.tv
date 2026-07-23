import { publish_refresh, sync_resource } from '@server/lib/sync'
import { resolve_operate_target } from '@server/services/auth-guards.service'
import { force_logout_session } from '@server/services/profile.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  const params = getRouterParams(event)
  const id = Number(params.id)

  const query = getQuery(event)
  const operate = schema.profile_operate_target.partial().parse(query)

  const { target_id } = await resolve_operate_target(event, operate.operate_for ?? null)

  await force_logout_session(target_id, id)
  publish_refresh({ resource: sync_resource('auth_user', target_id) })
  publish_refresh({ resource: sync_resource('profile', target_id) })
  publish_refresh({ resource: sync_resource('profile_sessions', target_id) })

  return ok(null, '设备已退出登录状态')
})
