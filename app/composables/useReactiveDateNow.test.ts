import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useReactiveDateNow } from './useReactiveDateNow'

describe('useReactiveDateNow', () => {
  const time_context = ref({ now_ms: Date.UTC(2026, 9, 10, 12), timezone: 'UTC' })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('uses the shared serialized time and timezone and reacts to their mounted update', () => {
    vi.stubGlobal('useState', () => time_context)
    const now = useReactiveDateNow()

    expect(now.value.format('YYYY-MM-DD HH:mm')).toBe('2026-10-10 12:00')

    time_context.value = { now_ms: Date.UTC(2026, 9, 10, 12), timezone: 'America/Los_Angeles' }

    expect(now.value.format('YYYY-MM-DD HH:mm')).toBe('2026-10-10 05:00')
  })
})
