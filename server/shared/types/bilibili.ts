export interface BilibiliVideoCard {
  bvid: string
  /** Canonical watch URL built from the bvid. */
  url: string
  title: string
  /** Cover image on *.hdslb.com; hotlink-blocked unless Referer is omitted. */
  cover: string
  uploader: string
  /** Video length in seconds. */
  duration: number
  /** Play count from stat.view. */
  views: number
  /** Like count from stat.like. */
  likes: number
}
