import { ApiError } from '@server/errors/ApiError'
import { require_auth_user } from '@server/services/auth-guards.service'
import { ok } from '@server/types/response'

export default defineEventHandler(async (event) => {
  try {
    await require_auth_user(event)
    return ok({ online: true })
  }
  catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) {
      return ok({ online: false })
    }
    throw error
  }
})
