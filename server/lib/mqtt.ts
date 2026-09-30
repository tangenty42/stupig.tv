import { error_fields, log_error, log_info } from '@server/lib/log'
import mqtt from 'mqtt'
import { env } from '../shared/env'

function server_client_id() {
  return `${env.MQTT_CLIENT_ID_PREFIX_SERVER}_${process.pid}_${Date.now()}`
}

function broker_url() {
  const auth = env.MQTT_USERNAME && env.MQTT_PASSWORD
    ? `${encodeURIComponent(env.MQTT_USERNAME)}:${encodeURIComponent(env.MQTT_PASSWORD)}@`
    : ''
  return `mqtt://${auth}${env.MQTT_HOST}:${env.MQTT_PORT}`
}

let client: mqtt.MqttClient | null = null

interface PendingPublish {
  resource: string
  payload: string
}

let pending: PendingPublish[] = []
let dropped_total = 0

function flush_pending(client: mqtt.MqttClient) {
  if (! client.connected || pending.length === 0) {
    return
  }

  const queued = pending
  pending = []
  for (const { resource, payload } of queued) {
    client.publish(sync_topic(resource), payload, { qos: env.MQTT_QOS as 0 | 1 | 2 })
  }
}

export function get_mqtt_client() {
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
      log_error('mqtt server client error', { error_message: error.message })
    })

    client.on('close', () => {
      client = null
      log_info('mqtt server client disconnected — will reconnect on next publish')
    })

    client.on('connect', () => {
      log_info('mqtt server client connected')
      if (client) {
        flush_pending(client)
      }
    })

    return client
  }
  catch (error) {
    log_error('mqtt failed to create server client', error_fields(error))
    return null
  }
}

export function sync_topic(resource: string) {
  return `${env.MQTT_TOPIC_PREFIX}/${resource}`
}

// The broker may be unreachable for seconds at a time (reconnectPeriod is 5s),
// so events published mid-reconnect queue up and flush on 'connect' instead of
// racing a short retry window. The queue is bounded; overflow drops the oldest
// event and is logged so silent sync gaps stay observable.
export function publish_sync(resource: string, payload: string) {
  const mqtt = get_mqtt_client()

  if (mqtt?.connected) {
    mqtt.publish(sync_topic(resource), payload, { qos: env.MQTT_QOS as 0 | 1 | 2 })
    return
  }

  if (pending.length >= env.MQTT_PUBLISH_QUEUE_SIZE) {
    pending.shift()
    dropped_total += 1
    log_error('mqtt-publish-dropped', {
      resource,
      queue_size: env.MQTT_PUBLISH_QUEUE_SIZE,
      dropped_total,
    })
  }
  pending.push({ resource, payload })
}
