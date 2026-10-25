import type { Query, QueryFailure } from '~/utils/sync/query'
import { call_query_subscriber, QueryClient } from '~/utils/sync/query'
import { is_synced_state } from './useSyncedState'

type SyncedResource = string | null | Ref<string | null>
type SyncedResources = SyncedResource | readonly SyncedResource[] | Ref<readonly SyncedResource[]>

interface UseSyncedDataOptions<T = unknown> {
  /** Fetch on setup/resource changes unless shared data already exists. Default: true. */
  immediate?: boolean
  /** Allow the initial fetch during SSR; requires immediate. Default: true. */
  server?: boolean
  /** Share client requests/cache by query key, not across SSR requests. Default: true. */
  universal?: boolean
  /** Fetch even without a query key; requires universal: false. Default: false. */
  fetch_without_resource?: boolean
  /** Ignore superseded independent refreshes. Disposal and invalidation always discard stale results. Default: true. */
  ignore_stale_responses?: boolean
  /** Report an inactive/null key through on_error (or toast), not by throwing. Default: false. */
  throw_resource_null_error?: boolean
  /** Handle fetch failures instead of the default toast; 401 is suppressed. */
  on_error?: (error: unknown) => void
  /** Quiet time in milliseconds after request completion before polling; visible tabs only. Disabled by default. */
  polling_interval?: number
  /** Called after data is applied, including shared cached data; deferred during hydration for synced state. */
  on_data?: (value: T | null) => void
  /** Override query identity with a literal or ref, not event subscriptions. Defaults to the normalized resource set; null disables unless fetch_without_resource. */
  query_key?: SyncedResource
}

const query_clients = new WeakMap<object, QueryClient>()

export function invalidate_unsignalled_queries(app: object) {
  query_clients.get(app)?.invalidate_without_subscription()
}

export async function useSyncedData<T>(
  resource: SyncedResources,
  fetcher: () => Promise<T>,
  data: Ref<T | null>,
  loading: Ref<boolean>,
  options?: Readonly<UseSyncedDataOptions<T>>,
): Promise<{
  refresh: () => Promise<void>
}>
export async function useSyncedData<T>(
  resource: SyncedResources,
  fetcher: () => Promise<T>,
  data: Ref<T | null>,
  options?: Readonly<UseSyncedDataOptions<T>>,
): Promise<{
  refresh: () => Promise<void>
}>
export async function useSyncedData<T>(
  resource: SyncedResources,
  fetcher: () => Promise<T>,
  options?: Readonly<UseSyncedDataOptions<T>>,
): Promise<{
  refresh: () => Promise<void>
}>

export async function useSyncedData<T>(
  resource: SyncedResources,
  fetcher: () => Promise<T>,
  _3?: Ref<T | null> | Readonly<UseSyncedDataOptions<T>>,
  _4?: Ref<boolean> | Readonly<UseSyncedDataOptions<T>>,
  _5?: Readonly<UseSyncedDataOptions<T>>,
) {
  const { error: toast_error } = useMyToast()

  let data: Ref<T | null>
  let loading: Ref<boolean>
  const options: Readonly<UseSyncedDataOptions<T>> = {
    immediate: true,
    server: true,
    universal: true,
    fetch_without_resource: false,
    ignore_stale_responses: true,
    throw_resource_null_error: false,
  }
  if (isRef(_3)) {
    data = _3
    if (isRef(_4)) {
      loading = _4
      if (_5 !== undefined) {
        Object.assign(options, _5)
      }
    }
    else {
      loading = ref(false)
      if (_4 !== undefined) {
        Object.assign(options, _4 as Readonly<UseSyncedDataOptions<T>>)
      }
    }
  }
  else {
    data = ref(null) as Ref<T | null>
    loading = ref(false)
    if (_3 !== undefined) {
      Object.assign(options, _3 as Readonly<UseSyncedDataOptions<T>>)
    }
  }

  const immediate = options.immediate as boolean
  const server = options.server as boolean
  const universal = options.universal as boolean
  const fetch_without_resource = options.fetch_without_resource as boolean
  const ignore_stale_responses = options.ignore_stale_responses as boolean
  const throw_resource_null_error = options.throw_resource_null_error as boolean
  const polling_interval = options.polling_interval as number | undefined
  if (fetch_without_resource && universal) {
    throw new Error('fetch_without_resource requires universal: false')
  }
  const nuxt_app = useNuxtApp()
  const has_data_ref = isRef(_3)
  let stage_hydration_updates = import.meta.client
    && nuxt_app.isHydrating
    && (! has_data_ref || is_synced_state(data))
  let has_deferred_data = false
  let deferred_data: T | null = null
  let deferred_loading: boolean | undefined
  let has_deferred_error = false
  let deferred_error: QueryFailure | undefined
  let disposed = false

  function apply_data(value: T | null) {
    data.value = value
    call_query_subscriber(() => options.on_data?.(value))
  }

  function apply_error(failure: QueryFailure) {
    if (options.on_error) {
      call_query_subscriber(() => options.on_error?.(failure.error))
    }
    else if (! failure.notified) {
      failure.notified = true
      call_query_subscriber(() => toast_error(failure.error))
    }
  }

  function flush_hydration_updates() {
    if (disposed || ! stage_hydration_updates) {
      return
    }
    stage_hydration_updates = false
    if (has_deferred_data) {
      apply_data(deferred_data)
    }
    if (deferred_loading !== undefined) {
      loading.value = deferred_loading
    }
    if (has_deferred_error && deferred_error) {
      apply_error(deferred_error)
    }
  }

  function update_data(value: T | null) {
    if (! nuxt_app.isHydrating) {
      flush_hydration_updates()
    }
    if (stage_hydration_updates) {
      has_deferred_data = true
      deferred_data = value
    }
    else {
      apply_data(value)
    }
  }

  function update_loading(value: boolean) {
    if (! nuxt_app.isHydrating) {
      flush_hydration_updates()
    }
    if (stage_hydration_updates) {
      deferred_loading = value
    }
    else {
      loading.value = value
    }
  }

  const remove_hooks: Array<() => void> = []
  if (stage_hydration_updates) {
    remove_hooks.push(nuxt_app.hook('app:suspense:resolve', flush_hydration_updates))
    remove_hooks.push(nuxt_app.hook('app:mounted', () => {
      if (! nuxt_app.isHydrating) {
        flush_hydration_updates()
      }
    }))
  }

  const { subscribe } = useDataSync()
  let client = query_clients.get(nuxt_app)
  if (! client) {
    client = new QueryClient({
      subscribe: (resource, invalidate) => subscribe(resource, () => invalidate()),
      now: () => Date.now(),
      visible: () => import.meta.client && document.visibilityState === 'visible',
      start_polling: (tick) => {
        if (import.meta.server) {
          return () => {}
        }
        const scope = effectScope(true)
        scope.run(() => watch(useReactiveDateNow(), tick))
        return () => scope.stop()
      },
    })
    query_clients.set(nuxt_app, client)
    const owned_client = client
    nuxt_app.vueApp?.onUnmount(() => owned_client.dispose())
  }
  let query: Query<T> | null = null
  let unsubscribe: (() => void) | null = null

  function handle_error(failure: QueryFailure) {
    const err = failure.error
    if (err instanceof Error && get_error_status(err) === 401) {
      return
    }
    if (! nuxt_app.isHydrating) {
      flush_hydration_updates()
    }
    if (stage_hydration_updates) {
      has_deferred_error = true
      deferred_error = failure
      return
    }
    apply_error(failure)
  }

  async function refresh() {
    await query?.refresh()
  }

  function clear_deferred_updates() {
    has_deferred_data = false
    deferred_loading = undefined
    has_deferred_error = false
    deferred_error = undefined
  }

  function resolve_resources() {
    const value = isRef(resource) ? resource.value : resource
    const values = Array.isArray(value) ? value : [value]
    const resources = values.map(item => isRef(item) ? item.value : item)
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
    return [... new Set(resources)].sort()
  }

  function resolve_key(resources: readonly string[]) {
    if (options.query_key !== undefined) {
      return isRef(options.query_key) ? options.query_key.value : options.query_key
    }
    if (resources.length === 0) {
      return null
    }
    return resources.length === 1 ? resources[0]! : JSON.stringify(resources)
  }

  async function start_subscription() {
    clear_deferred_updates()
    unsubscribe?.()
    unsubscribe = null
    query = null
    if (disposed) {
      return
    }
    const resources = resolve_resources()
    const key = resolve_key(resources)
    if (! key && ! fetch_without_resource) {
      update_loading(false)
      if (throw_resource_null_error) {
        handle_error({ error: new Error('？！空空！？'), notified: false })
      }
      return
    }
    query = client!.acquire<T>(universal && import.meta.client ? key : null)
    const had_data = query.has_data()
    unsubscribe = query.add({
      fetcher,
      data: update_data,
      loading: update_loading,
      error: handle_error,
      invalidate: clear_deferred_updates,
      resources,
      polling_interval,
      ignore_stale_responses,
    })
    if (immediate && ! had_data) {
      const task = query.refresh()
      if (! stage_hydration_updates) {
        await task
      }
    }
  }

  const stop_watch = import.meta.client
    ? watch(() => {
        const resources = resolve_resources()
        return JSON.stringify([resources, resolve_key(resources)])
      }, () => {
        void start_subscription()
      }, { flush: 'sync' })
    : () => {}
  if (import.meta.client) {
    onUnmounted(() => {
      disposed = true
      stop_watch()
      unsubscribe?.()
      unsubscribe = null
      query = null
      has_deferred_data = false
      has_deferred_error = false
      for (const remove_hook of remove_hooks) {
        remove_hook?.()
      }
    })
  }
  if (import.meta.client || (server && immediate)) {
    await start_subscription()
  }

  return {
    refresh,
  }
}
