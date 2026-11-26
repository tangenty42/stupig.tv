import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearNuxtState } from '#imports'
import HomePage from './index.vue'

const emoji = vi.hoisted(() => ({ rolls: 0, swapped_at: [] as number[] }))
mockNuxtImport('random_emoji', () => () => {
  emoji.swapped_at.push(performance.now())
  return `<${emoji.rolls ++}>`
})

const wrappers: { unmount: () => void }[] = []
beforeEach(() => {
  clearNuxtState('home_archive_emoji')
  emoji.swapped_at.length = 0
})
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.useRealTimers()
})

async function mount_home() {
  const wrapper = await mountSuspended(HomePage)
  wrappers.push(wrapper)
  return wrapper
}

it('introduces the group and offers the way to the archive and the contact page', async () => {
  const wrapper = await mount_home()
  const text = wrapper.text().replace(/\s/g, '')
  for (const part of ['蠢猪小组', '广州市西关外国语学校', '2026届', '高三1班'])
    expect(text).toContain(part)
  expect(wrapper.get('img[alt="Stupig Chant"]').attributes('src')).toMatch(/\/imgs\/whats_up\.svg$/)

  expect(wrapper.get('a[href="/content"]').text()).toMatch(/<\d+>/)
  expect(wrapper.get('a[href="/contact"]').text()).toBeTruthy()
  expect(text).toContain('蠢人，你在期待什么？')
})

function intermediate_gaps(from: number) {
  const times = emoji.swapped_at.slice(from)
  return times.slice(1).map((time, index) => time - times[index]!)
    .filter(gap => gap > 105 && gap < 495)
}

it('gradually changes the archive emoji speed before settling at the hover and normal rates', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const wrapper = await mount_home()
  const link = wrapper.get('a[href="/content"]')
  const first = emoji.rolls
  await vi.advanceTimersByTimeAsync(500)
  expect(emoji.rolls - first).toBe(5)

  const hover_start = emoji.swapped_at.length - 1
  await link.trigger('pointerenter', { pointerType: 'mouse' })
  await vi.advanceTimersByTimeAsync(2300)
  const slowing = intermediate_gaps(hover_start)
  expect(slowing.length).toBeGreaterThan(1)
  expect(slowing.at(- 1)!).toBeGreaterThan(slowing[0]!)
  const hovered = emoji.rolls
  await vi.advanceTimersByTimeAsync(1000)
  expect(emoji.rolls - hovered).toBe(2)

  const leave_start = emoji.swapped_at.length - 1
  await link.trigger('pointerleave', { pointerType: 'mouse' })
  await vi.advanceTimersByTimeAsync(1600)
  const speeding = intermediate_gaps(leave_start)
  expect(speeding.length).toBeGreaterThan(1)
  expect(speeding.at(- 1)!).toBeLessThan(speeding[0]!)
  const left = emoji.rolls
  await vi.advanceTimersByTimeAsync(500)
  expect(emoji.rolls - left).toBe(5)
})

it('retains the current emoji cycle when reversing, ignores touch and stops on unmount', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const wrapper = await mount_home()
  const link = wrapper.get('a[href="/content"]')
  await vi.advanceTimersByTimeAsync(145)
  const before_hover = emoji.rolls
  await link.trigger('pointerenter', { pointerType: 'mouse' })
  await vi.advanceTimersByTimeAsync(25)
  await link.trigger('pointerleave', { pointerType: 'mouse' })
  // Each pointer event happens partway through the same cycle.
  await vi.advanceTimersByTimeAsync(75)
  expect(emoji.rolls - before_hover).toBe(1)

  await vi.advanceTimersByTimeAsync(1300)
  await link.trigger('pointerenter', { pointerType: 'touch' })
  const touched = emoji.rolls
  await vi.advanceTimersByTimeAsync(500)
  expect(emoji.rolls - touched).toBe(5)

  await link.trigger('pointerenter', { pointerType: 'mouse' })
  await vi.advanceTimersByTimeAsync(25)
  wrapper.unmount()
  wrappers.pop()
  const rolls = emoji.rolls
  await vi.advanceTimersByTimeAsync(1000)
  expect(emoji.rolls).toBe(rolls)
})
