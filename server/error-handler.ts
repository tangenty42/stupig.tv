import { STATUS_CODES } from 'node:http'
import { http_error_details, public_error_message } from '@server/errors/public-message'
import { send, setResponseHeaders, setResponseStatus } from 'h3'
import { defineNitroErrorHandler } from 'nitropack/runtime'

export default defineNitroErrorHandler(async (error, event, { defaultHandler }) => {
  const { cause, status } = http_error_details(error)
  const message = public_error_message(cause, import.meta.dev ?? false)
  const api = /^\/api(?:\/|\?|$)/.test(event.path)
  // Keep Nitro's cache and security headers. Its error hook already logged this request.
  const { headers } = await defaultHandler(error, event, { silent: true, json: true })
  setResponseStatus(event, status, error.statusMessage || STATUS_CODES[status])
  setResponseHeaders(event, { ... headers, 'content-type': api ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' })
  return send(event, api ? JSON.stringify({ message }) : message)
})
