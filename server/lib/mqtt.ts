import { runtime_config } from '@config/loader'
import { error_fields, log_error, log_info } from '@server/lib/log'
import mqtt from 'mqtt'

const config = runtime_config()

function server_client_id() {
  return `${config.integrations.mqtt.clientIdPrefixServer}_${process.pid}_${Date.now()}`
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
    client.publish(sync_topic(resource), payload, { qos: config.integrations.mqtt.qos })
  }
}

export function get_mqtt_client() {
  if (client) {
    return client
  }

  try {
    // MQTT.js parses string addresses with legacy url.parse(). The deployment
    // config already has structured fields, including unencoded credentials.
    client = mqtt.connect({
      protocol: 'mqtt',
      host: config.mqtt.host,
      port: config.mqtt.port,
      ... (config.mqtt.username && config.mqtt.password
        ? { username: config.mqtt.username, password: config.mqtt.password }
        : {}),
      clientId: server_client_id(),
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 30_000,
    })

    client.on('error', (error) => {
      log_error('mqtt server client error', { error_message: error.message })
    })

    client.on('close', () => {
      log_info('mqtt server client disconnected — awaiting automatic reconnect')
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

/** Close an existing worker client without creating a connection during shutdown. */
export async function stop_mqtt_client() {
  const active = client
  client = null
  if (active)
    await new Promise<void>(resolve => active.end(true, {}, () => resolve()))
}

export function sync_topic(resource: string) {
  return `${config.integrations.mqtt.topicPrefix}/${resource}`
}

// The broker may be unreachable for seconds at a time (reconnectPeriod is 5s),
// so events published mid-reconnect queue up and flush on 'connect' instead of
// racing a short retry window. The queue is bounded; overflow drops the oldest
// event and is logged so silent sync gaps stay observable.
export function publish_sync(resource: string, payload: string) {
  const mqtt = get_mqtt_client()

  if (mqtt?.connected) {
    mqtt.publish(sync_topic(resource), payload, { qos: config.integrations.mqtt.qos })
    return
  }

  if (pending.length >= config.integrations.mqtt.publishQueueSize) {
    pending.shift()
    dropped_total += 1
    log_error('mqtt-publish-dropped', {
      resource,
      queue_size: config.integrations.mqtt.publishQueueSize,
      dropped_total,
    })
  }
  pending.push({ resource, payload })
}

/** Durable callers retain their own work until a QoS 1 broker acknowledgement. */
export async function publish_sync_confirmed(resource: string, payload: string, timeout_ms: number) {
  const mqtt = get_mqtt_client()
  if (! mqtt?.connected)
    throw new Error('MQTT disconnected')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MQTT acknowledgement timeout')), timeout_ms)
    try {
      mqtt.publish(sync_topic(resource), payload, { qos: 1 }, (error, packet) => {
        clearTimeout(timer)
        if (error || (packet && 'reasonCode' in packet && Number(packet.reasonCode) >= 128))
          reject(new Error('MQTT publish rejected'))
        else
          resolve()
      })
    }
    catch (error) {
      clearTimeout(timer)
      reject(error)
    }
  })
}
