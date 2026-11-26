import { http_error_details } from '@server/errors/public-message'
import { error_fields, log_error } from '@server/lib/log'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('error', (error, { event }) => {
    const { cause, status } = http_error_details(error)
    log_error('unhandled error', {
      request_id: event?.context.request_id,
      path: event?.path,
      status_code: status,
      ... error_fields(cause),
    })
  })
})
