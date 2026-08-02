import type { NitroApp } from 'nitropack'
import { ApiError } from '@server/errors/ApiError'
import { ZodError } from 'zod'

export default defineNitroPlugin((nitroApp: NitroApp) => {
  nitroApp.hooks.hook('error', async (error) => {
    console.error('[Error]', error.stack ?? error.message)

    let statusCode = 500
    let message = '服务器放双休了~'

    if (error instanceof ZodError) {
      statusCode = 400
      const first = error.issues[0]
      // Only trust custom messages from `.refine()` — ignore Zod's internal type/format messages
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

    return new Response(JSON.stringify({ message }), {
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
