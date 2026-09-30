import crypto from 'node:crypto'

declare module 'h3' {
  interface H3EventContext {
    request_id?: string
  }
}

const MAX_INCOMING_LENGTH = 64

// Client-supplied IDs are honored so requests can be traced across services,
// but bounded so a client cannot stuff arbitrary payloads into every log line.
export function resolve_request_id(incoming: string | undefined): string {
  if (incoming && incoming.length <= MAX_INCOMING_LENGTH && ! incoming.includes('\n'))
    return incoming
  return crypto.randomUUID()
}

export default defineEventHandler((event) => {
  const request_id = resolve_request_id(getRequestHeader(event, 'x-request-id'))
  event.context.request_id = request_id
  setResponseHeader(event, 'x-request-id', request_id)
})
