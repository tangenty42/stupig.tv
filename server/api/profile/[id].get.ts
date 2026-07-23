import type { AuthUser } from '@server/types/auth'
import { require_auth_user } from '@server/services/auth-guards.service'
import { get_profile } from '@server/services/profile.service'
import { ok } from '@server/types/response'

export default defineEventHandler(async (event) => {
  const params = getRouterParams(event)
  const id = Number(params.id)

  if (! Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: '无效的用户 ID' })
  }

  let viewer: AuthUser | null = null
  try {
    viewer = await require_auth_user(event)
  }
  catch {
    viewer = null
  }

  const profile = await get_profile(viewer, id)

  return ok(profile)
})
