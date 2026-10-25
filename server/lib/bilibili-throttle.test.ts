import type { Mocked } from 'vitest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { create_bilibili_throttle } from './bilibili-throttle'

vi.mock('./log', () => ({ log_warn: vi.fn(), error_fields: () => ({}) }))
const options = { fetchTimeoutMs: 5000, fetchFailureCooldownMs: 1800000, fetchFailureMaxCooldownMs: 21600000, retryJitterRatio: 0.2 }
let memory: Map<string, string>
type Client = Parameters<typeof create_bilibili_throttle>[0]
let client: Mocked<Client>
const state_key = 'bilibili:upstream:backoff'
const probe_key = 'bilibili:upstream:probe'
const state = () => JSON.parse(memory.get(state_key)!) as { failures: number, retry_at: number }
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-25T00:00:00Z'))
  vi.spyOn(Math, 'random').mockReturnValue(0)
  memory = new Map()
  client = {
    get: vi.fn<Client['get']>(async key => memory.get(key) ?? null),
    set: vi.fn<Client['set']>(async (key, value) => {
      if (memory.has(key))
        return null
      memory.set(key, value)
      return 'OK'
    }),
    eval: vi.fn<Client['eval']>(async (_script, _count, ... args) => {
      const probe = String(args[0])
      const backoff = String(args[1])
      const token = String(args[2])
      const value = String(args[3])
      if (memory.get(probe) !== token)
        return 0
      if (value)
        memory.set(backoff, value)
      else
        memory.delete(backoff)
      memory.delete(probe)
      return 1
    }),
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('persists exponential backoff across restarts, suppresses retries, and caps at six hours', async () => {
  const failure = vi.fn(async () => {
    throw new Error('upstream banned')
  })
  for (const [index, delay] of [1800000, 3600000, 7200000, 14400000, 21600000, 21600000].entries()) {
    const gate = create_bilibili_throttle(client, options)
    await expect(gate.run(failure, () => 'stale')).rejects.toThrow('banned')
    expect(state()).toEqual({ failures: index + 1, retry_at: Date.now() + delay })
    expect(await gate.run(failure, () => 'stale')).toBe('stale')
    expect(failure).toHaveBeenCalledTimes(index + 1)
    expect(await create_bilibili_throttle(client, options).run(failure, () => 'stale')).toBe('stale')
    vi.advanceTimersByTime(delay)
  }
})

it('adds only positive jitter, never exceeding the configured cap', async () => {
  vi.mocked(Math.random).mockReturnValue(1)
  const failure = async () => {
    throw new Error('banned')
  }
  await expect(create_bilibili_throttle(client, options).run(failure, () => null)).rejects.toThrow()
  expect(state().retry_at - Date.now()).toBe(2160000)
  memory.set(state_key, JSON.stringify({ failures: 4, retry_at: Date.now() - 1 }))
  await expect(create_bilibili_throttle(client, options).run(failure, () => null)).rejects.toThrow()
  expect(state().retry_at - Date.now()).toBe(options.fetchFailureMaxCooldownMs)
})

it('starts a global cooldown even when a marked-risk request returns a usable fallback card', async () => {
  const gate = create_bilibili_throttle(client, options)
  expect(await gate.run(async (risk) => {
    risk()
    return 'watch page card'
  }, () => 'stale')).toBe('watch page card')
  const other_video = vi.fn(async () => 'other video')
  expect(await create_bilibili_throttle(client, options).run(other_video, () => 'other stale card')).toBe('other stale card')
  expect(other_video).not.toHaveBeenCalled()
  expect(state().failures).toBe(1)
})

it('serializes local work so a concurrent batch stops after its first failed probe', async () => {
  let reject!: (error: Error) => void
  const work = vi.fn(() => new Promise<string>((_yes, no) => {
    reject = no
  }))
  const gate = create_bilibili_throttle(client, options)
  const first = gate.run(work, () => 'stale').catch(() => 'failed')
  const second = gate.run(work, () => 'stale')
  for (let step = 0; step < 12; step ++)
    await Promise.resolve()
  expect(work).toHaveBeenCalledOnce()
  reject(new Error('banned'))
  expect(await Promise.all([first, second])).toEqual(['failed', 'stale'])
  expect(work).toHaveBeenCalledOnce()
})

it('allows only one probe across processes and does not release the other owner\'s lease', async () => {
  let release!: (value: string) => void
  const first = create_bilibili_throttle(client, options).run(() => new Promise<string>((resolve) => {
    release = resolve
  }), () => 'stale')
  for (let step = 0; step < 12; step ++)
    await Promise.resolve()
  const owner = memory.get(probe_key)
  expect(owner).toBeTruthy()
  const work = vi.fn(async () => 'second probe')
  expect(await create_bilibili_throttle(client, options).run(work, () => 'stale')).toBe('stale')
  expect(work).not.toHaveBeenCalled()
  expect(memory.get(probe_key)).toBe(owner)
  expect(client.set).toHaveBeenCalledWith(probe_key, expect.any(String), 'PX', 20000, 'NX')
  release('healthy')
  expect(await first).toBe('healthy')
  expect(memory.has(probe_key)).toBe(false)
})

it('resets shared failure history after an unblocked success', async () => {
  const gate = create_bilibili_throttle(client, options)
  await expect(gate.run(async () => {
    throw new Error('banned')
  }, () => null)).rejects.toThrow()
  vi.advanceTimersByTime(options.fetchFailureCooldownMs)
  expect(await create_bilibili_throttle(client, options).run(async () => 'healthy', () => 'stale')).toBe('healthy')
  expect(memory.has(state_key)).toBe(false)
  await expect(gate.run(async () => {
    throw new Error('banned again')
  }, () => null)).rejects.toThrow()
  expect(state().failures).toBe(1)
})

it('fails closed on Redis failure and keeps a local cooldown instead of hammering the upstream', async () => {
  client.get.mockRejectedValue(new Error('redis unavailable'))
  const gate = create_bilibili_throttle(client, options)
  const work = vi.fn(async () => 'upstream')
  expect(await gate.run(work, () => 'stale')).toBe('stale')
  expect(await gate.run(work, () => 'stale')).toBe('stale')
  expect(work).not.toHaveBeenCalled()
  expect(client.get).toHaveBeenCalledOnce()
})
