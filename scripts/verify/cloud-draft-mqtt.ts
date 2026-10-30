import type { AuthUser } from '@server/types/auth'
import type { MqttClient } from 'mqtt'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { runtime_config } from '@config/loader'
import { db } from '@server/lib/db'
import { wire_resource } from '@server/lib/sync-channel'
import { authenticate_draft_sync, draft_sync_credentials } from '@server/services/content/draft-sync.service'
import { settings } from '@shared/settings'
import { connectAsync } from 'mqtt'
import { start_cloud_draft_broker } from '../testing/cloud-draft-broker'

/** Uses the caller's already isolated QA database, never production credentials. */
export async function verify_draft_mqtt(actor: AuthUser) {
  const publisher = { username: 'qa-publisher', password: randomBytes(32).toString('hex') }
  const broker = await start_cloud_draft_broker(`.dev/draft-mqtt-${randomBytes(8).toString('hex')}`, publisher, authenticate_draft_sync)
  const clients: MqttClient[] = []
  async function connect(url: string, credentials = {}) {
    const client = await connectAsync(url, { ... credentials, connectTimeout: 5000, reconnectPeriod: 0, clean: true }, false)
    client.on('error', () => {})
    clients.push(client)
    return client
  }
  function closed(client: MqttClient, timeout = 6000) {
    return new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('MQTT denial/expiry did not disconnect')), timeout)
      client.once('close', () => {
        clearTimeout(timer)
        accept()
      })
    })
  }
  try {
    const public_client = await connect(broker.public_url)
    console.log('cloud-draft MQTT QA: public listener connected')
    const denied = closed(public_client)
    void public_client.subscribeAsync(`${settings.integrations.mqtt.privateTopicPrefix}/#`).catch(() => {})
    await denied
    console.log('cloud-draft MQTT QA: anonymous private-topic subscription rejected')
    await assert.rejects(connect(broker.private_url))
    const credential = await draft_sync_credentials(actor)
    await assert.rejects(connect(broker.private_url, { ... credential, password: `${credential.password}x` }))
    const subscriber = await connect(broker.private_url, credential)
    console.log('cloud-draft MQTT QA: signed private connection accepted')
    const resource = wire_resource('content_drafts:all')
    const topic = `${settings.integrations.mqtt.privateTopicPrefix}/${resource}`
    const grants = await subscriber.subscribeAsync(topic, { qos: 1 })
    assert.equal(grants[0]!.qos, 1)
    const sent = randomBytes(8).toString('hex')
    const received = new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Private MQTT event was not received')), 5000)
      subscriber.once('message', (_topic, body) => {
        clearTimeout(timer)
        accept(body.toString())
      })
    })
    const server = await connect(`mqtt://127.0.0.1:${broker.tcp_port}`, publisher)
    await server.publishAsync(topic, sent, { qos: 1 })
    assert.equal(await received, sent)
    const publish_denied = closed(subscriber)
    void subscriber.publishAsync(topic, 'must-not-publish').catch(() => {})
    await publish_denied
    const payload = JSON.parse(Buffer.from(credential.password.split('.')[0]!, 'base64url').toString())
    payload.expires_at = Math.floor(Date.now() / 1000) + 4
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signature = createHmac('sha256', runtime_config().app.auth.jwt.secret).update(`draft-mqtt:v1:${encoded}`).digest('hex')
    const expiring = await connect(broker.private_url, { username: credential.username, password: `${encoded}.${signature}` })
    await closed(expiring)
    await db.execute('UPDATE users SET is_admin = 0, permissions = JSON_ARRAY() WHERE id = ?', [actor.id])
    await assert.rejects(connect(broker.private_url, credential))
    console.log('cloud-draft MQTT QA passed: anonymous/private rejection, signed subscribe, QoS 1 delivery, publish denial, expiry and permission revocation')
  }
  finally {
    await db.execute('UPDATE users SET is_admin = 1 WHERE id = ?', [actor.id])
    for (const client of clients) client.end(true)
    await broker.stop()
  }
}
