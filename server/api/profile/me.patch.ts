import { publish_refresh, sync_resource } from '@server/lib/sync'
import { resolve_operate_target } from '@server/services/auth-guards.service'
import { update_profile } from '@server/services/profile.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const payload = schema.profile_birthday_update.parse(body)

  const { target_id } = await resolve_operate_target(event, payload.operate_for)

  await update_profile(target_id, payload)

  publish_refresh({ resource: sync_resource('profile', target_id) })
  publish_refresh({ resource: sync_resource('auth_user', target_id) })

  return ok(null, '资料已更新')
})
