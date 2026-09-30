// Structured JSON-lines logging: one line per event, so `docker logs` output can
// be piped through `jq`. Fields are flat and stable; errors go through
// error_fields() so class/message/stack are always present.

export type LogFields = Record<string, unknown>

function write(level: 'info' | 'warn' | 'error', msg: string, fields?: LogFields) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ... fields })
  if (level === 'error')
    console.error(line)
  else if (level === 'warn')
    console.warn(line)
  else
    console.log(line)
}

export function error_fields(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      error_class: error.constructor.name,
      error_message: error.message,
      stack: error.stack,
    }
  }
  return { error_class: typeof error, error_message: String(error) }
}

export function log_info(msg: string, fields?: LogFields) {
  write('info', msg, fields)
}

export function log_warn(msg: string, fields?: LogFields) {
  write('warn', msg, fields)
}

export function log_error(msg: string, fields?: LogFields) {
  write('error', msg, fields)
}
