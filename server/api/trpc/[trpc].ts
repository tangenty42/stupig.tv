import { error_fields, log_error } from '@server/lib/log'
import { create_trpc_context } from '@server/trpc/context'
import { app_router } from '@server/trpc/router'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { toWebRequest } from 'h3'

function draft_path(path: string) {
  try {
    path = decodeURIComponent(path)
  }
  catch {}
  return /content\.(?:createDraft|listDrafts|getDraft|acquireDraft|commandDraft)/.test(path)
}

export default defineEventHandler((event) => {
  const draft_request = draft_path(event.path)
  // Covers authentication failures and mixed batches before any middleware runs.
  if (draft_request)
    setResponseHeader(event, 'Cache-Control', 'no-store')
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req: toWebRequest(event),
    router: app_router,
    createContext: () => create_trpc_context(event),
    onError: ({ error, path }) => {
      log_error('trpc error', {
        request_id: event.context.request_id,
        path,
        ... (draft_request || draft_path(path ?? '') ? { error_code: error.code } : error_fields(error.cause ?? error)),
      })
    },
  })
})
