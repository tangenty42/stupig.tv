import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { carousel_motion } from './carousel-motion'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 10))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('interpolates both edges with CSS ease and settles exactly without restarting on scroll events', () => {
  const apply = vi.fn()
  const motion = carousel_motion([0, 48], apply)
  motion.set([48, 0])
  vi.advanceTimersByTime(150)
  const [left, right] = apply.mock.lastCall![0]
  expect(left / 48).toBeCloseTo(0.8024, 3)
  expect(right).toBeCloseTo(48 - left, 5)
  motion.set([48, 0])
  vi.advanceTimersByTime(150)
  expect(apply.mock.lastCall![0]).toEqual([48, 0])
  expect(vi.getTimerCount()).toBe(0)
})

it('reverses from the current sample, supports immediate restoration and cancels retired DOM writes', () => {
  const apply = vi.fn()
  const motion = carousel_motion([0], apply)
  motion.set([48])
  vi.advanceTimersByTime(100)
  const before = apply.mock.lastCall![0][0]
  motion.set([0])
  expect(apply.mock.lastCall![0][0]).toBeCloseTo(before, 5)
  vi.advanceTimersByTime(30)
  expect(apply.mock.lastCall![0][0]).toBeLessThan(before)
  motion.set([48], true)
  expect(apply.mock.lastCall![0]).toEqual([48])
  expect(vi.getTimerCount()).toBe(0)
  motion.set([0])
  motion.stop()
  apply.mockClear()
  vi.advanceTimersByTime(400)
  expect(apply).not.toHaveBeenCalled()
})
