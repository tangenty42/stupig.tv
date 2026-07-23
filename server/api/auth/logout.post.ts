import { publish_refresh, sync_resource } from '@server/lib/sync'
import { require_auth_user } from '@server/services/auth-guards.service'
import { logout_session_by_token_hash } from '@server/services/session.service'
import { ok } from '@server/types/response'

export default defineEventHandler(async (event) => {
  const auth_user = await require_auth_user(event)
  await logout_session_by_token_hash(auth_user.token_hash)

  publish_refresh({ resource: sync_resource('profile_sessions', auth_user.id) })
  publish_refresh({ resource: sync_resource('auth_user', auth_user.id) })

  return ok(null, '已退出登录')
})
