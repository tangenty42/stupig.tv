import { settings } from '@shared/settings'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref, watch } from 'vue'

vi.mock('~/composables/useSyncedData', () => ({ invalidate_unsignalled_queries: vi.fn() }))

describe('data sync reconnect notice', () => {
  const delay = settings.app.client.sync.reconnectNoticeDelayMs
  const info = vi.fn()
  const reconnecting = ref(false)
  let cleanup: () => void

  beforeEach(async () => {
    vi.useFakeTimers()
    info.mockClear()
    reconnecting.value = false
    vi.stubGlobal('defineNuxtPlugin', <Plugin>(plugin: Plugin) => plugin)
    vi.stubGlobal('useDataSync', () => ({ reconnecting, start: vi.fn() }))
    vi.stubGlobal('useAuth', () => ({ user: ref(null), handle_remote_logout: vi.fn() }))
    vi.stubGlobal('useApi', () => ({ content: {} }))
    vi.stubGlobal('useMyToast', () => ({ info }))
    vi.stubGlobal('watch', watch)
    const { default: start_data_sync } = await import('./data-sync.client')
    start_data_sync({
      vueApp: { onUnmount: (stop: () => void) => { cleanup = stop } },
    } as unknown as Parameters<typeof start_data_sync>[0])
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('cancels the notice on quick recovery and shows it once per sustained outage', async () => {
    reconnecting.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(delay - 1)
    reconnecting.value = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(delay)
    expect(info).not.toHaveBeenCalled()

    reconnecting.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(delay)
    expect(info).toHaveBeenCalledWith('实时更新已中断，正在重连……')
    await vi.advanceTimersByTimeAsync(delay * 10)
    expect(info).toHaveBeenCalledOnce()

    reconnecting.value = false
    await nextTick()
    reconnecting.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(delay)
    expect(info).toHaveBeenCalledTimes(2)
  })
})
