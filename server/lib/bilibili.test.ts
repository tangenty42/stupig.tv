import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), eval: vi.fn(), warn: vi.fn() }))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ integrations: { bilibili: {
  fetchTimeoutMs: 5000, cacheTtlMs: 86400000, negativeCacheTtlMs: 1800000, fetchFailureCooldownMs: 1800000, fetchFailureMaxCooldownMs: 21600000, retryJitterRatio: 0.2,
} } }) }))
vi.mock('@server/lib/redis', () => ({ redis: { get: mocks.get, set: mocks.set, eval: mocks.eval } }))
vi.mock('@server/lib/log', () => ({ log_warn: mocks.warn, error_fields: (error: Error) => ({ error_message: error.message }) }))
let get_bilibili_video_card: typeof import('./bilibili')['get_bilibili_video_card']
let cached_value: string | null
let memory: Map<string, string>
const cache_write = () => mocks.set.mock.calls.find(([key]) => key.startsWith('bilibili:video:'))!
const target = { kind: 'bvid' as const, id: 'BV1xx411c7mD' }
const card = { bvid: target.id, title: 'Cached title', cover: 'https://i.example/cover.jpg', url: `https://www.bilibili.com/video/${target.id}`, duration: 60, uploader: '', views: 0, likes: 0 }
const metadata = { bvid: target.id, title: 'Fresh title', pic: card.cover, duration: 60 }
let fetcher: ReturnType<typeof vi.fn>
const page = (state: unknown) => new Response(`<script>window.__INITIAL_STATE__=${JSON.stringify(state)};(function(){})();</script>`)

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-25T00:00:00Z'))
  cached_value = JSON.stringify({ card, stored_at: Date.now() - 86400001 })
  memory = new Map()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  mocks.get.mockImplementation(async (key: string) => memory.get(key) ?? (key.startsWith('bilibili:video:') ? cached_value : null))
  mocks.set.mockImplementation(async (key: string, value: string, ... args: unknown[]) => {
    if (args.includes('NX') && memory.has(key))
      return null
    memory.set(key, value)
    return 'OK'
  })
  mocks.eval.mockImplementation(async (_script: string, _keys: number, probe: string, state: string, token: string, value: string) => {
    if (memory.get(probe) !== token)
      return 0
    if (value)
      memory.set(state, value)
    else
      memory.delete(state)
    memory.delete(probe)
    return 1
  })
  ;({ get_bilibili_video_card } = await import('./bilibili'))
  fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each([
  '<html><script src="risk-geetest.js"></script></html>',
  '<html>changed layout</html>',
  '<script>__INITIAL_STATE__={bad json};(function(){})();</script>',
])('preserves the stale card when a HTTP 200 fallback is not usable video data: %s', async (body) => {
  fetcher.mockResolvedValueOnce(new Response('', { status: 412 })).mockResolvedValueOnce(new Response(body))
  expect(await get_bilibili_video_card(target)).toEqual(card)
  expect(mocks.warn).toHaveBeenCalledWith('bilibili metadata fetch failed', expect.objectContaining({ key: `bv:${target.id}` }))
  const [key, raw, ... ttl] = cache_write()
  expect(key).toBe(`bilibili:video:bv:${target.id}`)
  expect(JSON.parse(raw)).toMatchObject({ card, failed_at: Date.now() })
  expect(ttl).toEqual([])
  cached_value = raw
  expect(await get_bilibili_video_card(target)).toEqual(card)
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it.each([- 352, - 500, 0])('does not treat unexpected API result %s as a missing video', async (code) => {
  fetcher.mockResolvedValue(new Response(JSON.stringify({ code })))
  expect(await get_bilibili_video_card(target)).toEqual(card)
  expect(JSON.parse(cache_write()[1]).card).toEqual(card)
  expect(mocks.warn).toHaveBeenCalledWith('bilibili metadata fetch failed', expect.any(Object))
})

it.each([{}, { videoData: {} }, { videoData: { ... metadata, pic: '' } }])('keeps stale metadata for incomplete watch-page state: %j', async (state) => {
  fetcher.mockResolvedValueOnce(new Response('', { status: 412 })).mockResolvedValueOnce(page(state))
  expect(await get_bilibili_video_card(target)).toEqual(card)
  expect(mocks.warn).toHaveBeenCalledWith('bilibili metadata fetch failed', expect.any(Object))
})

it.each(['api', 'watch'])('replaces stale data only for an explicit unavailable response from %s', async (source) => {
  if (source === 'api')
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ code: - 404 })))
  else
    fetcher.mockResolvedValueOnce(new Response('', { status: 412 })).mockResolvedValueOnce(page({ error: { code: 404, trueCode: - 404 }, videoData: {} }))
  expect(await get_bilibili_video_card(target)).toBeNull()
  expect(mocks.set).toHaveBeenCalledWith(`bilibili:video:bv:${target.id}`, expect.any(String), 'PX', 1800000)
  expect(JSON.parse(cache_write()[1]).card).toBeNull()
  if (source === 'api')
    expect(mocks.warn).not.toHaveBeenCalled()
  else
    expect(mocks.warn).toHaveBeenCalledWith('bilibili upstream cooldown', expect.any(Object))
})

it('refreshes successfully from a valid watch page after risk control on the API', async () => {
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ code: - 412 }))).mockResolvedValueOnce(page({ videoData: metadata }))
  expect(await get_bilibili_video_card(target)).toMatchObject({ title: 'Fresh title', bvid: target.id })
  expect(cache_write()).toHaveLength(2)
  expect(mocks.warn).toHaveBeenCalledWith('bilibili upstream cooldown', expect.any(Object))
})

it('throttles failures without a historical card and retries after its cooldown expires', async () => {
  cached_value = null
  fetcher.mockRejectedValue(new Error('timeout'))
  expect(await get_bilibili_video_card(target)).toBeNull()
  cached_value = cache_write()[1]
  expect(await get_bilibili_video_card(target)).toBeNull()
  expect(fetcher).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(1800001)
  fetcher.mockResolvedValue(new Response(JSON.stringify({ code: 0, data: metadata })))
  expect(await get_bilibili_video_card(target)).toMatchObject({ title: 'Fresh title' })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('does not overwrite a stale short-link card when the redirect endpoint serves a challenge', async () => {
  fetcher.mockResolvedValue(new Response('<html>challenge</html>'))
  expect(await get_bilibili_video_card({ kind: 'short', code: 'example' })).toEqual(card)
  expect(mocks.warn).toHaveBeenCalledWith('bilibili metadata fetch failed', expect.any(Object))
  expect(JSON.parse(cache_write()[1]).card).toEqual(card)
})

it('still resolves valid short-link redirects and caches a complete card', async () => {
  fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: card.url } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: metadata })))
  expect(await get_bilibili_video_card({ kind: 'short', code: 'example' })).toMatchObject({ title: 'Fresh title' })
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(mocks.warn).not.toHaveBeenCalled()
})

it('serves a fresh successful cache without upstream requests or expiry changes', async () => {
  cached_value = JSON.stringify({ card, stored_at: Date.now() })
  expect(await get_bilibili_video_card(target)).toEqual(card)
  expect(fetcher).not.toHaveBeenCalled()
  expect(mocks.set).not.toHaveBeenCalled()
})

it('stops a parallel batch after its first failed video and does not freshen blocked stale entries', async () => {
  const targets = ['BV1xx411c7mD', 'BV1xx411c7mE', 'BV1xx411c7mF'].map(id => ({ kind: 'bvid' as const, id }))
  for (const item of targets)
    memory.set(`bilibili:video:bv:${item.id}`, JSON.stringify({ card: { ... card, bvid: item.id }, stored_at: Date.now() - 86400001 }))
  fetcher.mockResolvedValueOnce(new Response('', { status: 412 })).mockResolvedValueOnce(new Response('<html>challenge</html>'))
  const results = await Promise.all(targets.map(item => get_bilibili_video_card(item)))
  expect(results.map(result => result?.bvid)).toEqual(targets.map(item => item.id))
  expect(fetcher).toHaveBeenCalledTimes(2)
  for (const item of targets.slice(1)) {
    expect(mocks.set.mock.calls.some(([key]) => key === `bilibili:video:bv:${item.id}`)).toBe(false)
    expect(JSON.parse(memory.get(`bilibili:video:bv:${item.id}`)!).stored_at).toBe(Date.now() - 86400001)
  }
})

it('keeps the global cooldown after a usable watch fallback while still serving that fresh card', async () => {
  fetcher.mockResolvedValueOnce(new Response('', { status: 412 })).mockResolvedValueOnce(page({ videoData: metadata }))
  expect(await get_bilibili_video_card(target)).toMatchObject({ title: 'Fresh title' })
  expect(JSON.parse(memory.get('bilibili:upstream:backoff')!).failures).toBe(1)
  cached_value = null
  expect(await get_bilibili_video_card({ kind: 'bvid', id: 'BV1xx411c7mE' })).toBeNull()
  expect(await get_bilibili_video_card(target)).toMatchObject({ title: 'Fresh title' })
  expect(fetcher).toHaveBeenCalledTimes(2)
})
