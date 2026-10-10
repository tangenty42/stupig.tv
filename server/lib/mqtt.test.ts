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
  mocks.client = mocks.create_client()
  mocks.connect.mockReset()
  mocks.connect.mockReturnValue(mocks.client)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('publish_sync', () => {
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

  it('reconnects on the next publish after a close and flushes queued events', async () => {
    const { publish_sync } = await load_module()

    mocks.client.connected = true
    publish_sync('story/0', 'warmup')

    mocks.client.emit('close')
    publish_sync('story/1', 'queued')

    // A fresh client is created for the reconnect.
    expect(mocks.connect).toHaveBeenCalledTimes(2)
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
