import { afterAll, describe, expect, it, vi } from 'vitest'

// default.yaml 的连接信息全靠 .env 插值，构建期没有 .env 也要能过 schema 校验
for (const [key, value] of Object.entries({
  MYSQL_HOST: '127.0.0.1',
  MYSQL_PORT: '3306',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  MQTT_HOST: '127.0.0.1',
  MQTT_TCP_PORT: '1883',
  MQTT_WEB_URL: 'ws://localhost:8083/mqtt',
})) {
  vi.stubEnv(key, value)
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
  it('bundles Pinia so Nitro replaces its Vue compile-time flags', () => {
    expect(config.nitro?.externals?.inline).toContain('pinia')
  })
})
