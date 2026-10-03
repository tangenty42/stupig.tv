import { afterAll, describe, expect, it, vi } from 'vitest'

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
  it('bundles Pinia so Nitro replaces its Vue compile-time flags', () => {
    expect(config.nitro?.externals?.inline).toContain('pinia')
  })

  it('在没有 .env 的构建机上也能取到 public 白名单', () => {
    // 镜像里烘焙的是空串，运行期由容器的 NUXT_PUBLIC_MQTT_WEB_URL 覆盖
    expect(config.runtimeConfig?.public?.mqtt_web_url).toBe('')
    expect(config.runtimeConfig?.public?.site_url).toBe('https://www.stupig.tv')
  })
})
