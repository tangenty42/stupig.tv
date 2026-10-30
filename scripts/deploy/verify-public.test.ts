import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verify_public } from './verify-public'

const targets = { site: 'https://site.example', public_ws: 'wss://mqtt.example/mqtt', draft_ws: 'wss://mqtt.example/mqtt-drafts' }
let broken = ''
const sent: number[] = []
class BrokerSocket extends EventTarget {
  binaryType = ''
  constructor(private url: string) {
    super()
    queueMicrotask(() => this.dispatchEvent(new Event(broken === 'upgrade' && url === targets.draft_ws ? 'error' : 'open')))
  }

  close() {}
  send(value: Buffer) {
    sent.push(value[0] >> 4)
    if (value[0] >> 4 === 1) {
      this.reply([0x20, 2, 0, this.url === targets.draft_ws && broken !== 'anonymous-route' ? 5 : 0])
    }
    else {
      const topic = value.subarray(6, - 1).toString()
      this.reply([0x90, 3, 0, 1, topic.includes('draft-sync') && broken !== 'private-allowed' ? 0x80 : 0])
    }
  }

  reply(bytes: number[]) {
    queueMicrotask(() => {
      const event = new Event('message')
      Object.defineProperty(event, 'data', { value: Uint8Array.from(bytes).buffer })
      this.dispatchEvent(event)
    })
  }
}

beforeEach(() => {
  broken = ''
  sent.length = 0
  vi.stubGlobal('WebSocket', BrokerSocket)
  vi.stubGlobal('fetch', vi.fn(async (url: URL) => url.pathname === '/healthz' ? Response.json({ status: 'ok' }) : new Response('home')))
})
afterEach(() => vi.unstubAllGlobals())

describe('public production acceptance', () => {
  it('checks HTTP and both MQTT listeners without publishing business events', async () => {
    await verify_public(targets)
    expect(sent.filter(type => type === 1)).toHaveLength(4)
    expect(sent).not.toContain(3)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each(['upgrade', 'anonymous-route', 'private-allowed'])('rejects a healthy app with broken WSS security: %s', async (failure) => {
    broken = failure
    await expect(verify_public(targets)).rejects.toThrow(/MQTT acceptance/)
  })

  it('rejects a failing public application before opening MQTT connections', async () => {
    vi.stubGlobal('fetch', async () => new Response('unavailable', { status: 503 }))
    await expect(verify_public(targets)).rejects.toThrow(/HTTP acceptance/)
    expect(sent).toHaveLength(0)
  })
})
