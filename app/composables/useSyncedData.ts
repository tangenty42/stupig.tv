interface UseSyncedDataOptions {
  immediate?: boolean
  server?: boolean
  universal?: boolean
  throw_resource_null_error?: boolean
  on_error?: (error: unknown) => void
  polling_interval?: number
}

interface UseSyncedDataProxy<T> {
  value: T | null
  loading: boolean
  // Whether the proxy has completed at least one successful fetch. A proxy
  // created with `immediate: false` holds a meaningless `null` until then,
  // and subscribers must not adopt it as shared state.
  fetched: boolean
  // The in-flight fetch, shared so concurrent subscribers await the same one.
  fetch_task: Promise<void> | null
  updaters: Set<UseSyncedDataUpdater<T>>
  fetch: () => Promise<void>
  drop: (updater: UseSyncedDataUpdater<T>) => void
}

interface UseSyncedDataUpdater<T> {
  set_loading: (value: boolean) => void
  update: (value: T) => void
}

function get_shared_proxies() {
  if (import.meta.server) {
    return new Map<string, UseSyncedDataProxy<unknown>>()
  }
  return useState<Map<string, UseSyncedDataProxy<unknown>>>(
    'synced-data-proxies',
    () => new Map(),
  ).value
}

export async function useSyncedData<T>(
  resource: Ref<string | null>,
  fetcher: () => Promise<T>,
  data: Ref<T | null>,
  loading: Ref<boolean>,
  options?: Readonly<UseSyncedDataOptions>,
): Promise<{
  refresh: () => Promise<void>
}>
export async function useSyncedData<T>(
  resource: Ref<string | null>,
  fetcher: () => Promise<T>,
  options?: Readonly<UseSyncedDataOptions>,
): Promise<{
  refresh: () => Promise<void>
}>

export async function useSyncedData<T>(
  resource: Ref<string | null>,
  fetcher: () => Promise<T>,
  _3?: Ref<T | null> | Readonly<UseSyncedDataOptions>,
  _4?: Ref<boolean>,
  _5?: Readonly<UseSyncedDataOptions>,
) {
  const { error: toast_error } = useMyToast()

  let data: Ref<T | null>
  let loading: Ref<boolean>
  const options: Readonly<UseSyncedDataOptions> = {
    immediate: true,
    server: true,
    universal: true,
    throw_resource_null_error: false,
    on_error: (err: unknown) => {
      toast_error(err)
    },
  }
  if (isRef(_3) && isRef(_4)) {
    data = _3
    loading = _4
    if (_5 !== undefined) {
      Object.assign(options, _5)
    }
  }
  else {
    data = ref(null) as Ref<T | null>
    loading = ref(false)
    if (_3 !== undefined) {
      Object.assign(options, _3 as Readonly<UseSyncedDataOptions>)
    }
  }

  const immediate = options.immediate as boolean
  const server = options.server as boolean
  const universal = options.universal as boolean
  const throw_resource_null_error = options.throw_resource_null_error as boolean
  const polling_interval = options.polling_interval as number | undefined

  const { subscribe } = useDataSync()
  let unsubscribe: (() => void) | null = null
  let last_fetch_at = 0
  let polling_watcher: ReturnType<typeof watch> | null = null

  function handle_error(err: unknown) {
    // 401 = session expired; the fetch layer already cleared the session and
    // redirected. Skip the toast to keep the UI clean.
    if (err instanceof Error && get_error_status(err) === 401) {
      return
    }
    options.on_error?.(err)
  }

  // Re-fetch only when the data has gone quiet: if no fetch (MQTT-driven or
  // poll-driven) happened within polling_interval, fetch proactively. Ordinary
  // data requests do not emit session-list sync events, so without this the
  // session list would not reflect last_seen_at changes on its own.
  function start_polling() {
    if (! polling_interval || import.meta.server) {
      return
    }
    stop_polling()
    const scope = effectScope()
    scope.run(() => {
      polling_watcher = watch(useReactiveDateNow(), () => {
        if (document.visibilityState !== 'visible') {
          return
        }
        if (Date.now() - last_fetch_at < polling_interval) {
          return
        }
        void refresh()
      })
    })
  }

  function stop_polling() {
    if (polling_watcher) {
      polling_watcher()
      polling_watcher = null
    }
  }

  async function refresh() {
    const key = resource.value
    if (! key) {
      return
    }

    if (universal) {
      const shared_proxies = get_shared_proxies()
      const proxy = shared_proxies.get(key) as UseSyncedDataProxy<T> | undefined
      if (proxy) {
        await proxy.fetch()
        return
      }
    }

    loading.value = true
    try {
      data.value = await fetcher()
      last_fetch_at = Date.now()
    }
    catch (error) {
      handle_error(error)
    }
    finally {
      loading.value = false
    }
  }

  async function start_subscription() {
    unsubscribe?.()
    unsubscribe = null

    const key = resource.value
    if (! key) {
      if (throw_resource_null_error) {
        handle_error(new Error('？！空空！？'))
      }
      return
    }

    if (universal) {
      const updater: UseSyncedDataUpdater<T> = {
        set_loading: (value: boolean) => {
          loading.value = value
        },
        update: (value: T) => {
          data.value = value
        },
      }

      const shared_proxies = get_shared_proxies()
      let proxy = shared_proxies.get(key) as UseSyncedDataProxy<T> | undefined

      if (! proxy) {
        let default_unsubscribe: () => void = () => {}
        proxy = {
          value: null,
          loading: false,
          fetched: false,
          fetch_task: null,
          updaters: new Set(),
          fetch: () => {
            if (proxy !.fetch_task) {
              return proxy !.fetch_task
            }
            proxy !.loading = true
            for (const u of proxy !.updaters) {
              u.set_loading(true)
            }
            const task = (async () => {
              try {
                const value = await fetcher()
                proxy !.value = value
                proxy !.fetched = true
                last_fetch_at = Date.now()
                for (const u of proxy !.updaters) {
                  u.update(value)
                }
              }
              catch (error) {
                handle_error(error)
              }
              finally {
                proxy !.loading = false
                proxy !.fetch_task = null
                for (const u of proxy !.updaters) {
                  u.set_loading(false)
                }
              }
            })()
            proxy !.fetch_task = task
            return task
          },
          drop: (updater) => {
            proxy !.updaters.delete(updater)
            if (proxy !.updaters.size === 0) {
              default_unsubscribe()
              shared_proxies.delete(key)
            }
          },
        }

        default_unsubscribe = subscribe(key, proxy.fetch)
        shared_proxies.set(key, proxy as UseSyncedDataProxy<unknown>)

        proxy.updaters.add(updater)
        unsubscribe = () => proxy !.drop(updater)

        if (immediate) {
          await proxy.fetch()
        }
        start_polling()
      }
      else {
        proxy.updaters.add(updater)
        unsubscribe = () => proxy !.drop(updater)
        if (proxy.fetched) {
          // Sync the latest shared state into this instance immediately.
          loading.value = proxy.loading
          data.value = proxy.value
        }
        else if (immediate) {
          // The shared proxy has no data yet (it was created with
          // `immediate: false`, or its first fetch is still in flight).
          // Wait for the fetch instead of adopting its initial null, which
          // would clobber data this subscriber may already hold and cause
          // SSR/client hydration mismatches.
          await proxy.fetch()
        }
      }
    }
    else {
      const default_unsubscribe = subscribe(key, refresh)
      unsubscribe = () => {
        default_unsubscribe()
      }

      if (immediate) {
        await refresh()
      }
      start_polling()
    }
  }

  if (import.meta.server) {
    if (server && immediate) {
      await start_subscription()
    }
  }
  else {
    // must register lifecycle hooks before the first await statement
    onUnmounted(() => {
      stop_polling()
      unsubscribe?.()
      unsubscribe = null
    })

    await start_subscription()
  }

  watch(resource, async (new_key, old_key) => {
    if (new_key === old_key) {
      return
    }
    if (import.meta.client) {
      await start_subscription()
    }
  }, { flush: 'sync' })

  return {
    refresh,
  }
}
