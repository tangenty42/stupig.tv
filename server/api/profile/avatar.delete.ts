import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { resolve_operate_target } from '@server/services/auth-guards.service'
import { delete_profile_avatar } from '@server/services/profile.service'
import { ok } from '@server/types/response'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const operate_for_raw = query.operate_for ? Number(query.operate_for) : null

  const { target_id } = await resolve_operate_target(event, Number.isInteger(operate_for_raw) && operate_for_raw ! > 0 ? operate_for_raw : null)

  const { previous_file } = await delete_profile_avatar(target_id)

  if (previous_file) {
    const static_root = useRuntimeConfig(event).static_root

    try {
      await unlink(join(static_root, 'avatar', previous_file))
    }
    catch {
    }
  }

  publish_refresh({ resource: sync_resource('profile', target_id) })
  publish_refresh({ resource: sync_resource('auth_user', target_id) })

  return ok(null, '头像已删除')
})
