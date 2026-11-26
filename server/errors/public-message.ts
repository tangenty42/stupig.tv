import { isError } from 'h3'
import { ZodError } from 'zod'
import { ApiError } from './ApiError'

export const INTERNAL_ERROR_MESSAGE = '服务器放双休了~'

/** H3 wraps an error thrown by a route before passing it to Nitro. */
export function http_error_details(error: unknown) {
  const wrapped = isError(error) ? error : undefined
  const cause = wrapped?.unhandled && (wrapped.cause instanceof ApiError || wrapped.cause instanceof ZodError)
    ? wrapped.cause
    : error
  if (cause instanceof ApiError)
    return { cause, status: cause.statusCode }
  if (cause instanceof ZodError)
    return { cause, status: 400 }
  return { cause, status: wrapped?.statusCode || 500 }
}

/** Only `.refine()`-style custom messages are user-facing; Zod's internal type messages are not. */
export function zod_validation_message(error: ZodError) {
  const first = error.issues[0]
  return first?.code === 'custom' && first.message
    ? first.message
    : '请求参数不合法！'
}

// Anything that is not an expected business/validation error must not leak
// internals (SQL fragments, OSS endpoints, SDK details) to the client in
// production; the full error is still logged server-side.
export function public_error_message(error: unknown, is_dev: boolean): string {
  if (error instanceof ZodError)
    return zod_validation_message(error)
  if (error instanceof ApiError)
    return error.message
  return is_dev && error instanceof Error ? error.message : INTERNAL_ERROR_MESSAGE
}
