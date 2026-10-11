import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

vi.stubGlobal('defineNuxtPlugin', (plugin: (app: unknown) => void) => plugin)

describe('timezone plugin hydration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps the serialized timezone through mounted, then syncs browser timezone after hydration', async () => {
    const cookie = ref<string | null>('Asia/Shanghai')
    const time_context = ref({ now_ms: 100, timezone: 'Asia/Shanghai' })
    const hooks = new Map<string, () => void>()
    const set_interval = vi.fn()

    vi.stubGlobal('useCookie', () => cookie)
    vi.stubGlobal('useDisplayTimeContext', () => time_context)
    vi.stubGlobal('setInterval', set_interval)
    vi.stubGlobal('clearInterval', vi.fn())
    vi.stubGlobal('Intl', {
      DateTimeFormat: class {
        resolvedOptions() {
          return { timeZone: 'America/Los_Angeles' }
        }
      },
    })
    vi.spyOn(Date, 'now').mockReturnValue(200)

    const { default: timezone_plugin } = await import('./timezone')
    timezone_plugin({
      hook: (name: string, callback: () => void) => {
        hooks.set(name, callback)
        return () => {}
      },
      vueApp: { onUnmount: vi.fn() },
    } as unknown as Parameters<typeof timezone_plugin>[0])

    expect(cookie.value).toBe('Asia/Shanghai')
    expect(time_context.value).toEqual({ now_ms: 100, timezone: 'Asia/Shanghai' })

    hooks.get('app:mounted')?.()
    expect(time_context.value).toEqual({ now_ms: 100, timezone: 'Asia/Shanghai' })

    hooks.get('app:suspense:resolve')!()

    expect(cookie.value).toBe('America/Los_Angeles')
    expect(time_context.value).toEqual({ now_ms: 200, timezone: 'America/Los_Angeles' })
    expect(set_interval).toHaveBeenCalledOnce()
    expect(set_interval.mock.calls[0]?.[1]).toBe(1000)
  })
})
