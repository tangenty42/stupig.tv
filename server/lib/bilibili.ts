import type { BilibiliLinkTarget } from '@shared/bilibili'
import type { BilibiliVideoCard } from '@shared/types/bilibili'
import { redis } from '@server/lib/redis'
import { bilibili_target_key, parse_bilibili_href } from '@shared/bilibili'
import { env } from '@shared/env'

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
// posting still resolves soon; network errors aren't cached at all. A Redis
// outage only means extra upstream fetches.
const in_flight = new Map<string, Promise<BilibiliVideoCard | null>>()

interface CacheEntry {
  card: BilibiliVideoCard | null
  stored_at: number
  failed_at?: number
}

const request_headers = {
  // A browser UA keeps Bilibili's risk control (-412) off anonymous fetches.
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
  if (! card && env.BILIBILI_NEGATIVE_CACHE_TTL_MS <= 0) {
    return
  }
  try {
    const entry: CacheEntry = { card, stored_at: Date.now() }
    if (card) {
      await redis.set(cache_key(key), JSON.stringify(entry))
    }
    else {
      await redis.set(cache_key(key), JSON.stringify(entry), 'PX', env.BILIBILI_NEGATIVE_CACHE_TTL_MS)
    }
  }
  catch (error) {
    console.warn(`[bilibili] cache write failed for ${key}:`, error)
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
    console.warn(`[bilibili] cache write failed for ${key}:`, error)
  }
}

function to_card(metadata: VideoMetadata) {
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
    signal: AbortSignal.timeout(env.BILIBILI_FETCH_TIMEOUT_MS),
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
  if (result.code === - 412) {
    throw new RiskControlError('Bilibili view API banned this IP (-412)')
  }
  if (result.code !== 0 || ! result.data) {
    // -404 and friends: the video is gone, private, or the id is bad.
    return null
  }
  return to_card(result.data)
}

const initial_state_pattern = /__INITIAL_STATE__=(\{[\s\S]+?\});\(function/

async function fetch_watch_page_card(target: { kind: 'bvid', id: string } | { kind: 'aid', id: number }) {
  const path = target.kind === 'bvid' ? target.id : `av${target.id}`
  const response = await fetch(`https://www.bilibili.com/video/${path}/`, {
    headers: { ... request_headers, Accept: 'text/html' },
    signal: AbortSignal.timeout(env.BILIBILI_FETCH_TIMEOUT_MS),
  })
  if (! response.ok) {
    throw new Error(`Bilibili watch page HTTP ${response.status}`)
  }
  const match = initial_state_pattern.exec(await response.text())
  const metadata = match
    ? (JSON.parse(match[1]!) as { videoData?: VideoMetadata }).videoData
    : undefined
  // No videoData means the watch page rendered its gone/private error view.
  return metadata ? to_card(metadata) : null
}

// b23.tv short links only reveal the target through their 302 redirect.
async function resolve_short_link(code: string): Promise<BilibiliLinkTarget | null> {
  const response = await fetch(`https://b23.tv/${code}`, {
    headers: request_headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(env.BILIBILI_FETCH_TIMEOUT_MS),
  })
  const location = response.headers.get('location')
  return location ? parse_bilibili_href(location) : null
}

async function fetch_video_card(target: BilibiliLinkTarget): Promise<BilibiliVideoCard | null> {
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
    return fetch_watch_page_card(resolved)
  }
}

export async function get_bilibili_video_card(target: BilibiliLinkTarget) {
  const key = bilibili_target_key(target)
  const entry = await cached(key)
  if (entry) {
    const fresh_for = entry.card ? env.BILIBILI_CACHE_TTL_MS : env.BILIBILI_NEGATIVE_CACHE_TTL_MS
    if (Date.now() - entry.stored_at < fresh_for) {
      return entry.card
    }
    // A recently failed refresh means upstream is likely banning us; serve
    // the stale card through the cooldown instead of retrying per request.
    if (entry.failed_at && Date.now() - entry.failed_at < env.BILIBILI_FETCH_FAILURE_COOLDOWN_MS) {
      return entry.card
    }
  }
  const pending = in_flight.get(key)
  if (pending) {
    return pending
  }
  const request = fetch_video_card(target)
    .then((card) => {
      void remember(key, card)
      return card
    })
    .catch((error) => {
      console.warn(`[bilibili] metadata fetch failed for ${key}:`, error)
      void remember_failure(key, entry)
      // The stale entry stays servable until the first refresh succeeds.
      return entry?.card ?? null
    })
    .finally(() => in_flight.delete(key))
  in_flight.set(key, request)
  return request
}
