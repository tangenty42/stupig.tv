import { createServer } from 'node:http'
import { createApp, defineEventHandler, setResponseHeader, toNodeListener } from 'h3'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ allowed: false, context_error: false, secret: 'unfinished-private-body-must-not-reach-logs', log_error: vi.fn(), error_fields: vi.fn(() => ({ raw_error: 'unsafe-fields' })) }))
vi.mock('@server/lib/log', () => ({ log_error: state.log_error, error_fields: state.error_fields }))
vi.mock('@server/trpc/context', () => ({ create_trpc_context: () => {
  if (state.context_error)
    throw new Error(state.secret)
  return { allowed: state.allowed }
} }))
vi.mock('@server/trpc/router', async () => {
  const { initTRPC, TRPCError } = await import('@trpc/server')
  const t = initTRPC.context<{ allowed: boolean }>().create()
  const private_procedure = t.procedure.use(({ ctx, next }) => {
    if (! ctx.allowed)
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Denied', cause: new Error(state.secret) })
    return next()
  })
  return { app_router: t.router({
    system: t.router({ health: t.procedure.query(() => ({ online: true })) }),
    content: t.router({ listDrafts: private_procedure.query(() => ({ markdown: state.secret })), getDraft: private_procedure.mutation(() => ({ markdown: state.secret })) }),
  }) }
})

let server: ReturnType<typeof createServer>
let base = ''
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('setResponseHeader', setResponseHeader)
  const handler = (await import('./[trpc]')).default
  const app = createApp()
  app.use('/api/trpc', handler)
  server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (! address || typeof address === 'string')
    throw new Error('Missing HTTP fixture port')
  base = `http://127.0.0.1:${address.port}/api/trpc`
})
beforeEach(() => {
  state.allowed = false
  state.context_error = false
  state.log_error.mockClear()
  state.error_fields.mockClear()
})
afterAll(async () => {
  server?.closeAllConnections()
  if (server)
    await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllGlobals()
})

it('never caches an authenticated draft body or its authorization rejection', async () => {
  for (const allowed of [false, true]) {
    state.allowed = allowed
    const response = await fetch(`${base}/content.getDraft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(response.status).toBe(allowed ? 200 : 401)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect((await response.text()).includes(state.secret)).toBe(allowed)
  }
})

it('marks mixed public/private query batches no-store before authentication', async () => {
  const response = await fetch(`${base}/system.health,content.listDrafts?batch=1`)
  expect(response.headers.get('cache-control')).toContain('no-store')
  const result = await response.json()
  expect(result[0].result.data.online).toBe(true)
  expect(result[1].error.data.httpStatus).toBe(401)
  expect(JSON.stringify(result)).not.toContain(state.secret)
  expect(state.error_fields).not.toHaveBeenCalled()
})

it('protects encoded draft paths and errors before the adapter knows the procedure path', async () => {
  state.context_error = true
  const response = await fetch(`${base}/%63ontent.getDraft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  expect(response.status).toBe(500)
  expect(response.headers.get('cache-control')).toContain('no-store')
  expect(state.log_error).toHaveBeenCalled()
  expect(state.error_fields).not.toHaveBeenCalled()
  expect(JSON.stringify(state.log_error.mock.calls)).not.toContain(state.secret)
})
