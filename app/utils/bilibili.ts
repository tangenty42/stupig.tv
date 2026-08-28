/** Clock-style badge (`m:ss` / `h:mm:ss`), unlike duration_format's prose. */
export function format_bilibili_duration(seconds: number) {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = String(total % 60).padStart(2, '0')
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${minutes}:${rest}`
}

/** 万-style compact counts, matching Bilibili's own display (26.6万). */
export function format_bilibili_count(count: number) {
  return count >= 10_000
    ? `${(count / 10_000).toFixed(1).replace(/\.0$/, '')}万`
    : String(count)
}
