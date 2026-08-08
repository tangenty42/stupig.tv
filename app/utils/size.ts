export function format_bytes(bytes: number, options: { decimals?: number, separator?: string } = {}) {
  const { decimals = 0, separator = ' ' } = options

  if (! Number.isFinite(bytes) || bytes === 0) {
    return `0${separator}B`
  }

  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
  const i = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(k)), sizes.length - 1)
  const value = bytes / k ** i

  return `${value.toFixed(decimals)}${separator}${sizes[i]}`
}

export function format_speed(bytes_per_second: number) {
  if (! Number.isFinite(bytes_per_second) || bytes_per_second < 0) {
    return ''
  }
  return `${format_bytes(bytes_per_second)}/s`
}
