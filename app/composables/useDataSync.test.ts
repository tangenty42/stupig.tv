import type { DataSyncEvent } from '@shared/types/sync'
import { EventEmitter } from 'node:events'
import { settings } from '@shared/settings'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readonly, ref, watch } from 'vue'

const mocks = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('mqtt', () => ({ default: { connect: mocks.connect } }))
const { create_data_sync_transport } = await import('./useDataSync')

class Channel extends EventTarget {
  static instances: Channel[] = []
  postMessage = vi.fn()
  close = vi.fn()

  constructor() {
    super()
    Channel.instances.push(this)
  }

  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

class Client extends EventEmitter {
  connected = false
  subscribe = vi.fn()
  unsubscribe = vi.fn()
  end = vi.fn()
}

describe('data sync transport', () => {
  let browser_document: EventTarget & { hidden: boolean, visibilityState: string }
  let clients: Client[]
  let transports: ReturnType<typeof create_data_sync_transport>[]

  beforeEach(() => {
    vi.useFakeTimers()
    clients = []
    transports = []
    Channel.instances = []
    browser_document = Object.assign(new EventTarget(), { hidden: false, visibilityState: 'visible' })
    vi.stubGlobal('document', browser_document)
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('BroadcastChannel', Channel)
    vi.stubGlobal('sessionStorage', { getItem: () => 'local-tab', setItem: vi.fn() })
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('readonly', readonly)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ username: 'draft-reader', password: 'test-only' }) })))
    mocks.connect.mockReset().mockImplementation(() => {
      const client = new Client()
      clients.push(client)
      return client
    })
  })

  afterEach(() => {
    for (const transport of transports) {
      transport.dispose()
    }
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function start(private_mode = false, resources: string[] = []) {
    const transport = create_data_sync_transport('ws://broker', private_mode)
    transports.push(transport)
    for (const resource of resources)
      transport.subscribe(resource, vi.fn())
    const user = ref<unknown>(null)
    const identity_changed = vi.fn()
    const handle_remote_logout = vi.fn()
    transport.start({ user, identity_changed, handle_remote_logout })
    await vi.advanceTimersByTimeAsync(settings.app.client.sync.resourceGatherDelayMs)
    const client = clients.at(- 1)!
    client.connected = true
    client.emit('connect', { sessionPresent: true })
    return { transport, user, identity_changed, handle_remote_logout, client, channel: Channel.instances.at(- 1)! }
  }

  function event(id: string): DataSyncEvent {
    return { id, type: 'refresh', resource: 'profile:1', timestamp: Date.now() }
  }

  it.each([false, true])('keeps the topic prefix across initial, dynamic and reconnect subscriptions, private=%s', async (private_mode) => {
    const prefix = private_mode ? settings.integrations.mqtt.privateTopicPrefix : settings.integrations.mqtt.topicPrefix
    const first = private_mode ? 'content_drafts:v1.first' : 'profile:1'
    const second = private_mode ? 'content_draft:v1.second' : 'profile:2'
    const { transport, client } = await start(private_mode, [first])
    expect(client.subscribe).toHaveBeenCalledWith([`${prefix}/${first}`], { qos: settings.integrations.mqtt.qos }, expect.any(Function))
    const drop = transport.subscribe(second, vi.fn())
    expect(client.subscribe).toHaveBeenLastCalledWith([`${prefix}/${second}`], { qos: settings.integrations.mqtt.qos }, expect.any(Function))
    drop()
    expect(client.unsubscribe).toHaveBeenCalledWith([`${prefix}/${second}`], expect.any(Function))
    client.connected = false
    client.emit('close')
    await vi.advanceTimersByTimeAsync(settings.app.client.sync.reconnectDelayMs)
    const reconnected = clients.at(- 1)!
    reconnected.connected = true
    reconnected.emit('connect', { sessionPresent: false })
    expect(reconnected.subscribe).toHaveBeenCalledWith([`${prefix}/${first}`], { qos: settings.integrations.mqtt.qos }, expect.any(Function))
  })

  it.each([false, true])('uses the same topic prefix for resources owned by another tab, private=%s', async (private_mode) => {
    const prefix = private_mode ? settings.integrations.mqtt.privateTopicPrefix : settings.integrations.mqtt.topicPrefix
    const first = private_mode ? 'content_drafts:v1.first' : 'profile:1'
    const remote = private_mode ? 'content_draft:v1.remote' : 'profile:2'
    const { client, channel } = await start(private_mode, [first])
    channel.receive({ type: 'report_resources', tab_id: 'remote-tab', resources: [remote] })
    expect(client.subscribe).toHaveBeenLastCalledWith([`${prefix}/${remote}`], { qos: settings.integrations.mqtt.qos }, expect.any(Function))
    channel.receive({ type: 'release_resources', tab_id: 'remote-tab' })
    expect(client.unsubscribe).toHaveBeenCalledWith([`${prefix}/${remote}`], expect.any(Function))
  })

  it('tracks remote owners so one tab cannot unsubscribe another tab resource', async () => {
    const { client, channel } = await start()
    channel.receive({ type: 'report_resources', tab_id: 'A', resources: ['profile:1'] })
    channel.receive({ type: 'report_resources', tab_id: 'B', resources: ['profile:1'] })
    expect(client.subscribe).toHaveBeenCalledOnce()
    channel.receive({ type: 'report_resources', tab_id: 'A', resources: [] })
    expect(client.unsubscribe).not.toHaveBeenCalled()
    channel.receive({ type: 'release_resources', tab_id: 'B' })
    expect(client.unsubscribe).toHaveBeenCalledOnce()
  })

  it('keeps remote-owned resources when the last local listener leaves', async () => {
    const { transport, client, channel } = await start()
    const drop = transport.subscribe('profile:1', vi.fn())
    channel.receive({ type: 'report_resources', tab_id: 'A', resources: ['profile:1'] })
    drop()
    expect(client.unsubscribe).not.toHaveBeenCalled()
    channel.receive({ type: 'release_resources', tab_id: 'A' })
    expect(client.unsubscribe).toHaveBeenCalledOnce()
  })

  it('subscribes server-issued channel strings verbatim and dispatches their events', async () => {
    const { transport, client } = await start()
    const listener = vi.fn()
    // Opaque server-issued channel for a personal identifier; the transport
    // must not derive or rewrite it in any way.
    const channel = 'otp_cooldown:v1.AAAAaaaaBBBBbbbbCCCCcc'

    transport.subscribe(channel, listener)

    const topics = client.subscribe.mock.calls.map(call => call[0]).flat().filter((value): value is string => typeof value === 'string')
    expect(topics).toContain(`${settings.integrations.mqtt.topicPrefix}/${channel}`)

    client.emit('message', 'topic', Buffer.from(JSON.stringify({ id: 'channel-1', type: 'refresh', resource: channel, timestamp: Date.now() })))
    expect(listener).toHaveBeenCalledOnce()
  })

  it('deduplicates nonconsecutive events across MQTT and the broadcast channel', async () => {
    const { transport, client, channel } = await start()
    const listener = vi.fn()
    transport.subscribe('profile:1', listener)
    client.emit('message', 'topic', Buffer.from(JSON.stringify(event('A'))))
    client.emit('message', 'topic', Buffer.from(JSON.stringify(event('B'))))
    client.emit('message', 'topic', Buffer.from(JSON.stringify(event('A'))))
    client.connected = false
    channel.receive({ type: 'sync_event', payload: event('B') })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])('recovers a failed offline broadcast read when online, hidden=%s', async (hidden) => {
    const { transport, client, channel } = await start()
    let online = false
    let snapshot = 'old'
    const listener = vi.fn(() => {
      // A failed resource fetch retains its previous data; receipt of the
      // notification alone does not mean the browser read the new snapshot.
      if (online) {
        snapshot = 'new'
      }
    })
    transport.subscribe('profile:1', listener)
    browser_document.hidden = hidden
    client.connected = false
    client.emit('close')
    channel.receive({ type: 'sync_event', payload: event('offline-change') })
    expect(snapshot).toBe('old')
    expect(listener).toHaveBeenCalledOnce()

    online = true
    if (! hidden) {
      await vi.advanceTimersByTimeAsync(settings.app.client.sync.reconnectDelayMs)
      const reconnected = clients.at(- 1)!
      reconnected.connected = true
      reconnected.emit('connect', { sessionPresent: true })
      reconnected.emit('message', 'topic', Buffer.from(JSON.stringify(event('offline-change'))))
      expect(listener).toHaveBeenCalledOnce()
    }
    window.dispatchEvent(new Event('online'))
    expect(snapshot).toBe('new')
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ sync_all: true }))

    transport.dispose()
    window.dispatchEvent(new Event('online'))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('bounds event deduplication and allows evicted IDs again', async () => {
    const { transport, client } = await start()
    const listener = vi.fn()
    transport.subscribe('profile:1', listener)
    for (let index = 0; index <= settings.app.client.sync.eventDeduplicationLimit; index ++) {
      client.emit('message', 'topic', Buffer.from(JSON.stringify(event(String(index)))))
    }
    client.emit('message', 'topic', Buffer.from(JSON.stringify(event('0'))))
    expect(listener).toHaveBeenCalledTimes(settings.app.client.sync.eventDeduplicationLimit + 2)
  })

  it('has one reconnect owner and cancels retry timers on dispose', async () => {
    const { transport, client } = await start()
    client.emit('error', new Error('network'))
    expect(client.end).toHaveBeenCalledOnce()
    expect(mocks.connect).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(settings.app.client.sync.reconnectDelayMs)
    expect(mocks.connect).toHaveBeenCalledTimes(2)
    const next = clients.at(- 1)!
    next.emit('error', new Error('network'))
    transport.dispose()
    await vi.advanceTimersByTimeAsync(settings.app.client.sync.reconnectDelayMs * 2)
    expect(mocks.connect).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not reconnect after pagehide while a resource gather is pending', async () => {
    const transport = create_data_sync_transport('ws://broker')
    transports.push(transport)
    transport.start({ user: ref(null), identity_changed: vi.fn(), handle_remote_logout: vi.fn() })
    window.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(settings.app.client.sync.resourceGatherDelayMs)
    expect(mocks.connect).not.toHaveBeenCalled()
    const pageshow = Object.assign(new Event('pageshow'), { persisted: true })
    window.dispatchEvent(pageshow)
    await vi.advanceTimersByTimeAsync(settings.app.client.sync.resourceGatherDelayMs)
    expect(mocks.connect).toHaveBeenCalledOnce()
  })

  it('owns auth watching until app disposal and notifies raw and unsignalled consumers', async () => {
    const { transport, user, identity_changed, handle_remote_logout, channel } = await start()
    const listener = vi.fn()
    transport.subscribe('profile:1', listener)
    user.value = { id: 1 }
    expect(identity_changed).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ sync_all: true }))
    channel.receive({ type: 'logout' })
    expect(handle_remote_logout).toHaveBeenCalledOnce()
    transport.dispose()
    user.value = null
    expect(identity_changed).toHaveBeenCalledTimes(2)
    channel.receive({ type: 'logout' })
    expect(handle_remote_logout).toHaveBeenCalledOnce()
  })

  it('isolates rejected listener callbacks and keeps app instances independent', async () => {
    const first = await start()
    const second = await start()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const listener = vi.fn()
      first.transport.subscribe('profile:1', async () => {
        throw new Error('callback')
      })
      first.transport.subscribe('profile:1', listener)
      const other_listener = vi.fn()
      second.transport.subscribe('profile:1', other_listener)
      first.client.emit('message', 'topic', Buffer.from(JSON.stringify(event('A'))))
      await Promise.resolve()
      expect(listener).toHaveBeenCalledOnce()
      expect(other_listener).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledOnce()
    }
    finally {
      log.mockRestore()
    }
  })
})
