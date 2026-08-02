import { protected_procedure, public_procedure, router } from '@server/trpc/init'
import { admin_router } from '@server/trpc/routers/admin'
import { auth_router } from '@server/trpc/routers/auth'
import { content_router } from '@server/trpc/routers/content'
import { presence_router } from '@server/trpc/routers/presence'
import { profile_router } from '@server/trpc/routers/profile'

const system_router = router({
  health: public_procedure.query(() => ({ online: true })),
  me: protected_procedure.query(({ ctx }) => ({
    id: ctx.auth_user.id,
    username: ctx.auth_user.username,
    is_admin: ctx.auth_user.is_admin,
  })),
})

export const app_router = router({
  admin: admin_router,
  auth: auth_router,
  content: content_router,
  presence: presence_router,
  profile: profile_router,
  system: system_router,
})

export type AppRouter = typeof app_router
