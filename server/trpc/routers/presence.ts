import { optional_auth_user, public_procedure, router } from '@server/trpc/init'

export const presence_router = router({
  ping: public_procedure.query(async ({ ctx }) => ({ online: !! await optional_auth_user(ctx.event) })),
})
