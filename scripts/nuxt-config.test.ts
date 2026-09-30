import { describe, expect, it, vi } from 'vitest'

const config = await (async () => {
  vi.stubGlobal('defineNuxtConfig', (config: unknown) => config)
  try {
    return (await import('../nuxt.config')).default
  }
  finally {
    vi.unstubAllGlobals()
  }
})()

describe('production SSR configuration', () => {
  it('bundles Pinia so Nitro replaces its Vue compile-time flags', () => {
    expect(config.nitro?.externals?.inline).toContain('pinia')
  })
})
