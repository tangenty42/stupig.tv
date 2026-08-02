import { create_trpc_context } from '@server/trpc/context'
import { app_router } from '@server/trpc/router'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { toWebRequest } from 'h3'

export default defineEventHandler(event => fetchRequestHandler({
  endpoint: '/api/trpc',
  req: toWebRequest(event),
  router: app_router,
  createContext: () => create_trpc_context(event),
  onError: ({ error, path }) => {
    console.error(`[tRPC] ${path ?? '<unknown>'}`, error)
  },
}))
