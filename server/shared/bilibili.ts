// Bilibili video link parsing, shared by the server (metadata fetch) and the
// markdown preview (card detection). BV ids are case-sensitive; their
// alphabet excludes 0/O/I/l but a superset charset is fine for matching.

export type BilibiliLinkTarget
  = | { kind: 'bvid', id: string }
    | { kind: 'aid', id: number }
    | { kind: 'short', code: string }

const video_hosts = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'])
const short_hosts = new Set(['b23.tv'])

const video_path_pattern = /^\/video\/(BV[0-9A-Z]{10}|av(\d+))(?=[/?]|$)/i
const short_path_pattern = /^\/([0-9A-Z]+)(?=[/?]|$)/i

export function parse_bilibili_href(href: string): BilibiliLinkTarget | null {
  let url: URL
  try {
    url = new URL(href)
  }
  catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (video_hosts.has(host)) {
    const match = video_path_pattern.exec(url.pathname)
    if (! match) {
      return null
    }
    return match[2]
      ? { kind: 'aid', id: Number(match[2]) }
      : { kind: 'bvid', id: match[1]! }
  }
  if (short_hosts.has(host)) {
    const match = short_path_pattern.exec(url.pathname)
    return match ? { kind: 'short', code: match[1]! } : null
  }
  return null
}

export function bilibili_target_key(target: BilibiliLinkTarget) {
  return target.kind === 'short' ? `short:${target.code}` : target.kind === 'bvid' ? `bv:${target.id}` : `av:${target.id}`
}
