export function duration(time_ms: number) {
  const s = Math.floor((time_ms / 1000) % 60)
  const m = Math.floor((time_ms / (1000 * 60)) % 60)
  const h = Math.floor((time_ms / (1000 * 60 * 60)) % 24)
  const d = Math.floor(time_ms / (1000 * 60 * 60 * 24))
  if (d >= 365)
    return `${ Math.floor(d / 365) } 年`
  if (h)
    return `${ h } 小时`
  if (m)
    return `${ m } 分钟`
  if (s <= 30)
    return `刚刚`
  return `${ s } 秒`
}

export function duration_expand(time_ms: number) {
  const s = Math.floor((time_ms / 1000) % 60)
  const m = Math.floor((time_ms / (1000 * 60)) % 60)
  const h = Math.floor((time_ms / (1000 * 60 * 60)) % 24)
  const d = Math.floor(time_ms / (1000 * 60 * 60 * 24))
  if (d >= 365) {
    if (! d)
      return `${ Math.floor(d / 365) } 年`
    else
      return `${ Math.floor(d / 365) } 年零 ${ d % 365 } 天`
  }
  if (h) {
    if (! m)
      return `${ h } 小时`
    else
      return `${ h } 小时 ${ m } 分钟`
  }
  if (m) {
    if (! s)
      return `${ m } 分钟`
    else
      return `${ m } 分钟零 ${ s } 秒`
  }
  return `${ s } 秒`
}
