import mqtt from 'mqtt'
import { env } from '../shared/env'

function server_client_id(): string {
  return `${env.MQTT_CLIENT_ID_PREFIX_SERVER}_${process.pid}_${Date.now()}`
}

function broker_url(): string {
  const auth = env.MQTT_USERNAME && env.MQTT_PASSWORD
    ? `${encodeURIComponent(env.MQTT_USERNAME)}:${encodeURIComponent(env.MQTT_PASSWORD)}@`
    : ''
  return `mqtt://${auth}${env.MQTT_HOST}:${env.MQTT_PORT}`
}

let client: mqtt.MqttClient | null = null

export function get_mqtt_client(): mqtt.MqttClient | null {
  if (client) {
    return client
  }

  try {
    client = mqtt.connect(broker_url(), {
      clientId: server_client_id(),
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 30_000,
    })

    client.on('error', (error) => {
      console.error('[MQTT] server client error:', error.message)
    })

    client.on('close', () => {
      client = null
      console.log('[MQTT] server client disconnected — will reconnect on next publish')
    })

    client.on('connect', () => {
      console.log('[MQTT] server client connected')
    })

    return client
  }
  catch (error) {
    console.error('[MQTT] failed to create server client:', error)
    return null
  }
}

export function sync_topic(resource: string): string {
  return `${env.MQTT_TOPIC_PREFIX}/${resource}`
}

function publish_when_ready(resource: string, payload: string, attempts: number = 0) {
  const mqtt = get_mqtt_client()
  if (! mqtt) {
    return
  }

  if (mqtt.connected) {
    mqtt.publish(sync_topic(resource), payload, { qos: env.MQTT_QOS as 0 | 1 | 2 })
    return
  }

  // Client is still connecting — wait a bit and retry once.
  if (attempts < 5) {
    setTimeout(publish_when_ready, 200, resource, payload, attempts + 1)
  }
}

export function publish_sync(resource: string, payload: string): void {
  publish_when_ready(resource, payload)
}
