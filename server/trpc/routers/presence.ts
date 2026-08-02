import { ApiError } from '@server/errors/ApiError'
import { require_auth_user } from '@server/services/auth-guards.service'
import { public_procedure, router } from '@server/trpc/init'

export const presence_router = router({
  ping: public_procedure.query(async ({ ctx }) => {
    try {
      await require_auth_user(ctx.event)
      return { online: true }
    }
    catch (error) {
      if (error instanceof ApiError && error.statusCode === 401) {
        return { online: false }
      }
      throw error
    }
  }),
})
