import { ApiError } from '@server/errors/ApiError'
import { public_error_message } from '@server/errors/public-message'
import { error_fields, log_error } from '@server/lib/log'
import { defineNitroErrorHandler } from 'nitropack/runtime'
import { ZodError } from 'zod'

export default defineNitroErrorHandler(async (error, event) => {
  let statusCode = error.statusCode || 500
  const message = public_error_message(error, import.meta.dev ?? false)

  if (error instanceof ZodError) {
    statusCode = 400
  }
  else if (error instanceof ApiError) {
    statusCode = error.statusCode
  }

  log_error('unhandled error', {
    request_id: event.context.request_id,
    path: event.path,
    status_code: statusCode,
    ... error_fields(error),
  })

  // API routes: return our custom JSON envelope
  if (event.path?.startsWith('/api')) {
    send(
      event,
      JSON.stringify({ message }),
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
