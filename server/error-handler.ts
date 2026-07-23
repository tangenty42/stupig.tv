import { ApiError } from '@server/errors/ApiError'
import { fail } from '@server/types/response'
import { defineNitroErrorHandler } from 'nitropack/runtime'
import { ZodError } from 'zod'

export default defineNitroErrorHandler(async (error, event) => {
  let statusCode = error.statusCode || 500
  let message = '服务器放双休了~'

  if (error instanceof ZodError) {
    statusCode = 400
    const first = error.issues[0]
    message = first?.code === 'custom' && first.message
      ? first.message
      : '请求参数不合法！'
  }
  else if (error instanceof ApiError) {
    statusCode = error.statusCode
    message = error.message
  }
  else if (error instanceof Error) {
    message = error.message
  }

  console.error('[Error]', error?.stack ?? error?.message ?? error)

  // API routes: return our custom JSON envelope
  if (event.path?.startsWith('/api')) {
    send(
      event,
      JSON.stringify(fail(message)),
    )
    setResponseStatus(event, statusCode)
    setResponseHeaders(event, { 'content-type': 'application/json' })
    return
  }

  // Non-API routes: return a minimal plain text error page
  send(event, message)
  setResponseStatus(event, statusCode)
  setResponseHeaders(event, { 'content-type': 'text/plain' })
})
