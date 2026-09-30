import type { DataSyncEvent } from '@shared/types/sync'
import type MqttClient from 'mqtt/lib/client'
import { sync_resource } from '@shared/types/sync'
import mqtt from 'mqtt'

type BroadcastMessage
  = | { type: 'sync_event', payload: DataSyncEvent }
    | { type: 'login' }
    | { type: 'logout' }
    | { type: 'request_resources', id: string }
    | { type: 'report_resources', request_id: string, resources: string[] }
    | { type: 'subscribe_resource', resource: string }
    | { type: 'unsubscribe_resource', resource: string }

type SyncListener = (event?: DataSyncEvent) => void
type SyncStatus = 'closed' | 'connecting' | 'open'

let last_seen_id = ''

function get_listeners() {
  if (import.meta.server) {
    return new Map<string, Set<SyncListener>>()
  }
  return useState<Map<string, Set<SyncListener>>>(
    'data-sync-listeners',
    () => new Map(),
  ).value
}

let mqtt_client: MqttClient | null = null
const status = ref<SyncStatus>('closed')
let token_watch_setup = false
let connecting_promise: Promise<any> | null = null
let connection_generation = 0
let current_client_id: string | null = null
let broadcast_channel: BroadcastChannel | null = null
let collected_resources = new Set<string>()
let resource_gather_promise: Promise<Set<string>> | null = null

function get_broadcast_channel() {
  if (import.meta.server) {
    return null
  }

  if (broadcast_channel) {
    return broadcast_channel
  }

  if (typeof BroadcastChannel === 'undefined') {
    return null
  }

  const config = useRuntimeConfig().public
  broadcast_channel = new BroadcastChannel(config.sync_broadcast_channel_name)
  return broadcast_channel
}

function sync_client_id() {
  if (import.meta.server) {
    return ''
  }
  const config = useRuntimeConfig().public
  const key = config.sync_client_id_storage_key
  let id = sessionStorage.getItem(key)
  if (! id) {
    id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    sessionStorage.setItem(key, id)
  }
  return id
}

function safe_call(listener: SyncListener, event: DataSyncEvent) {
  try {
    listener(event)
  }
  catch {
  }
}

function notify_listeners(event: DataSyncEvent) {
  const listeners = get_listeners()
  if (event.type === 'sync') {
    if (event.sync_all) {
      listeners.forEach((listener_set) => {
        listener_set.forEach(listener => safe_call(listener, event))
      })
    }
    else if (event.dirty_resources) {
      const dirty_set = new Set(event.dirty_resources)
      listeners.forEach((listener_set, key) => {
        if (! dirty_set.has(key)) {
          return
        }
        listener_set.forEach(listener => safe_call(listener, event))
      })
    }
    return
  }

  listeners.get(event.resource)?.forEach(listener => safe_call(listener, event))

  listeners.forEach((listener_set, key) => {
    if (key === event.resource) {
      return
    }

    if (key.endsWith('*') && event.resource.startsWith(key.slice(0, - 1))) {
      listener_set.forEach(listener => safe_call(listener, event))
    }
  })
}

function is_duplicate(id: string) {
  if (id && id === last_seen_id) {
    return true
  }

  last_seen_id = id
  return false
}

function next_event_id() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function broadcast_event(event: DataSyncEvent) {
  const channel = get_broadcast_channel()
  if (! channel) {
    return
  }

  try {
    last_seen_id = event.id
    channel.postMessage({ type: 'sync_event', payload: event })
  }
  catch {
  }
}

export function broadcast_logout() {
  const channel = get_broadcast_channel()
  if (! channel) {
    return
  }

  try {
    channel.postMessage({ type: 'logout' })
  }
  catch {
  }
}

export function broadcast_login(user_id: number) {
  const channel = get_broadcast_channel()
  if (! channel) {
    return
  }

  const event: DataSyncEvent = {
    id: next_event_id(),
    type: 'refresh',
    resource: sync_resource('auth_user', user_id),
    timestamp: Date.now(),
  }

  try {
    channel.postMessage({ type: 'login' })
  }
  catch {
  }

  broadcast_event(event)
}

function broker_ws_url() {
  const config = useRuntimeConfig().public
  const host = config.mqtt_ws_host
  const is_secure = typeof location !== 'undefined' && location.protocol === 'https:'
  const port = is_secure ? config.mqtt_wss_port : config.mqtt_ws_port
  const protocol = is_secure ? 'wss' : 'ws'
  return `${protocol}://${host}:${port}/mqtt`
}

function broker_client_id() {
  const config = useRuntimeConfig().public
  if (! current_client_id) {
    // One stable id per tab (sessionStorage) so reconnects resume the same
    // broker session: with clean=false and QoS 1, sessionPresent then tells us
    // whether offline events were queued, letting quick reconnects skip the
    // full refresh below.
    current_client_id = `${config.mqtt_client_id_prefix_web}_${sync_client_id()}`
  }
  return current_client_id
}

async function open_mqtt() {
  if (import.meta.server) {
    return
  }

  if (document.hidden) {
    return
  }

  if (mqtt_client?.connected) {
    return
  }

  if (connecting_promise) {
    return connecting_promise
  }

  status.value = 'connecting'

  connecting_promise = (async () => {
    const generation = connection_generation
    const document_first_load = useState('document-first-load', () => true)

    try {
      if (typeof mqtt.connect !== 'function') {
        console.error('[MQTT] connect is not available', mqtt)
        status.value = 'closed'
        return
      }

      if (generation !== connection_generation) {
        return
      }

      const client = mqtt.connect(broker_ws_url(), {
        clientId: broker_client_id(),
        clean: false,
        reconnectPeriod: 5000,
        connectTimeout: 30_000,
      })

      if (generation !== connection_generation) {
        try {
          client.end(true)
        }
        catch {}
        return
      }

      mqtt_client = client

      client.on('connect', (connack) => {
        if (client !== mqtt_client) {
          return
        }
        status.value = 'open'
        sync_mqtt_subscriptions()

        if (! connack?.sessionPresent && ! document_first_load.value) {
          notify_all_listeners_refresh()
        }
        document_first_load.value = false
      })

      client.on('message', (_topic: string, message: Buffer) => {
        if (client !== mqtt_client) {
          return
        }

        try {
          const data = JSON.parse(message.toString()) as DataSyncEvent

          if (is_duplicate(data.id)) {
            return
          }

          broadcast_event(data)
          notify_listeners(data)
        }
        catch {
        }
      })

      client.on('error', () => {
        if (client !== mqtt_client) {
          return
        }
        status.value = 'closed'
        schedule_reconnect()
      })

      client.on('close', () => {
        if (client !== mqtt_client) {
          return
        }
        mqtt_client = null
        status.value = 'closed'
        schedule_reconnect()
      })
    }
    catch (error) {
      console.error('[MQTT] failed to open connection', error)
      status.value = 'closed'
    }
    finally {
      connecting_promise = null
    }
  })()

  return connecting_promise
}

function sync_mqtt_subscriptions() {
  if (import.meta.server) {
    return
  }
  const listeners = get_listeners()
  const config = useRuntimeConfig().public

  if (! mqtt_client?.connected) {
    return
  }

  const all_resources = Array.from(new Set([... listeners.keys(), ... collected_resources]))
  const topics = all_resources.map(resource => `${config.mqtt_topic_prefix}/${resource}`)
  if (topics.length) {
    const client = mqtt_client
    try {
      client.subscribe(topics, { qos: config.mqtt_qos as 0 | 1 | 2 }, (err: any) => {
        if (err && ! err.message?.includes('Connection closed')) {
          console.error('[MQTT] subscribe failed', err)
        }
      })
    }
    catch {
    }
  }
}

function update_mqtt_subscriptions(added: string[], removed: string[]) {
  if (import.meta.server) {
    return
  }
  const config = useRuntimeConfig().public

  if (! mqtt_client?.connected) {
    return
  }

  if (added.length) {
    const client = mqtt_client
    const topics = added.map(resource => `${config.mqtt_topic_prefix}/${resource}`)
    try {
      client.subscribe(topics, { qos: config.mqtt_qos as 0 | 1 | 2 }, (err: any) => {
        if (err && ! err.message?.includes('Connection closed')) {
          console.error('[MQTT] subscribe failed', err)
        }
      })
    }
    catch {
    }
  }

  if (removed.length) {
    const client = mqtt_client
    const topics = removed.map(resource => `${config.mqtt_topic_prefix}/${resource}`)
    try {
      client.unsubscribe(topics, (err: any) => {
        if (err && ! err.message?.includes('Connection closed')) {
          console.error('[MQTT] unsubscribe failed', err)
        }
      })
    }
    catch {
    }
  }
}

function close_mqtt() {
  if (import.meta.server) {
    return
  }
  const client = mqtt_client
  connection_generation += 1
  mqtt_client = null
  connecting_promise = null

  if (client) {
    // End (which clears the connack timer) BEFORE removing listeners. If we strip
    // listeners first, a connack timer that fires during teardown emits 'error'
    // with no listener and Node throws "Uncaught Error: connack timeout".
    try {
      client.end(true)
    }
    catch {
    }

    try {
      client.removeAllListeners()
    }
    catch {
    }
  }

  status.value = 'closed'
}

function schedule_reconnect() {
  if (import.meta.server) {
    return
  }
  if (document.hidden) {
    return
  }

  setTimeout(() => {
    void open_mqtt()
  }, 1000)
}

function reset_connection() {
  if (import.meta.server) {
    return
  }
  close_mqtt()
  void open_mqtt()
}

function handle_visibility_change() {
  if (import.meta.server) {
    return
  }
  if (document.hidden) {
    close_mqtt()
  }
  else {
    void collect_resources().then(() => open_mqtt())
  }
}

function notify_all_listeners_refresh() {
  const event: DataSyncEvent = {
    id: next_event_id(),
    type: 'sync',
    resource: '',
    sync_all: true,
    timestamp: Date.now(),
  }
  notify_listeners(event)
}

async function collect_resources() {
  const gathered = await gather_resources()
  const old_collected = new Set(collected_resources)
  collected_resources = gathered

  const to_subscribe = new Set<string>()
  const to_unsubscribe = new Set<string>()
  const listeners = get_listeners()

  for (const resource of gathered) {
    if (! old_collected.has(resource) && ! listeners.has(resource)) {
      to_subscribe.add(resource)
    }
  }

  for (const resource of old_collected) {
    if (! gathered.has(resource) && ! listeners.has(resource)) {
      to_unsubscribe.add(resource)
    }
  }

  if (mqtt_client?.connected && (to_subscribe.size || to_unsubscribe.size)) {
    update_mqtt_subscriptions(Array.from(to_subscribe), Array.from(to_unsubscribe))
  }
}

function gather_resources() {
  const channel = get_broadcast_channel()
  if (! channel) {
    return Promise.resolve(new Set<string>())
  }

  if (resource_gather_promise) {
    return resource_gather_promise
  }

  resource_gather_promise = new Promise<Set<string>>((resolve) => {
    const request_id = next_event_id()
    const collected = new Set<string>()

    function on_message(event: MessageEvent) {
      const data = event.data as BroadcastMessage
      if (data.type === 'report_resources' && data.request_id === request_id) {
        for (const resource of data.resources) {
          collected.add(resource)
        }
      }
    }

    channel.addEventListener('message', on_message)

    const cleanup = () => {
      channel.removeEventListener('message', on_message)
      resource_gather_promise = null
    }

    try {
      channel.postMessage({ type: 'request_resources', id: request_id })
    }
    catch {
      cleanup()
      resolve(new Set())
      return
    }

    setTimeout(() => {
      cleanup()
      resolve(collected)
    }, 200)
  })

  return resource_gather_promise
}

export function useDataSync() {
  const { handle_remote_logout } = useAuth()

  function perform_cross_tab_login() {
    notify_all_listeners_refresh()
  }

  function perform_cross_tab_logout() {
    handle_remote_logout()
  }

  function handle_broadcast_message(event: MessageEvent) {
    if (import.meta.server) {
      return
    }

    const data = event.data as BroadcastMessage

    if (data.type === 'login') {
      perform_cross_tab_login()
      return
    }

    if (data.type === 'logout') {
      perform_cross_tab_logout()
      return
    }

    if (data.type === 'sync_event') {
      if (mqtt_client?.connected) {
        return
      }

      if (is_duplicate(data.payload.id)) {
        return
      }

      notify_listeners(data.payload)
      return
    }

    if (data.type === 'request_resources') {
      const listeners = get_listeners()
      const resources = Array.from(listeners.keys())
      get_broadcast_channel()?.postMessage({
        type: 'report_resources',
        request_id: data.id,
        resources,
      })
    }

    if (data.type === 'subscribe_resource') {
      collected_resources.add(data.resource)
      if (mqtt_client?.connected) {
        update_mqtt_subscriptions([data.resource], [])
      }
      return
    }

    if (data.type === 'unsubscribe_resource') {
      const listeners = get_listeners()
      if (listeners.has(data.resource)) {
        return
      }
      collected_resources.delete(data.resource)
      if (mqtt_client?.connected) {
        update_mqtt_subscriptions([], [data.resource])
      }
    }
  }

  function start_cross_tab_transport() {
    const channel = get_broadcast_channel()
    if (! channel) {
      return
    }

    channel.addEventListener('message', handle_broadcast_message)
  }

  if (import.meta.client && ! token_watch_setup) {
    token_watch_setup = true
    let initial_gather_done = false

    start_cross_tab_transport()

    window.addEventListener('pagehide', () => {
      close_mqtt()
      broadcast_channel?.close()
      broadcast_channel = null
    })

    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        start_cross_tab_transport()
      }
    })

    const config = useRuntimeConfig().public
    // Watches the user cookie rather than the auth token: the token cookie is
    // now httpOnly and unreadable here, and login/logout move the user cookie in
    // lockstep, which is all this signal needs.
    const user = useCookie(config.auth_user_cookie_name)
    watch(user, () => {
      if (! initial_gather_done) {
        return
      }
      // Identity changed: every subscription's data may be identity-scoped
      // (permissions, private content), so refresh explicitly — with
      // clean:false the reconnect below no longer implies a full refresh.
      notify_all_listeners_refresh()
      reset_connection()
    }, { immediate: true })

    document.addEventListener('visibilitychange', handle_visibility_change)

    async function do_initial_gather() {
      if (! document.hidden) {
        await collect_resources()
      }
      initial_gather_done = true
      void open_mqtt()
    }

    void do_initial_gather()
  }

  return {
    status: readonly(status),
    subscribe(
      resource: string,
      listener: SyncListener,
    ) {
      const listeners = get_listeners()
      const is_new_resource = ! listeners.has(resource)

      if (is_new_resource) {
        listeners.set(resource, new Set())
      }

      listeners.get(resource)!.add(listener)

      if (is_new_resource) {
        if (mqtt_client?.connected) {
          update_mqtt_subscriptions([resource], [])
        }
        else {
          get_broadcast_channel()?.postMessage({ type: 'subscribe_resource', resource })
          void open_mqtt()
        }
      }

      const unsubscribe = () => {
        listeners.get(resource)?.delete(listener)

        if (listeners.get(resource) && ! listeners.get(resource)!.size) {
          listeners.delete(resource)
          if (mqtt_client?.connected) {
            update_mqtt_subscriptions([], [resource])
          }
          else {
            get_broadcast_channel()?.postMessage({ type: 'unsubscribe_resource', resource })
          }
        }
      }

      return unsubscribe
    },
  }
}
