import type { BilibiliLinkTarget } from '@shared/bilibili'
import type { BilibiliVideoCard } from '@shared/types/bilibili'
import { runtime_config } from '@config/loader'
import { error_fields, log_warn } from '@server/lib/log'
import { redis } from '@server/lib/redis'
import { bilibili_target_key, parse_bilibili_href } from '@shared/bilibili'
import { create_bilibili_throttle } from './bilibili-throttle'

const config = runtime_config()
const throttle = create_bilibili_throttle(redis, config.integrations.bilibili)

interface ViewApiResponse {
  code: number
  data?: VideoMetadata
}

// The watch page's __INITIAL_STATE__.videoData mirrors the view API payload.
interface VideoMetadata {
  bvid: string
  title: string
  pic: string
  duration: number
  owner?: { name?: string }
  stat?: { view?: number, like?: number }
}

// Datacenter IPs get -412 (or an HTML challenge page) on the JSON view API
// while www.bilibili.com keeps serving the watch page; fetch_video_card falls
// back to scraping it on this error.
class RiskControlError extends Error {}

// Redis stale-if-error: entries carry their own stored_at and positive
// entries never expire — past the freshness TTL the next request revalidates,
// and a failed revalidation keeps serving the stale card until a refresh
// succeeds. Failures also arm a cooldown (failed_at) so an upstream outage or
// risk-control ban isn't hammered by a retry per request. Negative results
// (video gone/private) keep a short TTL so a video made public right after
// posting still resolves soon. Failures without a prior card get a short
// placeholder cooldown too. The shared upstream gate also pauses new fetches
// when Redis cannot coordinate probes, rather than amplifying an outage.
const in_flight = new Map<string, Promise<BilibiliVideoCard | null>>()

interface CacheEntry {
  card: BilibiliVideoCard | null
  stored_at: number
  failed_at?: number
}

const request_headers = {
  // Browser headers reduce risk-control responses but cannot prevent bans.
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json',
}

function cache_key(key: string) {
  return `bilibili:video:${key}`
}

async function cached(key: string) {
  try {
    const raw = await redis.get(cache_key(key))
    if (raw === null) {
      return undefined
    }
    const parsed = JSON.parse(raw) as CacheEntry | BilibiliVideoCard | null
    if (! parsed || typeof parsed !== 'object') {
      return undefined
    }
    // Entries predating stale-if-error were the bare card JSON: serve stale.
    return 'stored_at' in parsed ? parsed : { card: parsed, stored_at: 0 }
  }
  catch {
    return undefined
  }
}

// Positive entries persist (no PX) until a refresh overwrites them; only
// negative results expire on their own.
async function remember(key: string, card: BilibiliVideoCard | null) {
  if (! card && config.integrations.bilibili.negativeCacheTtlMs <= 0) {
    return
  }
  try {
    const entry: CacheEntry = { card, stored_at: Date.now() }
    if (card) {
      await redis.set(cache_key(key), JSON.stringify(entry))
    }
    else {
      await redis.set(cache_key(key), JSON.stringify(entry), 'PX', config.integrations.bilibili.negativeCacheTtlMs)
    }
  }
  catch (error) {
    log_warn('bilibili cache write failed', { key, ... error_fields(error) })
  }
}

// Arm the failure cooldown: a stale entry keeps serving with failed_at
// throttling retries; with no entry, a null placeholder throttles via the
// negative freshness window instead.
async function remember_failure(key: string, entry: CacheEntry | undefined) {
  if (! entry?.card) {
    await remember(key, null)
    return
  }
  try {
    await redis.set(cache_key(key), JSON.stringify({ ... entry, failed_at: Date.now() }))
  }
  catch (error) {
    log_warn('bilibili cache write failed', { key, ... error_fields(error) })
  }
}

function to_card(metadata: VideoMetadata) {
  if (! metadata || typeof metadata.bvid !== 'string' || ! /^BV[0-9A-Z]{10}$/i.test(metadata.bvid)
    || typeof metadata.title !== 'string' || ! metadata.title.trim() || typeof metadata.pic !== 'string' || ! /^https?:\/\//i.test(metadata.pic)
    || ! Number.isFinite(metadata.duration) || metadata.duration < 0) {
    throw new Error('Bilibili metadata missing required video fields')
  }
  const { bvid, title, pic, duration, owner, stat } = metadata
  return {
    bvid,
    url: `https://www.bilibili.com/video/${bvid}`,
    title,
    cover: pic.replace(/^http:\/\//, 'https://'),
    uploader: owner?.name ?? '',
    duration,
    views: stat?.view ?? 0,
    likes: stat?.like ?? 0,
  } satisfies BilibiliVideoCard
}

async function fetch_view_api(target: { kind: 'bvid', id: string } | { kind: 'aid', id: number }) {
  const query = target.kind === 'bvid' ? `bvid=${target.id}` : `aid=${target.id}`
  const response = await fetch(`https://api.bilibili.com/x/web-interface/view?${query}`, {
    headers: request_headers,
    signal: AbortSignal.timeout(config.integrations.bilibili.fetchTimeoutMs),
  })
  if (response.status === 412) {
    throw new RiskControlError('Bilibili view API banned this IP (HTTP 412)')
  }
  if (! response.ok) {
    throw new Error(`Bilibili view API HTTP ${response.status}`)
  }
  const body = await response.text()
  let result: ViewApiResponse
  try {
    result = JSON.parse(body) as ViewApiResponse
  }
  catch {
    // An HTML body here is the risk-control challenge page.
    throw new RiskControlError('Bilibili view API returned HTML')
  }
  if (typeof result?.code !== 'number' || ! Number.isInteger(result.code))
    throw new Error('Bilibili view API returned an invalid result envelope')
  if (result?.code === - 412) {
    throw new RiskControlError('Bilibili view API banned this IP (-412)')
  }
  if (result?.code === - 404) {
    // Only an explicit unavailable response may replace a successful cache.
    return null
  }
  if (result?.code !== 0 || ! result.data)
    throw new Error(`Bilibili view API unexpected result (${result?.code ?? 'missing code'})`)
  return to_card(result.data)
}

const initial_state_pattern = /__INITIAL_STATE__=(\{[\s\S]+?\});\(function/

async function fetch_watch_page_card(target: { kind: 'bvid', id: string } | { kind: 'aid', id: number }) {
  const path = target.kind === 'bvid' ? target.id : `av${target.id}`
  const response = await fetch(`https://www.bilibili.com/video/${path}/`, {
    headers: { ... request_headers, Accept: 'text/html' },
    signal: AbortSignal.timeout(config.integrations.bilibili.fetchTimeoutMs),
  })
  if (! response.ok) {
    throw new Error(`Bilibili watch page HTTP ${response.status}`)
  }
  const match = initial_state_pattern.exec(await response.text())
  // HTTP 200 may be a risk-control challenge. Missing/changed markup is not
  // evidence that a video is gone: preserve stale metadata and log the failure.
  if (! match)
    throw new Error('Bilibili watch page missing video state (challenge or changed markup)')
  let state: { videoData?: VideoMetadata, error?: { code?: number, trueCode?: number } } | null
  try {
    state = JSON.parse(match[1]!)
  }
  catch {
    throw new Error('Bilibili watch page returned invalid video state')
  }
  if (state?.error?.trueCode === - 404 || (state?.error?.trueCode === undefined && state?.error?.code === 404))
    return null
  if (! state?.videoData)
    throw new Error('Bilibili watch page missing video metadata')
  return to_card(state.videoData)
}

// b23.tv short links only reveal the target through their 302 redirect.
async function resolve_short_link(code: string): Promise<BilibiliLinkTarget | null> {
  const response = await fetch(`https://b23.tv/${code}`, {
    headers: request_headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(config.integrations.bilibili.fetchTimeoutMs),
  })
  const location = response.headers.get('location')
  if (response.status === 404)
    return null
  const target = location ? parse_bilibili_href(location) : null
  if (response.status < 300 || response.status >= 400 || ! target || target.kind === 'short')
    throw new Error(`Bilibili short link did not resolve to a video (HTTP ${response.status})`)
  return target
}

async function fetch_video_card(target: BilibiliLinkTarget, mark_risk: () => void): Promise<BilibiliVideoCard | null> {
  const resolved = target.kind === 'short' ? await resolve_short_link(target.code) : target
  if (! resolved || resolved.kind === 'short') {
    return null
  }
  try {
    return await fetch_view_api(resolved)
  }
  catch (error) {
    if (! (error instanceof RiskControlError)) {
      throw error
    }
    mark_risk()
    return fetch_watch_page_card(resolved)
  }
}

export async function get_bilibili_video_card(target: BilibiliLinkTarget) {
  const key = bilibili_target_key(target)
  const entry = await cached(key)
  if (entry) {
    const fresh_for = entry.card ? config.integrations.bilibili.cacheTtlMs : config.integrations.bilibili.negativeCacheTtlMs
    if (Date.now() - entry.stored_at < fresh_for) {
      return entry.card
    }
    // A recently failed refresh means upstream is likely banning us; serve
    // the stale card through the cooldown instead of retrying per request.
    if (entry.failed_at && Date.now() - entry.failed_at < config.integrations.bilibili.fetchFailureCooldownMs) {
      return entry.card
    }
  }
  const pending = in_flight.get(key)
  if (pending) {
    return pending
  }
  const request = throttle.run(async (mark_risk) => {
    try {
      const card = await fetch_video_card(target, mark_risk)
      await remember(key, card)
      return card
    }
    catch (error) {
      log_warn('bilibili metadata fetch failed', { key, ... error_fields(error) })
      await remember_failure(key, entry)
      throw error
    }
  }, () => entry?.card ?? null)
    .catch(() => entry?.card ?? null)
    .finally(() => in_flight.delete(key))
  in_flight.set(key, request)
  return request
}
