import { ApiError } from '@server/errors/ApiError'
import { INTERNAL_ERROR_MESSAGE } from '@server/errors/public-message'
import { createApp, createError, defineEventHandler, toWebHandler } from 'h3'
import { afterAll, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('nitropack/runtime', () => ({ defineNitroErrorHandler: (handler: unknown) => handler }))
vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin)
const { default: handle } = await import('./error-handler')
const { default: register } = await import('./plugins/error-handler')
const log = vi.spyOn(console, 'error').mockImplementation(() => {})
afterAll(() => {
  log.mockRestore()
  vi.unstubAllGlobals()
})

it.each([
  { path: '/api/sample', error: new ApiError(409, '冲突'), status: 409, message: '冲突', json: true },
  { path: '/sample', error: createError({ statusCode: 418, message: 'internal detail' }), status: 418, message: INTERNAL_ERROR_MESSAGE, json: false },
  { path: '/api/input', error: z.string().safeParse(4).error!, status: 400, message: '请求参数不合法！', json: true },
])('logs one error and finishes the $status response for $path', async ({ path, error, status, message, json }) => {
  const hook = vi.fn()
  await register({ hooks: { hook } } as unknown as Parameters<typeof register>[0])
  const capture = hook.mock.calls.find(([name]) => name === 'error')![1]
  log.mockClear()
  const app = createApp({ onError: async (error, event) => {
    await capture(error, { event })
    await handle(error, event, { defaultHandler: () => ({
      status: 500, statusText: 'Server Error', body: {}, headers: { 'x-content-type-options': 'nosniff' },
    }) })
    expect(event.handled).toBe(true)
  } })
  app.use(defineEventHandler((event) => {
    event.context.request_id = 'sample-request'
    throw error
  }))
  const response = await toWebHandler(app)(new Request(`https://example.test${path}`))
  expect(response.status).toBe(status)
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('content-type')?.split(';')[0]).toBe(json ? 'application/json' : 'text/plain')
  expect(await response.text()).toBe(json ? JSON.stringify({ message }) : message)
  expect(log).toHaveBeenCalledTimes(1)
  expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ path, request_id: 'sample-request', status_code: status })
})
