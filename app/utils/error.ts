/** Messages matching this pattern are Zod/technical debug output — never show them. */
const debug_message_re = /^(?:Invalid input|Expected|Received)\b/i

function display_message(message: string) {
  if (message === '用户打断了施法')
    return ''
  return debug_message_re.test(message) ? '输入格式不正确' : message
}

export function error_message(error: unknown) {
  if (typeof error === 'string') {
    return display_message(error)
  }

  if (error && typeof error === 'object') {
    const maybe_error = error as {
      data?: { message?: string }
      error?: boolean
      message?: string
    }

    // New H3/Nuxt error envelope with `error: true`
    const message = maybe_error.error === true ? maybe_error.message : maybe_error.data?.message || maybe_error.message
    if (message)
      return display_message(message)
  }

  return '不知何错误……'
}
