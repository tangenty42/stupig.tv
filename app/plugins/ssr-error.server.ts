import { error_fields, log_error } from '@server/lib/log'

export default defineNuxtPlugin({
  name: 'ssr-error-logger',
  enforce: 'pre',
  hooks: {
    'app:error': (error) => {
      const event = useRequestEvent()
      log_error('SSR app error', {
        request_id: event?.context.request_id,
        path: event?.path,
        ... error_fields(error),
      })
    },
  },
})