import type { TrpcContext } from '@server/trpc/context'
import { ApiError } from '@server/errors/ApiError'
import { get_otp_cooldown, login_with_password, login_with_phone, logout_user, register_user, send_otp_for_request } from '@server/services/auth.service'
import { get_request_device_context } from '@server/services/session.service'
import { protected_procedure, public_procedure, router } from '@server/trpc/init'
import { api_schema } from '@server/trpc/schemas'

function get_identity_token(ctx: TrpcContext) {
  const identity_token = (ctx.event.context as { identity_token?: string }).identity_token
  if (! identity_token) {
    throw new ApiError(500, '无法识别当前设备')
  }
  return identity_token
}

export const auth_router = router({
  register: public_procedure
    .input(api_schema.auth.register)
    .mutation(async ({ ctx, input }) => {
      const { confirm_password: _confirm_password, ... register_input } = input
      return register_user(
        register_input,
        get_request_device_context(ctx.event),
        get_identity_token(ctx),
      )
    }),

  loginWithPassword: public_procedure
    .input(api_schema.auth.login_with_password)
    .mutation(({ ctx, input }) => login_with_password(
      input,
      get_request_device_context(ctx.event),
      get_identity_token(ctx),
    )),

  loginWithPhone: public_procedure
    .input(api_schema.auth.login_with_phone)
    .mutation(({ ctx, input }) => login_with_phone(
      input,
      get_request_device_context(ctx.event),
      get_identity_token(ctx),
    )),

  logout: protected_procedure.mutation(({ ctx }) => logout_user(ctx.auth_user)),

  sendOtp: public_procedure
    .input(api_schema.auth.send_otp)
    .mutation(({ ctx, input }) => send_otp_for_request(ctx.event, input, get_identity_token(ctx))),

  getOtpCooldown: public_procedure
    .input(api_schema.auth.otp_cooldown)
    .query(({ ctx, input }) => get_otp_cooldown({
      identity_token: get_identity_token(ctx),
      phone: input?.phone,
    })),
})
