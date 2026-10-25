import type { DataSyncEvent } from '@shared/types/sync'
import type MqttClient from 'mqtt/lib/client'
import { settings } from '@shared/settings'
import { sync_resource } from '@shared/types/sync'
import mqtt from 'mqtt'

type BroadcastMessage
  = | { type: 'sync_event', payload: DataSyncEvent }
    | { type: 'login' }
    | { type: 'logout' }
    | { type: 'request_resources', id: string }
    | { type: 'report_resources', request_id?: string, tab_id: string, resources: string[] }
    | { type: 'release_resources', tab_id: string }

type SyncListener = (event?: DataSyncEvent) => void | Promise<void>
type SyncStatus = 'closed' | 'connecting' | 'open'

const transports = new WeakMap<object, ReturnType<typeof create_data_sync_transport>>()

export function useDataSync() {
  const app = useNuxtApp()
  let transport = transports.get(app)
  if (! transport) {
    transport = create_data_sync_transport(useRuntimeConfig().public.mqtt.web.wsUrl)
    transports.set(app, transport)
    const owned_transport = transport
    app.vueApp.onUnmount(() => owned_transport.dispose())
  }
  return transport
}

export function create_data_sync_transport(broker_url: string) {
  const listeners = new Map<string, Set<SyncListener>>()
  const seen_ids = new Set<string>()
  const remote_resources = new Map<string, Set<string>>()
  let disposed = false
  let started = false
  let suspended = false
  let reconnect_timer: ReturnType<typeof setTimeout> | null = null
  let cancel_gather: (() => void) | null = null
  let document_first_load = true

  function get_listeners() {
    return listeners
  }

  let mqtt_client: MqttClient | null = null
  const status = ref<SyncStatus>('closed')
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

    broadcast_channel = new BroadcastChannel(settings.app.client.sync.broadcastChannelName)
    return broadcast_channel
  }

  function sync_client_id() {
    if (import.meta.server) {
      return ''
    }
    const key = settings.app.client.sync.clientIdStorageKey
    let id = sessionStorage.getItem(key)
    if (! id) {
      id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      sessionStorage.setItem(key, id)
    }
    return id
  }

  function safe_call(listener: SyncListener, event: DataSyncEvent) {
    try {
      void Promise.resolve(listener(event)).catch(error => console.error('[Sync] listener failed', error))
    }
    catch (error) {
      console.error('[Sync] listener failed', error)
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
    if (! id) {
      return false
    }
    if (seen_ids.has(id)) {
      return true
    }
    seen_ids.add(id)
    if (seen_ids.size > settings.app.client.sync.eventDeduplicationLimit) {
      seen_ids.delete(seen_ids.values().next().value!)
    }
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
      channel.postMessage({ type: 'sync_event', payload: event })
    }
    catch {
    }
  }

  function broadcast_logout() {
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

  function broadcast_login(user_id: number) {
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

  function broker_client_id() {
    if (! current_client_id) {
    // One stable id per tab (sessionStorage) so reconnects resume the same
    // broker session: with clean=false and QoS 1, sessionPresent then tells us
    // whether offline events were queued, letting quick reconnects skip the
    // full refresh below.
      current_client_id = `${settings.integrations.mqtt.clientIdPrefixWeb}_${sync_client_id()}`
    }
    return current_client_id
  }

  function open_mqtt() {
    if (import.meta.server || disposed || suspended || ! started) {
      return
    }

    if (document.hidden) {
      return
    }

    if (mqtt_client) {
      return
    }

    status.value = 'connecting'

    {
      const generation = connection_generation

      try {
        if (typeof mqtt.connect !== 'function') {
          console.error('[MQTT] connect is not available', mqtt)
          status.value = 'closed'
          return
        }

        if (generation !== connection_generation) {
          return
        }

        const client = mqtt.connect(broker_url, {
          clientId: broker_client_id(),
          clean: false,
          reconnectPeriod: 0,
          connectTimeout: settings.app.client.sync.connectTimeoutMs,
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

          if (! connack?.sessionPresent && ! document_first_load) {
            notify_all_listeners_refresh()
          }
          document_first_load = false
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

        client.on('error', (error) => {
          if (client !== mqtt_client) {
            return
          }
          console.error('[MQTT] connection failed', error)
          close_mqtt()
          schedule_reconnect()
        })

        client.on('close', () => {
          if (client !== mqtt_client) {
            return
          }
          close_mqtt()
          schedule_reconnect()
        })
      }
      catch (error) {
        console.error('[MQTT] failed to open connection', error)
        status.value = 'closed'
        schedule_reconnect()
      }
    }
  }

  function sync_mqtt_subscriptions() {
    if (import.meta.server) {
      return
    }
    const listeners = get_listeners()

    if (! mqtt_client?.connected) {
      return
    }

    const all_resources = Array.from(new Set([... listeners.keys(), ... collected_resources]))
    const topics = all_resources.map(resource => `${settings.integrations.mqtt.topicPrefix}/${resource}`)
    if (topics.length) {
      const client = mqtt_client
      try {
        client.subscribe(topics, { qos: settings.integrations.mqtt.qos }, (err: any) => {
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
    if (! mqtt_client?.connected) {
      return
    }

    if (added.length) {
      const client = mqtt_client
      const topics = added.map(resource => `${settings.integrations.mqtt.topicPrefix}/${resource}`)
      try {
        client.subscribe(topics, { qos: settings.integrations.mqtt.qos }, (err: any) => {
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
      const topics = removed.map(resource => `${settings.integrations.mqtt.topicPrefix}/${resource}`)
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
    if (reconnect_timer) {
      clearTimeout(reconnect_timer)
      reconnect_timer = null
    }
    connection_generation += 1
    mqtt_client = null

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
    if (import.meta.server || disposed || ! started || reconnect_timer) {
      return
    }
    if (document.hidden) {
      return
    }

    reconnect_timer = setTimeout(() => {
      reconnect_timer = null
      void open_mqtt()
    }, settings.app.client.sync.reconnectDelayMs)
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
    if (disposed) {
      return
    }
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
      const collected = new Map<string, Set<string>>()
      let timer: ReturnType<typeof setTimeout> | undefined

      function on_message(event: MessageEvent) {
        const data = event.data as BroadcastMessage
        if (data.type === 'report_resources') {
          collected.set(data.tab_id, new Set(data.resources))
        }
        else if (data.type === 'release_resources') {
          collected.delete(data.tab_id)
        }
      }

      channel.addEventListener('message', on_message)

      const cleanup = () => {
        channel.removeEventListener('message', on_message)
        resource_gather_promise = null
        cancel_gather = null
        clearTimeout(timer)
      }

      cancel_gather = () => {
        cleanup()
        resolve(new Set())
      }

      try {
        channel.postMessage({ type: 'request_resources', id: request_id })
      }
      catch {
        cleanup()
        resolve(new Set())
        return
      }

      timer = setTimeout(() => {
        cleanup()
        remote_resources.clear()
        for (const [tab_id, resources] of collected) {
          remote_resources.set(tab_id, resources)
        }
        resolve(new Set([... collected.values()].flatMap(resources => [... resources])))
      }, settings.app.client.sync.resourceGatherDelayMs)
    })

    return resource_gather_promise
  }

  function update_remote_resources(tab_id: string, resources: string[]) {
    const previous = new Set(collected_resources)
    if (resources.length) {
      remote_resources.set(tab_id, new Set(resources))
    }
    else {
      remote_resources.delete(tab_id)
    }
    collected_resources = new Set([... remote_resources.values()].flatMap(values => [... values]))
    update_mqtt_subscriptions(
      [... collected_resources].filter(resource => ! previous.has(resource) && ! listeners.has(resource)),
      [... previous].filter(resource => ! collected_resources.has(resource) && ! listeners.has(resource)),
    )
  }

  function announce_resources(request_id?: string) {
    get_broadcast_channel()?.postMessage({
      type: 'report_resources',
      request_id,
      tab_id: sync_client_id(),
      resources: [... listeners.keys()],
    })
  }

  let stop_identity_watch: (() => void) | null = null
  let handle_remote_logout = () => {}
  let identity_changed = () => {}

  function refresh_identity() {
    identity_changed()
    notify_all_listeners_refresh()
  }

  function handle_broadcast_message(event: MessageEvent) {
    if (import.meta.server) {
      return
    }

    const data = event.data as BroadcastMessage

    if (data.type === 'login') {
      refresh_identity()
      return
    }

    if (data.type === 'logout') {
      refresh_identity()
      handle_remote_logout()
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
      announce_resources(data.id)
    }

    if (data.type === 'report_resources') {
      update_remote_resources(data.tab_id, data.resources)
      return
    }

    if (data.type === 'release_resources') {
      update_remote_resources(data.tab_id, [])
    }
  }

  function start_cross_tab_transport() {
    const channel = get_broadcast_channel()
    if (! channel) {
      return
    }

    channel.addEventListener('message', handle_broadcast_message)
  }

  function handle_pagehide() {
    suspended = true
    get_broadcast_channel()?.postMessage({ type: 'release_resources', tab_id: sync_client_id() })
    cancel_gather?.()
    close_mqtt()
    broadcast_channel?.close()
    broadcast_channel = null
  }

  function handle_pageshow(event: PageTransitionEvent) {
    if (event.persisted) {
      suspended = false
      start_cross_tab_transport()
      announce_resources()
      handle_visibility_change()
    }
  }

  function start(options: {
    user: Ref<unknown>
    handle_remote_logout: () => void
    identity_changed: () => void
  }) {
    if (import.meta.client && ! started && ! disposed) {
      started = true
      handle_remote_logout = options.handle_remote_logout
      identity_changed = options.identity_changed
      let initial_gather_done = false

      start_cross_tab_transport()

      window.addEventListener('pagehide', handle_pagehide)
      window.addEventListener('pageshow', handle_pageshow)
      // BroadcastChannel still delivers while HTTP is offline. A resumed MQTT
      // session may only replay already-seen IDs, so recover resource reads
      // independently of broker session state, including in background tabs.
      window.addEventListener('online', notify_all_listeners_refresh)

      // Watches the user cookie rather than the auth token: the token cookie is
      // now httpOnly and unreadable here, and login/logout move the user cookie in
      // lockstep, which is all this signal needs.
      stop_identity_watch = watch(options.user, () => {
        refresh_identity()
        if (! initial_gather_done) {
          return
        }
        // Identity changed: every subscription's data may be identity-scoped
        // (permissions, private content), so refresh explicitly — with
        // clean:false the reconnect below no longer implies a full refresh.
        reset_connection()
      }, { flush: 'sync' })

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
  }

  function dispose() {
    if (disposed) {
      return
    }
    disposed = true
    stop_identity_watch?.()
    if (import.meta.client) {
      window.removeEventListener('pagehide', handle_pagehide)
      window.removeEventListener('pageshow', handle_pageshow)
      window.removeEventListener('online', notify_all_listeners_refresh)
      document.removeEventListener('visibilitychange', handle_visibility_change)
      broadcast_channel?.removeEventListener('message', handle_broadcast_message)
      handle_pagehide()
    }
    listeners.clear()
    remote_resources.clear()
    collected_resources.clear()
    seen_ids.clear()
  }

  return {
    start,
    dispose,
    broadcast_login,
    broadcast_logout,
    status: readonly(status),
    subscribe(
      resource: string,
      listener: SyncListener,
    ) {
      const listeners = get_listeners()
      if (disposed) {
        return () => {}
      }
      const is_new_resource = ! listeners.has(resource)

      if (is_new_resource) {
        listeners.set(resource, new Set())
      }

      listeners.get(resource)!.add(listener)

      if (is_new_resource) {
        if (mqtt_client?.connected && ! collected_resources.has(resource)) {
          update_mqtt_subscriptions([resource], [])
        }
        announce_resources()
        void open_mqtt()
      }

      const unsubscribe = () => {
        listeners.get(resource)?.delete(listener)

        if (listeners.get(resource) && ! listeners.get(resource)!.size) {
          listeners.delete(resource)
          if (mqtt_client?.connected && ! collected_resources.has(resource)) {
            update_mqtt_subscriptions([], [resource])
          }
          announce_resources()
        }
      }

      return unsubscribe
    },
  }
}
