import { createApp, defineEventHandler, getCookie, setCookie, toWebHandler } from 'h3'
import { afterAll, expect, it, vi } from 'vitest'

const identity = vi.hoisted(() => ({ cookieName: 'test_device_id', cookieMaxAgeDays: 5 }))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ app: { identity } }) }))
vi.stubGlobal('defineEventHandler', defineEventHandler)
vi.stubGlobal('getCookie', getCookie)
vi.stubGlobal('setCookie', setCookie)
const middleware = (await import('./identity')).default
afterAll(() => vi.unstubAllGlobals())

it('issues a device cookie on the first request and reuses it on the next request', async () => {
  const app = createApp()
  app.use(middleware)
  app.use(defineEventHandler(event => event.context.identity_token))
  const request = toWebHandler(app)
  const url = 'https://example.test/'

  const first = await request(new Request(url))
  const token = await first.text()
  expect(token).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
  const cookie = `${identity.cookieName}=${token}`
  expect(first.headers.get('set-cookie')?.split('; ')).toEqual(expect.arrayContaining([
    cookie, 'Secure', 'SameSite=Lax', `Max-Age=${identity.cookieMaxAgeDays * 86400}`,
  ]))

  const next = await request(new Request(url, { headers: { cookie } }))
  expect(await next.text()).toBe(token)
  expect(next.headers.has('set-cookie')).toBe(false)
})
