import type { QuerySubscriber } from './query'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from './query'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolve_value, reject_value) => {
    resolve = resolve_value
    reject = reject_value
  })
  return { promise, resolve, reject }
}

function setup(random = 0.5) {
  let now = 10000
  let visible = true
  const ticks = new Set<() => void>()
  const listeners = new Map<string, () => Promise<void>>()
  const unsubscribe = vi.fn()
  const subscribe = vi.fn((resource: string, listener: () => Promise<void>) => {
    listeners.set(resource, listener)
    return () => {
      listeners.delete(resource)
      unsubscribe(resource)
    }
  })
  const client = new QueryClient({
    subscribe,
    now: () => now,
    visible: () => visible,
    retryable_error: error => error instanceof Error && error.message === 'network',
    random: () => random,
    start_polling: (tick) => {
      ticks.add(tick)
      return () => ticks.delete(tick)
    },
  })
  function subscriber(fetcher = vi.fn(async () => 'data'), polling_interval?: number): QuerySubscriber<string> {
    return {
      fetcher,
      data: vi.fn(),
      loading: vi.fn(),
      error: vi.fn(),
      resources: ['profile:1'],
      polling_interval,
    }
  }
  return {
    client,
    subscriber,
    subscribe,
    unsubscribe,
    listeners,
    ticks,
    tick: (time: number, is_visible = true) => {
      now = time
      visible = is_visible
      for (const tick of ticks) {
        tick()
      }
    },
  }
}

describe('queryClient', () => {
  it('joins shared refreshes and distributes a failure to every active subscriber', async () => {
    const { client, subscriber, subscribe } = setup()
    const request = deferred<string>()
    const first = subscriber(vi.fn(() => request.promise))
    const second = subscriber()
    const query = client.acquire<string>('query:1')
    query.add(first)
    query.add(second)
    const task = query.refresh()
    expect(query.refresh()).toBe(task)
    request.reject(new Error('network'))
    await task
    expect(subscribe).toHaveBeenCalledOnce()
    expect(first.fetcher).toHaveBeenCalledOnce()
    expect(first.error).toHaveBeenCalledOnce()
    expect(second.error).toHaveBeenCalledOnce()
    expect(vi.mocked(first.error).mock.calls[0]![0]).toBe(vi.mocked(second.error).mock.calls[0]![0])
  })

  it('joins refreshes for an independent query with the default policy', async () => {
    const { client, subscriber } = setup()
    const request = deferred<string>()
    const consumer = subscriber(vi.fn(() => request.promise))
    const query = client.acquire<string>(null)
    query.add(consumer)
    const first = query.refresh()
    expect(query.refresh()).toBe(first)
    request.resolve('result')
    await first
    expect(consumer.fetcher).toHaveBeenCalledOnce()
    expect(consumer.data).toHaveBeenCalledExactlyOnceWith('result')
  })

  it('requires subscribers to the same key to agree on the refresh policy', () => {
    const { client } = setup()
    const query = client.acquire('query:1', 'latest')
    expect(client.acquire('query:1', 'latest')).toBe(query)
    expect(() => client.acquire('query:1', 'join')).toThrow('same refresh_policy')
  })

  it('refetches once for invalidations during a request and does not publish obsolete data', async () => {
    const { client, subscriber, listeners } = setup()
    const request = deferred<string>()
    const fetcher = vi.fn().mockReturnValueOnce(request.promise).mockResolvedValue('fresh')
    const consumer = subscriber(fetcher)
    const query = client.acquire<string>('query:1')
    query.add(consumer)
    const task = query.refresh()
    void listeners.get('profile:1')!()
    void listeners.get('profile:1')!()
    request.resolve('obsolete')
    await task
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(consumer.data).toHaveBeenCalledExactlyOnceWith('fresh')
  })

  it('discards a departing provider response and retries with the remaining provider', async () => {
    const { client, subscriber } = setup()
    const request = deferred<string>()
    const first = subscriber(vi.fn(() => request.promise))
    const second = subscriber(vi.fn(async () => 'remaining'))
    const query = client.acquire<string>('query:1')
    const drop = query.add(first)
    query.add(second)
    const task = query.refresh()
    drop()
    request.resolve('departed')
    await task
    expect(first.data).not.toHaveBeenCalled()
    expect(second.data).toHaveBeenCalledExactlyOnceWith('remaining')
  })

  it('isolates throwing data callbacks from fetch errors and other consumers', async () => {
    const { client, subscriber } = setup()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const first = subscriber()
      first.data = () => {
        throw new Error('callback')
      }
      const second = subscriber()
      const query = client.acquire<string>('query:1')
      query.add(first)
      query.add(second)
      await query.refresh()
      expect(second.data).toHaveBeenCalledWith('data')
      expect(first.error).not.toHaveBeenCalled()
      expect(second.error).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledOnce()
    }
    finally {
      log.mockRestore()
    }
  })

  it('uses the minimum active polling interval and keeps polling after the creator leaves', async () => {
    const { client, subscriber, ticks, tick } = setup()
    const fetcher = vi.fn(async () => 'data')
    const query = client.acquire<string>('query:1')
    const drop_first = query.add(subscriber(fetcher, 1000))
    query.add(subscriber(fetcher, 4000))
    await query.refresh()
    expect(ticks.size).toBe(1)
    tick(11000)
    await query.refresh()
    expect(fetcher).toHaveBeenCalledTimes(2)
    drop_first()
    tick(12000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    tick(15000)
    await query.refresh()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('does not poll hidden tabs, running requests, or failures before the quiet interval', async () => {
    const { client, subscriber, tick } = setup()
    const request = deferred<string>()
    const fetcher = vi.fn(() => request.promise)
    const query = client.acquire<string>('query:1')
    query.add(subscriber(fetcher, 1000))
    tick(10000, false)
    expect(fetcher).not.toHaveBeenCalled()
    const task = query.refresh()
    tick(20000)
    expect(fetcher).toHaveBeenCalledOnce()
    request.reject(new Error('network'))
    await task
    tick(20500)
    expect(fetcher).toHaveBeenCalledOnce()
    tick(21000)
    await query.refresh()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('shares three quiet backoff attempts and stops after they fail', async () => {
    const { client, subscriber, tick, ticks } = setup()
    const fetcher = vi.fn().mockRejectedValue(new Error('network'))
    const first = subscriber(fetcher)
    const second = subscriber()
    const query = client.acquire<string>('query:1')
    query.add(first)
    query.add(second)
    await query.refresh()
    expect(ticks.size).toBe(1)

    for (const [index, time] of [15000, 25000, 45000].entries()) {
      tick(time - 1)
      tick(time, false)
      expect(fetcher).toHaveBeenCalledTimes(index + 1)
      tick(time)
      await Promise.resolve()
      await Promise.resolve()
      expect(fetcher).toHaveBeenCalledTimes(index + 2)
    }

    expect(ticks.size).toBe(0)
    tick(100000)
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(second.fetcher).not.toHaveBeenCalled()
    for (const consumer of [first, second]) {
      expect(consumer.error).toHaveBeenCalledOnce()
      expect(vi.mocked(consumer.loading).mock.calls.filter(([loading]) => loading)).toEqual([[true]])
    }
  })

  it('applies jitter, joins a manual retry and resets the backoff after success', async () => {
    const { client, subscriber, tick, ticks } = setup(0)
    const request = deferred<string>()
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('network')).mockReturnValueOnce(request.promise)
    const consumer = subscriber(fetcher)
    const query = client.acquire<string>('query:1')
    query.add(consumer)
    await query.refresh()

    tick(13999)
    expect(fetcher).toHaveBeenCalledOnce()
    tick(14000)
    tick(24000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const manual = query.refresh()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(consumer.loading).toHaveBeenLastCalledWith(true)
    request.resolve('recovered')
    await manual
    expect(consumer.data).toHaveBeenCalledExactlyOnceWith('recovered')
    expect(ticks.size).toBe(0)

    fetcher.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce('new recovery')
    await query.refresh()
    tick(27999)
    expect(fetcher).toHaveBeenCalledTimes(3)
    tick(28000)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it.each([{ polling_interval: 0 }, { retry_on_error: false }])('honors a shared subscriber disabling backoff with %o', async (options) => {
    const { client, subscriber, tick, ticks } = setup()
    const fetcher = vi.fn().mockRejectedValue(new Error('network'))
    const query = client.acquire<string>('query:1')
    query.add(subscriber(fetcher))
    query.add({ ... subscriber(), ... options })
    await query.refresh()
    tick(45000)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(ticks.size).toBe(0)
  })

  it('lets ordinary polling take over a scheduled retry and disposes its clock with the query', async () => {
    const { client, subscriber, tick, ticks } = setup()
    const fetcher = vi.fn().mockRejectedValue(new Error('network'))
    const query = client.acquire<string>('query:1')
    const drop = query.add(subscriber(fetcher))
    await query.refresh()
    const remove_polling = query.add(subscriber(fetcher, 30000))
    tick(15000)
    expect(fetcher).toHaveBeenCalledOnce()
    tick(40000)
    await query.refresh()
    expect(fetcher).toHaveBeenCalledTimes(2)

    remove_polling()
    await query.refresh()
    expect(ticks.size).toBe(1)
    drop()
    expect(ticks.size).toBe(0)
    tick(90000)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('delivers a terminal error reached during a quiet retry', async () => {
    const { client, subscriber, tick, ticks } = setup()
    const forbidden = new Error('forbidden')
    const consumer = subscriber(vi.fn().mockRejectedValueOnce(new Error('network')).mockRejectedValueOnce(forbidden))
    const query = client.acquire<string>('query:1')
    query.add(consumer)
    await query.refresh()
    tick(15000)
    await Promise.resolve()
    await Promise.resolve()
    expect(consumer.error).toHaveBeenCalledTimes(2)
    expect(consumer.error).toHaveBeenLastCalledWith({ error: forbidden, notified: false })
    expect(ticks.size).toBe(0)
  })

  it('does not schedule a retry from a failure superseded by a successful refresh', async () => {
    const { client, subscriber, tick, ticks } = setup()
    const stale = deferred<string>()
    const fetcher = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValueOnce('current')
    const consumer = subscriber(fetcher)
    const query = client.acquire<string>('query:1', 'latest')
    query.add(consumer)
    const old_request = query.refresh()
    await query.refresh()
    stale.reject(new Error('network'))
    await old_request
    tick(90000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(consumer.data).toHaveBeenCalledExactlyOnceWith('current')
    expect(consumer.error).not.toHaveBeenCalled()
    expect(ticks.size).toBe(0)
  })

  it('cleans subscriptions and polling and suppresses late results after the last subscriber leaves', async () => {
    const { client, subscriber, unsubscribe, ticks } = setup()
    const request = deferred<string>()
    const consumer = subscriber(vi.fn(() => request.promise), 1000)
    const query = client.acquire<string>('query:1')
    const drop = query.add(consumer)
    const task = query.refresh()
    drop()
    drop()
    request.resolve('late')
    await task
    expect(consumer.data).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('profile:1')
    expect(ticks.size).toBe(0)
    expect(client.acquire('query:1')).not.toBe(query)
  })

  it('invalidates unkeyed identity-dependent queries as well as shared queries', async () => {
    const { client, subscriber } = setup()
    const request = deferred<string>()
    const fetcher = vi.fn().mockReturnValueOnce(request.promise).mockResolvedValue('new identity')
    const consumer = subscriber(fetcher)
    consumer.resources = []
    const query = client.acquire<string>(null)
    query.add(consumer)
    const task = query.refresh()
    client.invalidate_all()
    request.resolve('old identity')
    await task
    expect(consumer.data).toHaveBeenCalledExactlyOnceWith('new identity')
  })

  it('does not share queries between application clients', async () => {
    const first = setup()
    const second = setup()
    const consumer = first.subscriber()
    const query = first.client.acquire<string>('query:1')
    query.add(consumer)
    await query.refresh()
    expect(second.client.acquire('query:1').has_data()).toBe(false)
    first.client.dispose()
    expect(first.unsubscribe).toHaveBeenCalledOnce()
  })
})
