/** Messages matching this pattern are Zod/technical debug output — never show them. */
const debug_message_re = /^(?:Invalid input|Expected|Received)\b/i

export function error_message(error: unknown): string {
  if (typeof error === 'string') {
    return debug_message_re.test(error) ? '输入格式不正确' : error
  }

  if (error && typeof error === 'object') {
    const maybe_error = error as {
      data?: { message?: string, success?: boolean }
      message?: string
      statusCode?: number
    }

    // New H3/Nuxt error envelope with `error: true`
    if ('error' in maybe_error && maybe_error.error === true) {
      return maybe_error.message || '不知何错误。。。'
    }

    const msg = maybe_error.data?.message || maybe_error.message
    if (msg === '用户打断了施法')
      return ''
    if (maybe_error.data?.message) {
      return debug_message_re.test(maybe_error.data.message)
        ? '输入格式不正确'
        : maybe_error.data.message
    }
    if (maybe_error.message) {
      return debug_message_re.test(maybe_error.message)
        ? '输入格式不正确'
        : maybe_error.message
    }
  }

  return '不知何错误。。。'
}
