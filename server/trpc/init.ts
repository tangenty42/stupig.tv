import type { TrpcContext } from '@server/trpc/context'
import type { PermissionField, PermissionLevel } from '@shared/permissions'
import { ApiError } from '@server/errors/ApiError'
import { INTERNAL_ERROR_MESSAGE } from '@server/errors/public-message'
import { require_auth_user } from '@server/services/auth-guards.service'
import { has_permission } from '@shared/permissions'
import { initTRPC, TRPCError } from '@trpc/server'
import { ZodError } from 'zod'

function get_validation_message(error: ZodError) {
  const first = error.issues[0]
  return first?.code === 'custom' && first.message
    ? first.message
    : '请求参数不合法！'
}

function throw_trpc_error(error: unknown): never {
  if (error instanceof ZodError) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: get_validation_message(error),
      cause: error,
    })
  }

  if (! (error instanceof ApiError)) {
    throw error
  }

  const options = { message: error.message, cause: error }

  switch (error.statusCode) {
    case 400:
      throw new TRPCError({ code: 'BAD_REQUEST', ... options })
    case 401:
      throw new TRPCError({ code: 'UNAUTHORIZED', ... options })
    case 403:
      throw new TRPCError({ code: 'FORBIDDEN', ... options })
    case 404:
      throw new TRPCError({ code: 'NOT_FOUND', ... options })
    case 409:
      throw new TRPCError({ code: 'CONFLICT', ... options })
    case 413:
      throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', ... options })
    case 415:
      throw new TRPCError({ code: 'UNSUPPORTED_MEDIA_TYPE', ... options })
    case 429:
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', ... options })
    case 502:
      throw new TRPCError({ code: 'BAD_GATEWAY', ... options })
    default:
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', ... options })
  }
}

const t = initTRPC.context<TrpcContext>().create({
  errorFormatter({ error, shape }) {
    const cause = error.cause
    return {
      ... shape,
      message: cause instanceof ZodError
        ? get_validation_message(cause)
        // Internal errors keep their message in dev; production must not leak
        // SQL fragments or SDK internals through the tRPC error envelope.
        : ! (cause instanceof ApiError) && ! import.meta.dev
            ? INTERNAL_ERROR_MESSAGE
            : shape.message,
    }
  },
})

const normalize_errors = t.middleware(async ({ next }) => {
  try {
    const result = await next()
    if (! result.ok) {
      throw_trpc_error(result.error.cause ?? result.error)
    }
    return result
  }
  catch (error) {
    throw_trpc_error(error)
  }
})

export const router = t.router
export const public_procedure = t.procedure.use(normalize_errors)

export const protected_procedure = public_procedure.use(async ({ ctx, next }) => {
  const auth_user = await require_auth_user(ctx.event)
  return next({ ctx: { auth_user } })
})

export function permission_procedure(field: PermissionField, level: PermissionLevel) {
  return public_procedure.use(async ({ ctx, next }) => {
    const auth_user = await require_auth_user(ctx.event)
    if (! has_permission(auth_user, field, level)) {
      throw new ApiError(403, '权限不足')
    }
    return next({ ctx: { auth_user } })
  })
}
