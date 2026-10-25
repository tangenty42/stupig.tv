import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, isRef, ref, watch } from 'vue'
import { useSyncedState } from './useSyncedState'

describe('useSyncedData hydration updates', () => {
  it('refreshes upload membership on mutation and reconnect sync', async () => {
    vi.stubGlobal('useNuxtApp', () => ({ isHydrating: false, hook: vi.fn() }))
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    let listener: ((event?: { type: string, sync_all?: boolean }) => Promise<void> | void) | undefined
    vi.stubGlobal('useDataSync', () => ({
      subscribe: (_resource: string, callback: typeof listener) => {
        listener = callback
        return () => {}
      },
    }))
    const { useSyncedData } = await import('./useSyncedData')
    const fetcher = vi.fn(async () => ['upload-1'])
    const data = ref<string[] | null>(null)
    await useSyncedData('content_uploads:42', fetcher, data)

    expect(fetcher).toHaveBeenCalledOnce()
    await listener!({ type: 'refresh' })
    await listener!({ type: 'sync', sync_all: true })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(data.value).toEqual(['upload-1'])
  })

  it('refreshes one cooldown query for phone and identity events and switches phone subscriptions', async () => {
    const app = { isHydrating: false, hook: vi.fn() }
    vi.stubGlobal('useNuxtApp', () => app)
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    const listeners = new Map<string, () => Promise<void>>()
    vi.stubGlobal('useDataSync', () => ({
      subscribe: (resource: string, invalidate: () => Promise<void>) => {
        listeners.set(resource, invalidate)
        return () => {
          listeners.delete(resource)
        }
      },
    }))
    const { useSyncedData } = await import('./useSyncedData')
    const phone_resource = ref<string | null>('otp_cooldown:phone-A')
    const identity_resource = ref<string | null>('otp_cooldown_by_identity:device')
    const fetcher = vi.fn(async () => phone_resource.value)
    const data = ref<string | null>(null)
    const loading = ref(false)
    await useSyncedData([phone_resource, identity_resource], fetcher, data, loading)
    expect(fetcher).toHaveBeenCalledOnce()
    await listeners.get('otp_cooldown:phone-A')!()
    await listeners.get('otp_cooldown_by_identity:device')!()
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(data.value).toBe('otp_cooldown:phone-A')
    phone_resource.value = 'otp_cooldown:phone-B'
    await listeners.get('otp_cooldown_by_identity:device')!()
    expect(listeners.has('otp_cooldown:phone-A')).toBe(false)
    expect(listeners.has('otp_cooldown:phone-B')).toBe(true)
    expect(data.value).toBe('otp_cooldown:phone-B')
    expect(loading.value).toBe(false)
    phone_resource.value = null
    identity_resource.value = null
    expect(listeners.size).toBe(0)
  })

  it('accepts literal resources and subscribes to every unique resource', async () => {
    vi.stubGlobal('useNuxtApp', () => ({ isHydrating: false, hook: vi.fn() }))
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    const subscribe = vi.fn((_resource: string, _invalidate: () => Promise<void>) => () => {})
    vi.stubGlobal('useDataSync', () => ({ subscribe }))
    const { useSyncedData } = await import('./useSyncedData')
    const data = ref<string | null>(null)
    await useSyncedData(['profile:1', 'profile_sessions:1', 'profile:1', null], async () => 'overview', data)
    expect(data.value).toBe('overview')
    expect(subscribe.mock.calls.map(call => call[0])).toEqual(['profile:1', 'profile_sessions:1'])
    await useSyncedData('literal:1', async () => 'single', data)
    expect(data.value).toBe('single')
  })

  it('shares equivalent resource sets but not different resource sets', async () => {
    const app = { isHydrating: false, hook: vi.fn() }
    vi.stubGlobal('useNuxtApp', () => app)
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({ subscribe: vi.fn(() => () => {}) }))
    const { useSyncedData } = await import('./useSyncedData')
    const fetcher = vi.fn(async () => 'shared')
    await useSyncedData(['A', 'B'], fetcher)
    const data = ref<string | null>(null)
    await useSyncedData(['B', 'A', 'A'], fetcher, data)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(data.value).toBe('shared')
    await useSyncedData(['A', 'C'], fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('tracks refs inside arrays and mutations of a resource array ref', async () => {
    const app = { isHydrating: false, hook: vi.fn() }
    vi.stubGlobal('useNuxtApp', () => app)
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((_resource: string, _invalidate: () => Promise<void>) => unsubscribe)
    vi.stubGlobal('useDataSync', () => ({ subscribe }))
    const { useSyncedData } = await import('./useSyncedData')
    const dynamic = ref<string | null>('B')
    await useSyncedData(['A', dynamic], async () => 'data', { immediate: false })
    dynamic.value = 'C'
    expect(unsubscribe).toHaveBeenCalledTimes(2)
    expect(subscribe.mock.calls.map(call => call[0])).toEqual(['A', 'B', 'A', 'C'])
    const resources = ref(['D'])
    await useSyncedData(resources, async () => 'data', { immediate: false })
    resources.value.push('E')
    expect(subscribe.mock.calls.map(call => call[0]).slice(- 2)).toEqual(['D', 'E'])
  })

  it('accepts an empty literal list with an explicit query key or unkeyed fetch mode', async () => {
    vi.stubGlobal('useNuxtApp', () => ({ isHydrating: false, hook: vi.fn() }))
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    const subscribe = vi.fn(() => () => {})
    vi.stubGlobal('useDataSync', () => ({ subscribe }))
    const { useSyncedData } = await import('./useSyncedData')
    const fetcher = vi.fn(async () => 'data')
    await useSyncedData([], fetcher)
    expect(fetcher).not.toHaveBeenCalled()
    await useSyncedData([], fetcher, { query_key: 'standalone' })
    await useSyncedData(null, fetcher, { universal: false, fetch_without_resource: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('shares literal and ref query keys, tracks key changes and respects explicit null', async () => {
    const app = { isHydrating: false, hook: vi.fn() }
    vi.stubGlobal('useNuxtApp', () => app)
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    const subscribe = vi.fn((_resource: string, _invalidate: () => Promise<void>) => () => {})
    vi.stubGlobal('useDataSync', () => ({ subscribe }))
    const { useSyncedData } = await import('./useSyncedData')
    const fetcher = vi.fn(async () => 'data')
    await useSyncedData('A', fetcher, { query_key: 'shared' })
    const data = ref<string | null>(null)
    const query_key = ref<string | null>('shared')
    const { refresh } = await useSyncedData('B', fetcher, data, { query_key })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(data.value).toBe('data')
    expect(subscribe.mock.calls.map(call => call[0])).toEqual(['A', 'B'])
    query_key.value = 'other'
    await refresh()
    expect(fetcher).toHaveBeenCalledTimes(2)
    query_key.value = null
    await refresh()
    await useSyncedData('C', fetcher, { query_key: null })
    await useSyncedData('D', fetcher, { query_key: '' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(subscribe.mock.calls.map(call => call[0])).toEqual(['A', 'B', 'B'])
  })

  beforeEach(() => {
    vi.stubGlobal('effectScope', effectScope)
    vi.stubGlobal('isRef', isRef)
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('onUnmounted', () => {})
    vi.stubGlobal('get_error_status', () => undefined)
    vi.stubGlobal('useState', (_key: string, init: () => unknown) => {
      return ref(init())
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts the initial fetch but applies its data only after hydration resolves', async () => {
    const hooks = new Map<string, () => void>()
    const nuxt_app = {
      isHydrating: true,
      hook: (name: string, callback: () => void) => {
        hooks.set(name, callback)
      },
    }
    const subscribe = vi.fn(() => () => {})
    vi.stubGlobal('useNuxtApp', () => nuxt_app)
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({ subscribe }))

    const { useSyncedData } = await import('./useSyncedData')
    const resource = ref('profile:1')
    const data = useSyncedState('profile:1:data', () => 'ssr snapshot')
    const on_data = vi.fn()
    let resolve_fetch!: (value: string) => void
    const fetcher = vi.fn(() => new Promise<string>((resolve) => {
      resolve_fetch = resolve
    }))

    await useSyncedData(resource, fetcher, data, { on_data })

    expect(fetcher).toHaveBeenCalledOnce()
    expect(data.value).toBe('ssr snapshot')
    expect(on_data).not.toHaveBeenCalled()

    resolve_fetch('client response')
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(data.value).toBe('ssr snapshot')
    expect(on_data).not.toHaveBeenCalled()

    hooks.get('app:mounted')!()
    expect(data.value).toBe('ssr snapshot')
    expect(on_data).not.toHaveBeenCalled()

    nuxt_app.isHydrating = false
    hooks.get('app:suspense:resolve')!()

    expect(data.value).toBe('client response')
    expect(on_data).toHaveBeenCalledWith('client response')
  })

  it('applies a staged profile response when hydration ends before the mounted callback runs', async () => {
    let mounted_hook: (() => void) | undefined
    const nuxt_app = {
      isHydrating: true,
      hook: (_name: string, callback: () => void) => {
        mounted_hook = callback
      },
    }
    vi.stubGlobal('useNuxtApp', () => nuxt_app)
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({ subscribe: vi.fn(() => () => {}) }))

    const { useSyncedData } = await import('./useSyncedData')
    const data = useSyncedState('profile:mounted-late', () => ({ is_online: false }))
    let resolve_fetch!: (value: { is_online: boolean }) => void
    await useSyncedData(ref('profile:mounted-late'), () => new Promise((resolve) => {
      resolve_fetch = resolve
    }), data)

    nuxt_app.isHydrating = false
    resolve_fetch({ is_online: true })
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(data.value.is_online).toBe(true)
    mounted_hook?.()
  })

  it('flushes a profile response buffered before suspense resolves without waiting for mounted', async () => {
    const hooks = new Map<string, () => void>()
    const nuxt_app = {
      isHydrating: true,
      hook: (name: string, callback: () => void) => {
        hooks.set(name, callback)
      },
    }
    vi.stubGlobal('useNuxtApp', () => nuxt_app)
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({ subscribe: vi.fn(() => () => {}) }))

    const { useSyncedData } = await import('./useSyncedData')
    const data = useSyncedState('profile:early-response', () => ({ is_online: false }))
    const on_data = vi.fn()
    await useSyncedData(ref('profile:early-response'), async () => ({ is_online: true }), data, { on_data })
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(data.value.is_online).toBe(false)
    nuxt_app.isHydrating = false
    hooks.get('app:suspense:resolve')!()

    expect(data.value.is_online).toBe(true)
    expect(on_data).toHaveBeenCalledOnce()
    hooks.get('app:mounted')?.()
    expect(on_data).toHaveBeenCalledOnce()
  })

  it('defers initial fetch errors until hydration resolves', async () => {
    const hooks = new Map<string, () => void>()
    const nuxt_app = {
      isHydrating: true,
      hook: (name: string, callback: () => void) => {
        hooks.set(name, callback)
      },
    }
    const on_error = vi.fn()
    vi.stubGlobal('useNuxtApp', () => nuxt_app)
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({ subscribe: vi.fn(() => () => {}) }))

    const { useSyncedData } = await import('./useSyncedData')
    const data = useSyncedState('profile:1:error-data', () => 'ssr snapshot')
    const failure = new Error('temporary fetch failure')

    await useSyncedData(ref('profile:1'), async () => {
      throw failure
    }, data, { on_error })
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(data.value).toBe('ssr snapshot')
    expect(on_error).not.toHaveBeenCalled()

    hooks.get('app:mounted')!()
    expect(on_error).not.toHaveBeenCalled()
    nuxt_app.isHydrating = false
    hooks.get('app:suspense:resolve')!()

    expect(on_error).toHaveBeenCalledWith(failure)
  })

  it('does not defer a plain ref', async () => {
    const nuxt_app = {
      isHydrating: true,
      hook: vi.fn(),
    }
    const subscribe = vi.fn(() => () => {})
    vi.stubGlobal('useNuxtApp', () => nuxt_app)
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({ subscribe }))

    const { useSyncedData } = await import('./useSyncedData')
    const resource = ref('ordinary:1')
    const data = ref('empty')
    const fetcher = vi.fn(async () => 'client response')

    await useSyncedData(resource, fetcher, data, ref(false))

    expect(fetcher).toHaveBeenCalledOnce()
    expect(data.value).toBe('client response')
    expect(nuxt_app.hook).not.toHaveBeenCalled()
  })

  it('keeps the newest non-universal refresh when responses arrive out of order', async () => {
    vi.stubGlobal('useNuxtApp', () => ({ isHydrating: false, hook: vi.fn() }))
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({ subscribe: vi.fn(() => () => {}) }))

    const { useSyncedData } = await import('./useSyncedData')
    const data = ref<string | null>('initial')
    const loading = ref(false)
    const pending: Array<(value: string) => void> = []
    const fetcher = () => new Promise<string>((resolve) => {
      pending.push(resolve)
    })
    const { refresh } = await useSyncedData(ref('users:1'), fetcher, data, loading, {
      immediate: false,
      universal: false,
    })

    const first = refresh()
    const second = refresh()
    pending[1]!('newer')
    await second
    pending[0]!('older')
    await first

    expect(data.value).toBe('newer')
    expect(loading.value).toBe(false)
  })

  it('ignores an old response after the resource changes', async () => {
    vi.stubGlobal('useNuxtApp', () => ({ isHydrating: false, hook: vi.fn() }))
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({ subscribe: vi.fn(() => () => {}) }))

    const { useSyncedData } = await import('./useSyncedData')
    const resource = ref('users:1')
    const data = ref<string | null>('initial')
    const pending: Array<(value: string) => void> = []
    const { refresh } = await useSyncedData(resource, () => new Promise<string>((resolve) => {
      pending.push(resolve)
    }), data, { immediate: false, universal: false })

    const old_request = refresh()
    resource.value = 'users:2'
    pending[0]!('old page')
    await old_request

    expect(data.value).toBe('initial')
    const new_request = refresh()
    pending[1]!('new page')
    await new_request
    expect(data.value).toBe('new page')
  })

  it('does not flush a buffered response for a resource that changed during hydration', async () => {
    const hooks = new Map<string, () => void>()
    const nuxt_app = {
      isHydrating: true,
      hook: (name: string, callback: () => void) => {
        hooks.set(name, callback)
      },
    }
    vi.stubGlobal('useNuxtApp', () => nuxt_app)
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({ subscribe: vi.fn(() => () => {}) }))

    const { useSyncedData } = await import('./useSyncedData')
    const resource = ref<string | null>('users:1')
    const data = useSyncedState('users:stale-hydration', () => 'ssr snapshot')
    const on_data = vi.fn()
    await useSyncedData(resource, async () => 'old page', data, {
      universal: false,
      on_data,
    })
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    resource.value = null
    nuxt_app.isHydrating = false
    hooks.get('app:suspense:resolve')!()

    expect(data.value).toBe('ssr snapshot')
    expect(on_data).not.toHaveBeenCalled()
  })

  it('ignores stale failures without ending the latest request loading state', async () => {
    vi.stubGlobal('useNuxtApp', () => ({ isHydrating: false, hook: vi.fn() }))
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({ subscribe: vi.fn(() => () => {}) }))

    const { useSyncedData } = await import('./useSyncedData')
    const data = ref<string | null>(null)
    const loading = ref(false)
    const on_error = vi.fn()
    const pending: Array<{ resolve: (value: string) => void, reject: (error: Error) => void }> = []
    const { refresh } = await useSyncedData(ref('users:1'), () => new Promise<string>((resolve, reject) => {
      pending.push({ resolve, reject })
    }), data, loading, { immediate: false, universal: false, on_error })

    const first = refresh()
    const second = refresh()
    pending[0]!.reject(new Error('old request failed'))
    await first
    expect(on_error).not.toHaveBeenCalled()
    expect(loading.value).toBe(true)

    pending[1]!.resolve('latest')
    await second
    expect(data.value).toBe('latest')
    expect(loading.value).toBe(false)
  })

  it('does not report a shared fetch failure after its subscriber changes resource', async () => {
    vi.stubGlobal('useNuxtApp', () => ({ isHydrating: false, hook: vi.fn() }))
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({ subscribe: vi.fn(() => () => {}) }))

    const { useSyncedData } = await import('./useSyncedData')
    const resource = ref<string | null>('users:1')
    const on_error = vi.fn()
    let reject_fetch!: (error: Error) => void
    const { refresh } = await useSyncedData(resource, () => new Promise<string>((_resolve, reject) => {
      reject_fetch = reject
    }), { immediate: false, on_error })

    const old_request = refresh()
    resource.value = null
    reject_fetch(new Error('old resource failed'))
    await old_request

    expect(on_error).not.toHaveBeenCalled()
  })

  it('hands shared requests and errors to remaining subscribers when the creator leaves', async () => {
    const nuxt_app = { isHydrating: false, hook: vi.fn() }
    vi.stubGlobal('useNuxtApp', () => nuxt_app)
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({ subscribe: vi.fn(() => () => {}) }))
    const { useSyncedData } = await import('./useSyncedData')
    const first_resource = ref<string | null>('shared:handover')
    const first_fetcher = vi.fn(async () => 'creator')
    const second_fetcher = vi.fn(async () => {
      throw new Error('remaining subscriber failure')
    })
    const first_error = vi.fn()
    const second_error = vi.fn()
    await useSyncedData(first_resource, first_fetcher, {
      immediate: false,
      on_error: first_error,
    })
    const { refresh } = await useSyncedData(ref('shared:handover'), second_fetcher, {
      immediate: false,
      on_error: second_error,
    })
    first_resource.value = null
    await refresh()
    expect(first_fetcher).not.toHaveBeenCalled()
    expect(second_fetcher).toHaveBeenCalledOnce()
    expect(first_error).not.toHaveBeenCalled()
    expect(second_error).toHaveBeenCalledOnce()
  })

  it('notifies every custom shared error handler but shows only one default toast', async () => {
    const nuxt_app = { isHydrating: false, hook: vi.fn() }
    const toast = vi.fn()
    vi.stubGlobal('useNuxtApp', () => nuxt_app)
    vi.stubGlobal('useMyToast', () => ({ error: toast }))
    vi.stubGlobal('useDataSync', () => ({ subscribe: vi.fn(() => () => {}) }))
    const { useSyncedData } = await import('./useSyncedData')
    const fetcher = async () => {
      throw new Error('network')
    }
    const first_error = vi.fn()
    const second_error = vi.fn()
    const { refresh } = await useSyncedData(ref('shared:error'), fetcher, { immediate: false })
    await useSyncedData(ref('shared:error'), fetcher, { immediate: false })
    await useSyncedData(ref('shared:error'), fetcher, { immediate: false, on_error: first_error })
    await useSyncedData(ref('shared:error'), fetcher, { immediate: false, on_error: second_error })
    await refresh()
    expect(toast).toHaveBeenCalledOnce()
    expect(first_error).toHaveBeenCalledOnce()
    expect(second_error).toHaveBeenCalledOnce()
  })

  it('discards hydration buffers and removes hooks and subscriptions on disposal', async () => {
    const hooks = new Map<string, () => void>()
    const remove_hook = vi.fn()
    const nuxt_app = {
      isHydrating: true,
      hook: (name: string, callback: () => void) => {
        hooks.set(name, callback)
        return remove_hook
      },
    }
    let unmount!: () => void
    const unsubscribe = vi.fn()
    vi.stubGlobal('onUnmounted', (callback: () => void) => {
      unmount = callback
    })
    vi.stubGlobal('useNuxtApp', () => nuxt_app)
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({ subscribe: vi.fn(() => unsubscribe) }))
    const { useSyncedData } = await import('./useSyncedData')
    const resource = ref('disposed:hydration')
    const data = useSyncedState('disposed:hydration:data', () => 'ssr')
    const on_data = vi.fn()
    const fetcher = vi.fn(async () => 'client')
    await useSyncedData(resource, fetcher, data, { on_data })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    unmount()
    nuxt_app.isHydrating = false
    hooks.get('app:suspense:resolve')!()
    resource.value = 'disposed:new-key'
    expect(data.value).toBe('ssr')
    expect(on_data).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(remove_hook).toHaveBeenCalledTimes(2)
  })

  it('discards a buffered hydration response when its query is invalidated', async () => {
    const hooks = new Map<string, () => void>()
    const nuxt_app = {
      isHydrating: true,
      hook: (name: string, callback: () => void) => { hooks.set(name, callback) },
    }
    let invalidate!: () => Promise<void>
    vi.stubGlobal('useNuxtApp', () => nuxt_app)
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({
      subscribe: (_resource: string, callback: () => Promise<void>) => {
        invalidate = callback
        return () => {}
      },
    }))
    const { useSyncedData } = await import('./useSyncedData')
    const data = useSyncedState('invalidated:hydration', () => 'ssr')
    let resolve_fetch!: (value: string) => void
    const fetcher = vi.fn()
      .mockResolvedValueOnce('old identity')
      .mockImplementationOnce(() => new Promise<string>((resolve) => { resolve_fetch = resolve }))
    await useSyncedData(ref('identity:resource'), fetcher, data)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    const task = invalidate()
    nuxt_app.isHydrating = false
    hooks.get('app:suspense:resolve')!()
    expect(data.value).toBe('ssr')
    resolve_fetch('new identity')
    await task
    expect(data.value).toBe('new identity')
  })

  it('allows older responses when stale-response protection is disabled', async () => {
    vi.stubGlobal('useNuxtApp', () => ({ isHydrating: false, hook: vi.fn() }))
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({ subscribe: vi.fn(() => () => {}) }))

    const { useSyncedData } = await import('./useSyncedData')
    const data = ref<string | null>(null)
    const pending: Array<(value: string) => void> = []
    const { refresh } = await useSyncedData(ref('users:1'), () => new Promise<string>((resolve) => {
      pending.push(resolve)
    }), data, { immediate: false, universal: false, ignore_stale_responses: false })

    const first = refresh()
    const second = refresh()
    pending[1]!('newer')
    await second
    pending[0]!('older')
    await first
    expect(data.value).toBe('older')
  })

  it('fetches and refreshes an unkeyed resource without subscribing to sync events', async () => {
    vi.stubGlobal('useNuxtApp', () => ({ isHydrating: false, hook: vi.fn() }))
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    const subscribe = vi.fn(() => () => {})
    vi.stubGlobal('useDataSync', () => ({ subscribe }))

    const { useSyncedData } = await import('./useSyncedData')
    const data = ref<string | null>(null)
    const fetcher = vi.fn()
      .mockResolvedValueOnce('initial')
      .mockResolvedValueOnce('refreshed')

    const { refresh } = await useSyncedData(ref(null), fetcher, data, {
      universal: false,
      fetch_without_resource: true,
    })

    expect(data.value).toBe('initial')
    await refresh()
    expect(data.value).toBe('refreshed')
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('keeps the server snapshot until hydration resolves for an unkeyed resource', async () => {
    const hooks = new Map<string, () => void>()
    const nuxt_app = {
      isHydrating: true,
      hook: (name: string, callback: () => void) => {
        hooks.set(name, callback)
      },
    }
    vi.stubGlobal('useNuxtApp', () => nuxt_app)
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({ subscribe: vi.fn(() => () => {}) }))

    const { useSyncedData } = await import('./useSyncedData')
    const data = useSyncedState('admin:users', () => 'server list')
    const on_data = vi.fn()
    let resolve_fetch!: (value: string) => void
    const fetcher = vi.fn(() => new Promise<string>((resolve) => {
      resolve_fetch = resolve
    }))

    await useSyncedData(ref(null), fetcher, data, {
      universal: false,
      fetch_without_resource: true,
      on_data,
    })
    expect(fetcher).toHaveBeenCalledOnce()
    resolve_fetch('client list')
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(data.value).toBe('server list')
    expect(on_data).not.toHaveBeenCalled()
    nuxt_app.isHydrating = false
    hooks.get('app:suspense:resolve')!()
    expect(data.value).toBe('client list')
    expect(on_data).toHaveBeenCalledOnce()
  })

  it('defers on_data by default when no data ref is supplied during hydration', async () => {
    const hooks = new Map<string, () => void>()
    const nuxt_app = {
      isHydrating: true,
      hook: (name: string, callback: () => void) => {
        hooks.set(name, callback)
      },
    }
    const subscribe = vi.fn(() => () => {})
    vi.stubGlobal('useNuxtApp', () => nuxt_app)
    vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
    vi.stubGlobal('useDataSync', () => ({ subscribe }))

    const { useSyncedData } = await import('./useSyncedData')
    const on_data = vi.fn()
    let resolve_fetch!: (value: string) => void
    const fetcher = vi.fn(() => new Promise<string>((resolve) => {
      resolve_fetch = resolve
    }))

    await useSyncedData(ref('auth_user:1'), fetcher, { on_data })

    expect(fetcher).toHaveBeenCalledOnce()
    expect(on_data).not.toHaveBeenCalled()

    resolve_fetch('client response')
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(on_data).not.toHaveBeenCalled()
    hooks.get('app:mounted')!()
    expect(on_data).not.toHaveBeenCalled()
    nuxt_app.isHydrating = false
    hooks.get('app:suspense:resolve')!()
    expect(on_data).toHaveBeenCalledWith('client response')
  })
})
