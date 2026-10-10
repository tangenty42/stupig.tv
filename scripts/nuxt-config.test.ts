import { afterAll, describe, expect, it, vi } from 'vitest'

const generation = vi.hoisted(() => ({ generate_settings: vi.fn() }))
vi.mock('../config/lib/generate', () => generation)

// 构建机（Dockerfile/CI）没有 .env，nuxt.config 必须在这种状态下加载成功；
// 所以这里拦掉 dotenv，也不补任何连接信息变量。
vi.mock('dotenv', () => ({ config: () => ({ parsed: {} }) }))

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
  vi.stubGlobal('defineNuxtConfig', (config: unknown) => config)
  try {
    return (await import('../nuxt.config')).default
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
    expect(config.runtimeConfig?.public?.site).toEqual({ url: '', indexable: false, staticBaseUrl: '' })
    expect(config.runtimeConfig?.public?.aliyun).toEqual({ captcha: { appId: '' } })
    expect(config.runtimeConfig?.public).not.toHaveProperty('max_content_encrypt_size_mb')
    expect(config.runtimeConfig?.public).not.toHaveProperty('JWT_SECRET')
  })
})
