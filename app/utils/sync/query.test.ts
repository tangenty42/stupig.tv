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

function setup() {
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
      ignore_stale_responses: true,
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
