/** UUIDv4 for browser requests, including engines that only expose getRandomValues. */
export function random_uuid() {
  if (typeof crypto.randomUUID === 'function')
    return crypto.randomUUID()

  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0F) | 0x40
  bytes[8] = (bytes[8]! & 0x3F) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Unicode blocks that carry emoji. A pick is drawn from the whole range rather
 * than a hand-written list, so new emoji in these blocks are covered without
 * the pool going stale.
 */
const emoji_ranges: readonly (readonly [number, number])[] = [
  [0x2600, 0x26FF], // Miscellaneous Symbols
  [0x2700, 0x27BF], // Dingbats
  [0x2B00, 0x2BFF], // Miscellaneous Symbols and Arrows
  [0x1F300, 0x1F5FF], // Miscellaneous Symbols and Pictographs
  [0x1F600, 0x1F64F], // Emoticons
  [0x1F680, 0x1F6FF], // Transport and Map Symbols
  [0x1F900, 0x1F9FF], // Supplemental Symbols and Pictographs
  [0x1FA70, 0x1FAFF], // Symbols and Pictographs Extended-A
]

/**
 * Only `Emoji_Presentation` code points render with emoji styling on their own.
 * Most of each block is unassigned or text-presentation, so a bare random code
 * point would often come back as a blank box or a monochrome glyph.
 */
const emoji_presentation = /\p{Emoji_Presentation}/u

const emoji_code_point_total = emoji_ranges
  .reduce((total, [start, end]) => total + (end - start + 1), 0)

/** A random emoji, drawn across every code point in the emoji blocks. */
export function random_emoji() {
  // The valid share of each block is large enough that a few rolls suffice;
  // the bound only stops a pathological loop if the ranges ever go stale.
  for (let attempt = 0; attempt < 32; attempt ++) {
    let offset = Math.floor(Math.random() * emoji_code_point_total)
    for (const [start, end] of emoji_ranges) {
      const size = end - start + 1
      if (offset < size) {
        const candidate = String.fromCodePoint(start + offset)
        if (emoji_presentation.test(candidate)) {
          return candidate
        }
        break
      }
      offset -= size
    }
  }
  return '🐷'
}
