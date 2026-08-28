import type { BilibiliVideoCard } from '@shared/types/bilibili'
import { get_bilibili_video_card } from '@server/lib/bilibili'
import { parse_bilibili_href } from '@shared/bilibili'

/** Resolve Bilibili link metadata for a batch of hrefs, keyed by the raw href. */
export async function get_bilibili_video_cards(hrefs: string[]) {
  const entries = await Promise.all([... new Set(hrefs)].map(async (href) => {
    const target = parse_bilibili_href(href)
    const card = target ? await get_bilibili_video_card(target) : null
    return [href, card] as const
  }))
  return Object.fromEntries(entries) as Record<string, BilibiliVideoCard | null>
}
