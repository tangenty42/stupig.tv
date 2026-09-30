import { ZodError } from 'zod'
import { ApiError } from './ApiError'

export const INTERNAL_ERROR_MESSAGE = '服务器放双休了~'

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
