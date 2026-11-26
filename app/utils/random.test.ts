import { afterEach, describe, expect, it, vi } from 'vitest'
import { random_emoji } from './random'

describe('random_emoji', () => {
  afterEach(() => vi.restoreAllMocks())

  it('always returns a single character that renders as an emoji, drawn from a wide pool', () => {
    const picks = Array.from({ length: 500 }, () => random_emoji())
    for (const pick of picks) {
      expect([... pick]).toHaveLength(1)
      expect(pick).toMatch(/^\p{Emoji_Presentation}$/u)
    }
    // A hand-written short list would defeat the point of drawing from whole blocks.
    expect(new Set(picks).size).toBeGreaterThan(100)
  })

  it('returns the code point the roll lands on when it is an emoji', () => {
    // 2080 code points in total; offset 0x14 of the first block is U+2614 ☔.
    vi.spyOn(Math, 'random').mockReturnValue(20.5 / 2080)
    expect(random_emoji()).toBe('☔')
  })

  it('falls back to the pig when no roll lands on an emoji', () => {
    // Offset 0 is U+2600 ☀, which is text-presentation by default.
    const roll = vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(random_emoji()).toBe('🐷')
    expect(roll).toHaveBeenCalledTimes(32)
  })
})
