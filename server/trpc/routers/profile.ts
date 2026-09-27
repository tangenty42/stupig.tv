import { require_auth_user, resolve_operate_target } from '@server/services/auth-guards.service'
import {
  change_profile_password,
  change_profile_password_by_otp,
  change_profile_phone,
  delete_profile_avatar,
  force_logout_session,
  get_profile,
  reset_profile_password,
  set_profile_phone,
  update_profile,
  upload_profile_avatar,
} from '@server/services/profile.service'
import { get_login_sessions } from '@server/services/session.service'
import { permission_procedure, protected_procedure, public_procedure, router } from '@server/trpc/init'
import { api_schema } from '@server/trpc/schemas'

const admin_edit_procedure = permission_procedure('admin_access', 'full')

export const profile_router = router({
  get: public_procedure
    .input(api_schema.profile.get)
    .query(async ({ ctx, input }) => {
      let viewer = null
      try {
        viewer = await require_auth_user(ctx.event)
      }
      catch {
        viewer = null
      }
      return get_profile(viewer, input.id)
    }),

  getMe: protected_procedure.query(({ ctx }) => get_profile(ctx.auth_user, ctx.auth_user.id)),

  updateBirthday: public_procedure
    .input(api_schema.profile.update_birthday)
    .mutation(async ({ ctx, input }) => {
      const { target_id } = await resolve_operate_target(ctx.event, input.operate_for)
      await update_profile(target_id, input)
    }),

  getSessions: public_procedure
    .input(api_schema.profile.get_sessions)
    .query(async ({ ctx, input }) => {
      const { auth_user, target_id } = await resolve_operate_target(ctx.event, input?.operate_for)
      return get_login_sessions(
        target_id,
        target_id === auth_user.id ? auth_user.session_id : null,
      )
    }),

  forceLogoutSession: public_procedure
    .input(api_schema.profile.force_logout_session)
    .mutation(async ({ ctx, input }) => {
      const { target_id } = await resolve_operate_target(ctx.event, input.operate_for)
      await force_logout_session(target_id, input.id)
    }),

  resetPasswordFor: admin_edit_procedure
    .input(api_schema.profile.reset_password_for)
    .mutation(({ input }) => reset_profile_password(input.operate_for, input.new_password)),

  changePassword: protected_procedure
    .input(api_schema.profile.change_password)
    .mutation(({ ctx, input }) => change_profile_password(ctx.auth_user.id, input)),

  changePasswordByOtp: protected_procedure
    .input(api_schema.profile.change_password_by_otp)
    .mutation(({ ctx, input }) => change_profile_password_by_otp(ctx.auth_user, input)),

  changePhoneFor: admin_edit_procedure
    .input(api_schema.profile.change_phone_for)
    .mutation(({ input }) => set_profile_phone(input.operate_for, input.new_phone)),

  changePhone: protected_procedure
    .input(api_schema.profile.change_phone)
    .mutation(({ ctx, input }) => change_profile_phone(ctx.auth_user, input)),

  uploadAvatar: public_procedure
    .input(api_schema.profile.upload_avatar)
    .mutation(async ({ ctx, input }) => {
      const operate_for_raw = input.get('operate_for')
      const operate_for = typeof operate_for_raw === 'string' && operate_for_raw
        ? Number(operate_for_raw)
        : null
      const { target_id } = await resolve_operate_target(
        ctx.event,
        Number.isInteger(operate_for) && operate_for! > 0 ? operate_for : null,
      )

      await upload_profile_avatar(target_id, input, () => {
        const config = useRuntimeConfig(ctx.event)
        return {
          max_size_mb: config.public.max_avatar_size_mb as number,
        }
      })
    }),

  deleteAvatar: public_procedure
    .input(api_schema.profile.delete_avatar)
    .mutation(async ({ ctx, input }) => {
      const { target_id } = await resolve_operate_target(ctx.event, input?.operate_for)
      await delete_profile_avatar(target_id)
    }),
})
