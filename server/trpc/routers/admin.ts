import {
  ban_user,
  force_logout_user,
  list_users,
  set_profile_verification,
  set_user_admin_role,
  unban_user,
} from '@server/services/admin.service'
import { admin_procedure, router } from '@server/trpc/init'
import { api_schema } from '@server/trpc/schemas'
import { ADMIN_FILTER_FIELDS } from '@shared/types/user'

export const admin_router = router({
  getSelf: admin_procedure.query(({ ctx }) => ({
    id: ctx.auth_user.id,
    username: ctx.auth_user.username,
    is_admin: true as const,
  })),

  getKeywords: admin_procedure.query(() => ({
    fields: ADMIN_FILTER_FIELDS,
    keywords: ['AND', 'OR', 'NOT', 'LIKE', 'IS', 'NULL', 'IN', 'BETWEEN', 'ORDER', 'BY', 'ASC', 'DESC'],
    commands: ['BAN', 'UNBAN', 'KICK', 'ALL'],
  })),

  listUsers: admin_procedure
    .input(api_schema.admin.list_users)
    .query(({ ctx, input }) => list_users(ctx.auth_user, input)),

  setBanned: admin_procedure
    .input(api_schema.admin.set_banned)
    .mutation(async ({ input }) => {
      if (input.banned) {
        await ban_user(input.id)
      }
      else {
        await unban_user(input.id)
      }
    }),

  forceLogout: admin_procedure
    .input(api_schema.admin.force_logout)
    .mutation(({ input }) => force_logout_user(input.id)),

  setVerification: admin_procedure
    .input(api_schema.admin.set_verification)
    .mutation(async ({ input }) => {
      await set_profile_verification(input.id, input.is_verified, input.verified_note)
    }),

  setRole: admin_procedure
    .input(api_schema.admin.set_role)
    .mutation(async ({ input }) => {
      await set_user_admin_role(input.id, input.is_admin)
    }),
})
