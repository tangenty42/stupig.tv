import node_url from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const config = {
    mqtt: {
      host: 'mqtt-host',
      port: 1883,
      username: '',
      password: '',
    },
    integrations: {
      mqtt: {
        qos: 1,
        topicPrefix: 'test/sync',
        clientIdPrefixServer: 'server',
        publishQueueSize: 2,
      },
    },
  }

  function create_client() {
    const handlers = new Map<string, ((... args: any[]) => void)[]>()
    return {
      connected: false,
      publish: vi.fn(),
      on: vi.fn((event: string, handler: (... args: any[]) => void) => {
        handlers.set(event, [... handlers.get(event) ?? [], handler])
      }),
      end: vi.fn(),
      emit(event: string, ... args: any[]) {
        if (event === 'connect') {
          this.connected = true
        }
        if (event === 'close') {
          this.connected = false
        }
        for (const handler of handlers.get(event) ?? []) {
          handler(... args)
        }
      },
    }
  }

  return {
    config,
    client: create_client(),
    create_client,
    connect: vi.fn(),
  }
})

vi.mock('mqtt', () => ({
  default: { connect: mocks.connect },
}))

vi.mock('@config/loader', () => ({ runtime_config: () => mocks.config }))

async function load_module() {
  vi.resetModules()
  return await import('@server/lib/mqtt')
}

beforeEach(() => {
  mocks.config.mqtt.host = 'mqtt-host'
  mocks.config.mqtt.port = 1883
  mocks.config.mqtt.username = ''
  mocks.config.mqtt.password = ''
  mocks.client = mocks.create_client()
  mocks.connect.mockReset()
  mocks.connect.mockReturnValue(mocks.client)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('confirmed durable publish', () => {
  it('closes only an existing worker connection and permits a later fresh client', async () => {
    const { stop_mqtt_client, get_mqtt_client } = await load_module()
    await stop_mqtt_client()
    expect(mocks.connect).not.toHaveBeenCalled()
    get_mqtt_client()
    mocks.client.end.mockImplementation((_force, _options, done) => done())
    await stop_mqtt_client()
    expect(mocks.client.end).toHaveBeenCalledOnce()
    get_mqtt_client()
    expect(mocks.connect).toHaveBeenCalledTimes(2)
  })
  it('does not acknowledge a disconnected in-memory queue or enqueue durable events there', async () => {
    const { publish_sync_confirmed } = await load_module()
    await expect(publish_sync_confirmed('content_story:1', 'event', 1000)).rejects.toThrow('disconnected')
    mocks.client.emit('connect')
    expect(mocks.client.publish).not.toHaveBeenCalled()
  })

  it('waits for QoS 1 ACK and preserves the supplied event payload', async () => {
    const { publish_sync_confirmed } = await load_module()
    mocks.client.connected = true
    let acknowledged = false
    const delivery = publish_sync_confirmed('content_story:1', '{"id":"stable"}', 1000).then(() => {
      acknowledged = true
    })
    await Promise.resolve()
    expect(acknowledged).toBe(false)
    expect(mocks.client.publish).toHaveBeenCalledWith('test/sync/content_story:1', '{"id":"stable"}', { qos: 1 }, expect.any(Function))
    mocks.client.publish.mock.calls[0]![3](null)
    await delivery
    expect(acknowledged).toBe(true)
  })

  it.each(['error', 'negative-ack', 'timeout', 'throw'])('rejects an unconfirmed delivery (%s)', async (failure) => {
    vi.useFakeTimers()
    const { publish_sync_confirmed } = await load_module()
    mocks.client.connected = true
    if (failure === 'throw')
      mocks.client.publish.mockImplementation(() => { throw new Error('closed') })
    const delivery = publish_sync_confirmed('content_story:1', 'stable-event', 1000)
    const rejection = expect(delivery).rejects.toThrow()
    if (failure === 'error')
      mocks.client.publish.mock.calls[0]![3](new Error('broker rejected'))
    if (failure === 'negative-ack')
      mocks.client.publish.mock.calls[0]![3](null, { reasonCode: 135 })
    if (failure === 'timeout') {
      await vi.advanceTimersByTimeAsync(1000)
      mocks.client.publish.mock.calls[0]![3](null) // Late ACK cannot turn a rejected promise into success.
    }
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('publish_sync', () => {
  it('connects through structured options without invoking the real dependency\'s legacy URL parser', async () => {
    const real_mqtt = await vi.importActual<typeof import('mqtt')>('mqtt')
    const parse = vi.spyOn(node_url, 'parse').mockImplementation(() => {
      throw new Error('Legacy URL parsing must not run')
    })
    const username = 'publisher:@/?%#'
    const password = 'unit-test-secret:@/?%#'
    Object.assign(mocks.config.mqtt, { host: '::1', port: 1884, username, password })
    mocks.connect.mockImplementation((options_or_url, options) => typeof options_or_url === 'string'
      ? real_mqtt.default.connect(options_or_url, { ... options, manualConnect: true })
      : real_mqtt.default.connect({ ... options_or_url, manualConnect: true }))
    const { get_mqtt_client } = await load_module()

    const client = get_mqtt_client()

    expect(client).not.toBeNull()
    expect(parse).not.toHaveBeenCalled()
    expect(mocks.connect).toHaveBeenCalledWith({
      protocol: 'mqtt', host: '::1', port: 1884, username, password,
      clientId: expect.stringMatching(/^server_/), clean: true, reconnectPeriod: 5000, connectTimeout: 30_000,
    })
    expect(client?.options).toMatchObject({ protocol: 'mqtt', host: '::1', port: 1884, username, password })
    // manualConnect creates no socket/timers; end() requires a created stream.
  })

  it.each([['', ''], ['publisher', ''], ['', 'unit-test-secret']])('preserves anonymous connections when either credential is absent', async (username, password) => {
    Object.assign(mocks.config.mqtt, { username, password })
    const { get_mqtt_client } = await load_module()
    get_mqtt_client()
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ protocol: 'mqtt', host: 'mqtt-host', port: 1883 }))
    const options = mocks.connect.mock.calls[0]![0]
    expect(options).not.toHaveProperty('username')
    expect(options).not.toHaveProperty('password')
  })

  it('publishes immediately when the client is connected', async () => {
    const { publish_sync } = await load_module()
    mocks.client.connected = true

    publish_sync('story/1', '{"a":1}')

    expect(mocks.client.publish).toHaveBeenCalledWith('test/sync/story/1', '{"a":1}', { qos: 1 })
  })

  it('queues events while disconnected and flushes them on connect', async () => {
    const { publish_sync } = await load_module()

    publish_sync('story/1', 'first')
    publish_sync('story/2', 'second')
    expect(mocks.client.publish).not.toHaveBeenCalled()

    mocks.client.emit('connect')

    expect(mocks.client.publish).toHaveBeenNthCalledWith(1, 'test/sync/story/1', 'first', { qos: 1 })
    expect(mocks.client.publish).toHaveBeenNthCalledWith(2, 'test/sync/story/2', 'second', { qos: 1 })
  })

  it('reuses the automatically reconnecting client after close and flushes queued events', async () => {
    const { publish_sync } = await load_module()

    mocks.client.connected = true
    publish_sync('story/0', 'warmup')

    mocks.client.emit('close')
    publish_sync('story/1', 'queued')

    expect(mocks.connect).toHaveBeenCalledTimes(1)
    mocks.client.emit('connect')
    expect(mocks.client.publish).toHaveBeenCalledWith('test/sync/story/1', 'queued', { qos: 1 })
  })

  it('drops the oldest queued event when the queue is full and logs it', async () => {
    const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { publish_sync } = await load_module()

    publish_sync('story/1', 'first')
    publish_sync('story/2', 'second')
    publish_sync('story/3', 'third')

    const line = JSON.parse(error_spy.mock.calls[0]![0] as string)
    expect(line).toMatchObject({
      level: 'error',
      msg: 'mqtt-publish-dropped',
      resource: 'story/3',
      queue_size: 2,
      dropped_total: 1,
    })

    mocks.client.emit('connect')

    expect(mocks.client.publish).toHaveBeenCalledTimes(2)
    expect(mocks.client.publish).toHaveBeenNthCalledWith(1, 'test/sync/story/2', 'second', { qos: 1 })
    expect(mocks.client.publish).toHaveBeenNthCalledWith(2, 'test/sync/story/3', 'third', { qos: 1 })
  })
})
