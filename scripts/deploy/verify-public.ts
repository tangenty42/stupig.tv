import { settings } from '@shared/settings'

interface PublicTargets { site: string, public_ws: string, draft_ws: string }

function mqtt_string(value: string) {
  const bytes = Buffer.from(value)
  const length = Buffer.alloc(2)
  length.writeUInt16BE(bytes.length)
  return Buffer.concat([length, bytes])
}

function packet(type: number, body: Buffer) {
  return Buffer.concat([Buffer.from([type, body.length]), body])
}

async function mqtt_probe(url: string, mode: 'public' | 'private-topic' | 'anonymous' | 'invalid-ticket') {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, 'mqtt')
    socket.binaryType = 'arraybuffer'
    let finished = false
    let subscribing = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (passed: boolean) => {
      if (finished)
        return
      finished = true
      clearTimeout(timer)
      try {
        socket.close()
      }
      catch { /* A failed HTTP upgrade may already have closed the socket. */ }
      if (passed)
        resolve()
      else reject(new Error(`Public MQTT acceptance failed: ${mode}`))
    }
    timer = setTimeout(finish, 10000, false)
    socket.addEventListener('open', () => {
      const credentials = mode === 'invalid-ticket'
      socket.send(packet(0x10, Buffer.concat([
        Buffer.from([0, 4, 77, 81, 84, 84, 4, credentials ? 0xC2 : 0x02, 0, 30]),
        mqtt_string(`release_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`),
        ... (credentials ? [mqtt_string('draft-v1'), mqtt_string('invalid')] : []),
      ])))
    })
    socket.addEventListener('message', (event) => {
      const bytes = Buffer.from(event.data as ArrayBuffer)
      if (bytes[0] >> 4 === 2) {
        if (mode === 'anonymous' || mode === 'invalid-ticket') {
          finish(bytes[3] === 5)
          return
        }
        if (bytes[3] !== 0) {
          finish(false)
          return
        }
        subscribing = true
        socket.send(packet(0x82, Buffer.concat([Buffer.from([0, 1]), mqtt_string(mode === 'public' ? `${settings.integrations.mqtt.topicPrefix}/__release_probe` : `${settings.integrations.mqtt.privateTopicPrefix}/#`), Buffer.from([0])])))
      }
      else if (bytes[0] >> 4 === 9) {
        finish(bytes[4] === (mode === 'public' ? 0 : 0x80))
      }
    })
    socket.addEventListener('close', () => finish(mode === 'private-topic' && subscribing))
    socket.addEventListener('error', () => finish(false))
  })
}

export async function verify_public(targets: PublicTargets) {
  for (const path of ['/', '/healthz']) {
    const response = await fetch(new URL(path, targets.site), { signal: AbortSignal.timeout(15000), redirect: 'error', cache: 'no-store' })
    if (! response.ok)
      throw new Error('Public HTTP acceptance failed')
    if (path === '/healthz' && (await response.json() as { status?: string }).status !== 'ok')
      throw new Error('Public readiness response invalid')
    if (path !== '/healthz')
      await response.body?.cancel()
  }
  await mqtt_probe(targets.public_ws, 'public')
  await mqtt_probe(targets.public_ws, 'private-topic')
  await mqtt_probe(targets.draft_ws, 'anonymous')
  await mqtt_probe(targets.draft_ws, 'invalid-ticket')
}
