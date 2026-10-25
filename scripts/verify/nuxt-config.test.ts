import { afterAll, describe, expect, it, vi } from 'vitest'

// This standalone Node harness supplies the same identity function at runtime.
// Nuxt's generated workspace context checks the actual configuration contract.
declare global {
  function defineNuxtConfig<T>(config: T): T
}

const generation = vi.hoisted(() => ({ generate_settings: vi.fn() }))
vi.mock('../../config/lib/generate', () => generation)

// Importing build configuration must not read runtime deployment files or secrets.
vi.mock('../../config/lib/environment.mjs', () => ({
  load_environment: () => {
    throw new Error('Runtime environment must not load during build configuration import')
  },
}))

for (const key of [
  'MYSQL_HOST',
  'MYSQL_PORT',
  'REDIS_HOST',
  'REDIS_PORT',
  'MQTT_HOST',
  'MQTT_TCP_PORT',
  'MQTT_WEB_URL',
]) {
  vi.stubEnv(key, undefined)
}

const config = await (async () => {
  vi.stubGlobal('defineNuxtConfig', <T>(config: T) => config)
  try {
    return (await import('../../nuxt.config')).default
  }
  finally {
    vi.unstubAllGlobals()
  }
})()

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('production SSR configuration', () => {
  it('does not generate settings just by importing configuration', () => {
    expect(generation.generate_settings).not.toHaveBeenCalled()
  })

  it('registers settings generation as a Nuxt module', () => {
    expect(config.modules?.[0]).toBe('./config/lib/nuxt-module')
  })

  it('bundles Pinia so Nitro replaces its Vue compile-time flags', () => {
    expect(config.nitro?.externals?.inline).toContain('pinia')
    expect(config.nitro?.externals?.inline).toContain('yaml')
  })

  it('declares only public deployment fields without reading runtime secrets', () => {
    expect(config.runtimeConfig?.public?.mqtt).toEqual({ web: { wsUrl: '' } })
    expect(config.runtimeConfig?.public?.site).toEqual({ url: '', indexable: false })
    expect(config.runtimeConfig?.public?.oss).toEqual({ buckets: { public: { publicBaseUrl: '' } } })
    expect(config.runtimeConfig?.public?.aliyun).toEqual({ captcha: { appId: '' } })
    expect(config.runtimeConfig?.public).not.toHaveProperty('max_content_encrypt_size_mb')
    expect(config.runtimeConfig?.public).not.toHaveProperty('JWT_SECRET')
  })
})
