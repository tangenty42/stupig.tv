import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 不加载真实 .env：本测试要构造的正是"构建机没有 .env，插值字段被烘焙成空串"的状态
vi.mock('dotenv', () => ({ config: () => ({ parsed: {} }) }))

const injected_url = 'wss://mqtt.example.com/mqtt'

// 让 load_config() 跑得通：密钥与连接信息全给占位值
const config_env = {
  MYSQL_PASSWORD: 'placeholder',
  JWT_SECRET: 'y'.repeat(40),
  ALIYUN_ACCESS_KEY_ID: 'placeholder',
  ALIYUN_ACCESS_KEY_SECRET: 'placeholder',
  OSS_ACCESS_KEY_ID: 'placeholder',
  OSS_ACCESS_KEY_SECRET: 'placeholder',
  MYSQL_HOST: '127.0.0.1',
  MYSQL_PORT: '3306',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  MQTT_HOST: '127.0.0.1',
  MQTT_TCP_PORT: '1883',
  MQTT_WEB_URL: injected_url,
}

// 镜像里烘焙出来的形状：注入过的键是真值，没注入的是空串。布尔 false 与数字 0 是白名单
// 里的合法取值（site_indexable 在开发环境就是 false），不能当成缺失
const baked_public = {
  mqtt_web_url: injected_url,
  mqtt_qos: 0,
  site_indexable: false,
  site_url: 'https://www.stupig.tv',
}

let public_config: Record<string, unknown> = baked_public

vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin)
vi.stubGlobal('useRuntimeConfig', () => ({ public: public_config }))

const guard = (await import('./public-config-guard')).default as unknown as () => void

function run_guard(overrides: Record<string, unknown> = {}) {
  public_config = { ... baked_public, ... overrides }
  guard()
}

beforeEach(() => {
  for (const [key, value] of Object.entries(config_env)) {
    vi.stubEnv(key, value)
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('public 配置的运行期注入守卫', () => {
  it('注入齐备时放行', () => {
    expect(() => run_guard()).not.toThrow()
  })

  it('漏注入时启动失败，并点名要设哪个环境变量', () => {
    expect(() => run_guard({ mqtt_web_url: '' })).toThrowError(/NUXT_PUBLIC_MQTT_WEB_URL/)
  })

  it('注入的值与服务端同一份配置不一致时启动失败', () => {
    expect(() => run_guard({ mqtt_web_url: 'wss://stale.example.com/mqtt' })).toThrowError(/stale\.example\.com/)
  })

  it('表外的空串会被兜底拦下，提示补进 runtime_injected_public', () => {
    const failure = () => run_guard({ story_cover_url: '' })
    expect(failure).toThrowError(/story_cover_url/)
    expect(failure).toThrowError(/NUXT_PUBLIC_STORY_COVER_URL/)
  })
})
