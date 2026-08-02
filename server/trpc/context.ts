import type { H3Event } from 'h3'

export interface TrpcContext {
  event: H3Event
}

export function create_trpc_context(event: H3Event) {
  return { event }
}
