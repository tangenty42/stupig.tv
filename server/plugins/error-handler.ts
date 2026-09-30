import type { NitroApp } from 'nitropack'
import { ApiError } from '@server/errors/ApiError'
import { public_error_message } from '@server/errors/public-message'
import { error_fields, log_error } from '@server/lib/log'
import { ZodError } from 'zod'

export default defineNitroPlugin((nitroApp: NitroApp) => {
  nitroApp.hooks.hook('error', async (error, { event }) => {
    let statusCode = 500
    if (error instanceof ZodError) {
      statusCode = 400
    }
    else if (error instanceof ApiError) {
      statusCode = error.statusCode
    }

    log_error('unhandled error', {
      request_id: event?.context.request_id,
      path: event?.path,
      status_code: statusCode,
      ... error_fields(error),
    })

    return new Response(JSON.stringify({ message: public_error_message(error, import.meta.dev ?? false) }), {
      status: statusCode,
      headers: { 'Content-Type': 'application/json' },
    })
  })

  nitroApp.hooks.hook('request', async (event) => {
    event.node.res.on('close', () => {
      if (! event.node.res.writableEnded) {
        // no-op: placeholder for aborted-response handling
      }
    })
  })
})
