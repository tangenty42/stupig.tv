import { admin_filter_fields } from '@server/services/admin-filter'
import {
  ban_user,
  force_logout_user,
  list_users,
  set_profile_verification,
  set_user_admin_role,
  set_user_permissions,
  unban_user,
} from '@server/services/admin.service'
import { get_background_status } from '@server/services/background/status.service'
import { get_storage_audit_findings } from '@server/services/storage-audit/service'
import { permission_procedure, router } from '@server/trpc/init'
import { api_schema } from '@server/trpc/schemas'
import { ADMIN_COMMANDS, ADMIN_FILTER_KEYWORDS } from '@shared/admin-command'

const admin_read_procedure = permission_procedure('admin_access', 'readonly')
const admin_full_procedure = permission_procedure('admin_access', 'full')

export const admin_router = router({
  getBackgroundStatus: admin_read_procedure.query(() => get_background_status()),
  getStorageAuditFindings: admin_read_procedure.input(api_schema.admin.storage_audit_findings).query(({ input }) => get_storage_audit_findings(input)),
  getSelf: admin_read_procedure.query(({ ctx }) => ({
    id: ctx.auth_user.id,
    username: ctx.auth_user.username,
    is_admin: ctx.auth_user.is_admin,
  })),

  getKeywords: admin_read_procedure.query(({ ctx }) => ({
    fields: admin_filter_fields(ctx.auth_user),
    keywords: ADMIN_FILTER_KEYWORDS,
    commands: ADMIN_COMMANDS,
  })),

  listUsers: admin_read_procedure
    .input(api_schema.admin.list_users)
    .query(({ ctx, input }) => list_users(ctx.auth_user, input)),

  setBanned: admin_full_procedure
    .input(api_schema.admin.set_banned)
    .mutation(async ({ ctx, input }) => {
      if (input.banned) {
        await ban_user(ctx.auth_user.id, input.id)
      }
      else {
        await unban_user(input.id)
      }
    }),

  forceLogout: admin_full_procedure
    .input(api_schema.admin.force_logout)
    .mutation(({ input }) => force_logout_user(input.id)),

  setVerification: admin_full_procedure
    .input(api_schema.admin.set_verification)
    .mutation(async ({ input }) => {
      await set_profile_verification(input.id, input.is_verified, input.verified_note)
    }),

  setRole: admin_full_procedure
    .input(api_schema.admin.set_role)
    .mutation(async ({ ctx, input }) => {
      await set_user_admin_role(ctx.auth_user.id, input.id, input.is_admin)
    }),

  setPermissions: admin_full_procedure
    .input(api_schema.admin.set_permissions)
    .mutation(async ({ input }) => {
      await set_user_permissions(input.id, input.permissions)
    }),
})
