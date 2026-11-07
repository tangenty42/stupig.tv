export interface QueryFailure {
  error: unknown
  notified: boolean
}

export type QueryRefreshPolicy = 'join' | 'latest'

export interface QuerySubscriber<T> {
  fetcher: () => Promise<T>
  data: (value: T) => void
  loading: (value: boolean) => void
  error: (failure: QueryFailure) => void
  invalidate?: () => void
  polling_interval?: number
  resources: readonly string[]
}

interface QueryEnvironment {
  subscribe: (resource: string, invalidate: () => Promise<void>) => () => void
  now: () => number
  start_polling: (tick: () => void) => () => void
  visible: () => boolean
}

export function call_query_subscriber(callback: () => unknown) {
  try {
    void Promise.resolve(callback()).catch(error => console.error('[Query] subscriber failed', error))
  }
  catch (error) {
    console.error('[Query] subscriber failed', error)
  }
}

export class Query<T> {
  private subscribers = new Set<QuerySubscriber<T>>()
  private subscriptions = new Map<string, () => void>()
  private task: Promise<void> | null = null
  private pending = new Set<Promise<void>>()
  private version = 0
  private epoch = 0
  private dirty = false
  private disposed = false
  private last_completion = 0
  private stop_polling: (() => void) | null = null
  private fetched = false
  private value!: T

  constructor(
    private environment: QueryEnvironment,
    readonly refresh_policy: QueryRefreshPolicy,
    private on_empty: () => void,
  ) {}

  add(subscriber: QuerySubscriber<T>) {
    this.subscribers.add(subscriber)
    this.sync_subscriptions()
    this.sync_polling()
    call_query_subscriber(() => subscriber.loading(this.pending.size > 0))
    if (this.fetched) {
      call_query_subscriber(() => subscriber.data(this.value))
    }
    let dropped = false
    return () => {
      if (dropped) {
        return
      }
      dropped = true
      this.subscribers.delete(subscriber)
      if (! this.subscribers.size) {
        this.dispose()
        this.on_empty()
      }
      else {
        this.sync_subscriptions()
        this.sync_polling()
      }
    }
  }

  /** Change which notifications reach this subscriber without replacing the query or its data. */
  set_resources(subscriber: QuerySubscriber<T>, resources: readonly string[]) {
    if (this.disposed || ! this.subscribers.has(subscriber)) {
      return
    }
    subscriber.resources = resources
    this.sync_subscriptions()
  }

  has_data() {
    return this.fetched
  }

  has_sync_resources() {
    return this.subscriptions.size > 0
  }

  private sync_subscriptions() {
    const resources = new Set([... this.subscribers].flatMap(subscriber => [... subscriber.resources]))
    for (const [resource, unsubscribe] of this.subscriptions) {
      if (! resources.has(resource)) {
        unsubscribe()
        this.subscriptions.delete(resource)
      }
    }
    for (const resource of resources) {
      if (! this.subscriptions.has(resource)) {
        this.subscriptions.set(resource, this.environment.subscribe(resource, () => this.invalidate()))
      }
    }
  }

  private sync_polling() {
    const polling = [... this.subscribers].some(subscriber => (subscriber.polling_interval ?? 0) > 0)
    if (polling && ! this.stop_polling) {
      this.stop_polling = this.environment.start_polling(() => this.tick())
    }
    else if (! polling) {
      this.stop_polling?.()
      this.stop_polling = null
    }
  }

  private tick() {
    if (this.disposed || this.pending.size || ! this.environment.visible()) {
      return
    }
    const intervals = [... this.subscribers]
      .map(subscriber => subscriber.polling_interval ?? 0)
      .filter(interval => interval > 0)
    if (intervals.length && this.environment.now() - this.last_completion >= Math.min(... intervals)) {
      void this.refresh()
    }
  }

  invalidate() {
    this.epoch ++
    this.fetched = false
    for (const subscriber of this.subscribers) {
      call_query_subscriber(() => subscriber.invalidate?.())
    }
    if (this.pending.size) {
      this.dirty = true
      return this.task ?? Promise.all(this.pending).then(() => {})
    }
    return this.refresh()
  }

  refresh(policy = this.refresh_policy): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    if (policy === 'join' && this.task) {
      return this.task
    }
    const provider = this.subscribers.values().next().value
    if (! provider) {
      return Promise.resolve()
    }
    const version = ++ this.version
    const epoch = this.epoch
    const current = () => ! this.disposed
      && version === this.version
      && epoch === this.epoch
    for (const subscriber of this.subscribers) {
      call_query_subscriber(() => subscriber.invalidate?.())
      call_query_subscriber(() => subscriber.loading(true))
    }
    let response: Promise<T>
    try {
      response = provider.fetcher()
    }
    catch (error) {
      response = Promise.reject(error)
    }
    const task = response.then((value) => {
      if (! current()) {
        return
      }
      if (! this.subscribers.has(provider)) {
        this.dirty = true
        return
      }
      this.value = value
      this.fetched = true
      for (const subscriber of this.subscribers) {
        if (current()) {
          call_query_subscriber(() => subscriber.data(value))
        }
      }
    }, (error: unknown) => {
      if (! current()) {
        return
      }
      if (! this.subscribers.has(provider)) {
        this.dirty = true
        return
      }
      const failure: QueryFailure = { error, notified: false }
      for (const subscriber of this.subscribers) {
        if (current()) {
          call_query_subscriber(() => subscriber.error(failure))
        }
      }
    }).finally(async () => {
      this.pending.delete(task)
      if (this.task === task) {
        this.task = null
      }
      if (this.disposed) {
        return
      }
      this.last_completion = this.environment.now()
      if (version === this.version) {
        for (const subscriber of this.subscribers) {
          call_query_subscriber(() => subscriber.loading(false))
        }
      }
      if (this.dirty && ! this.pending.size) {
        this.dirty = false
        await this.refresh()
      }
    })
    this.pending.add(task)
    this.task = task
    return task
  }

  dispose() {
    this.disposed = true
    this.epoch ++
    this.dirty = false
    this.subscribers.clear()
    for (const unsubscribe of this.subscriptions.values()) {
      unsubscribe()
    }
    this.subscriptions.clear()
    this.stop_polling?.()
    this.stop_polling = null
  }
}

export class QueryClient {
  private queries = new Set<Query<unknown>>()
  private shared = new Map<string, Query<unknown>>()

  constructor(private environment: QueryEnvironment) {}

  acquire<T>(key: string | null, refresh_policy: QueryRefreshPolicy = 'join') {
    const existing = key === null ? undefined : this.shared.get(key)
    if (existing) {
      if (existing.refresh_policy !== refresh_policy) {
        throw new Error('Subscribers to the same query must use the same refresh_policy')
      }
      return existing as Query<T>
    }
    const query = new Query<T>(this.environment, refresh_policy, () => {
      this.queries.delete(query as Query<unknown>)
      if (key !== null) {
        this.shared.delete(key)
      }
    })
    this.queries.add(query as Query<unknown>)
    if (key !== null) {
      this.shared.set(key, query as Query<unknown>)
    }
    return query
  }

  invalidate_all() {
    for (const query of this.queries) {
      void query.invalidate()
    }
  }

  invalidate_without_subscription() {
    for (const query of this.queries) {
      if (! query.has_sync_resources()) {
        void query.invalidate()
      }
    }
  }

  dispose() {
    for (const query of this.queries) {
      query.dispose()
    }
    this.queries.clear()
    this.shared.clear()
  }
}
