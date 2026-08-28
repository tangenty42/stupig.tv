import type { BilibiliLinkTarget } from '@shared/bilibili'
import type { BilibiliVideoCard } from '@shared/types/bilibili'
import { redis } from '@server/lib/redis'
import { bilibili_target_key, parse_bilibili_href } from '@shared/bilibili'
import { env } from '@shared/env'

interface ViewApiResponse {
  code: number
  data?: {
    bvid: string
    title: string
    pic: string
    duration: number
    owner?: { name?: string }
    stat?: { view?: number, like?: number }
  }
}

// Redis cache-aside: the data is re-fetchable, so a Redis outage only means
// extra upstream fetches. Negative results (video gone/private) get a short
// TTL so a video made public right after posting still resolves soon;
// network errors aren't cached at all.
const in_flight = new Map<string, Promise<BilibiliVideoCard | null>>()

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
    return raw === null ? undefined : JSON.parse(raw) as BilibiliVideoCard | null
  }
  catch {
    return undefined
  }
}

async function remember(key: string, value: BilibiliVideoCard | null) {
  const ttl = value ? env.BILIBILI_CACHE_TTL_MS : env.BILIBILI_NEGATIVE_CACHE_TTL_MS
  if (ttl <= 0) {
    return
  }
  try {
    await redis.set(cache_key(key), JSON.stringify(value), 'PX', ttl)
  }
  catch (error) {
    console.warn(`[bilibili] cache write failed for ${key}:`, error)
  }
}

async function fetch_view_api(target: { kind: 'bvid', id: string } | { kind: 'aid', id: number }) {
  const query = target.kind === 'bvid' ? `bvid=${target.id}` : `aid=${target.id}`
  const response = await fetch(`https://api.bilibili.com/x/web-interface/view?${query}`, {
    headers: request_headers,
    signal: AbortSignal.timeout(env.BILIBILI_FETCH_TIMEOUT_MS),
  })
  if (! response.ok) {
    throw new Error(`Bilibili view API HTTP ${response.status}`)
  }
  const result = await response.json() as ViewApiResponse
  if (result.code !== 0 || ! result.data) {
    // -404 and friends: the video is gone, private, or the id is bad.
    return null
  }
  const { bvid, title, pic, duration, owner, stat } = result.data
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
  return fetch_view_api(resolved)
}

export async function get_bilibili_video_card(target: BilibiliLinkTarget) {
  const key = bilibili_target_key(target)
  const hit = await cached(key)
  if (hit !== undefined) {
    return hit
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
      return null
    })
    .finally(() => in_flight.delete(key))
  in_flight.set(key, request)
  return request
}
