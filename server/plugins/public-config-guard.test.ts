import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 不加载真实 .env：本测试明确提供 YAML 插值所需值，验证 Nitro 启动时注入 public 子集。
vi.mock('dotenv', () => ({ config: () => ({ parsed: {} }) }))

const injected_url = 'wss://mqtt.example.com/mqtt'

// 让 load_config() 跑得通：密钥与连接信息全给占位值
const config_env = {
  NODE_ENV: 'test',
  APP_PORT: '3042',
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
  NUXT_OTP_DEBUG: 'false',
}

// Nuxt build declares this shape; Nitro fills its validated values from YAML at startup.
const empty_public = {
  site: { url: '', indexable: false, staticBaseUrl: '' },
  mqtt: { web: { wsUrl: '' } },
  aliyun: { captcha: { appId: '' } },
}

const public_config: Record<string, unknown> = { ... empty_public }

vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin)
vi.stubGlobal('useRuntimeConfig', () => ({ public: public_config }))

const guard = (await import('./public-config-guard')).default as unknown as () => void

function run_guard() {
  guard()
}

beforeEach(() => {
  Object.assign(public_config, empty_public)
  for (const [key, value] of Object.entries(config_env)) {
    vi.stubEnv(key, value)
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('public 配置的运行期注入守卫', () => {
  it('从 YAML 解析结果注入 public 子集，不暴露服务端凭据', () => {
    expect(() => run_guard()).not.toThrow()
    expect(public_config).toEqual({
      site: { url: 'https://www.stupig.tv', indexable: false, staticBaseUrl: 'https://stupig.oss.tangenty.cn' },
      mqtt: { web: { wsUrl: injected_url } },
      aliyun: { captcha: { appId: '804af2e773219386ce8ff865dac64fbe' } },
    })
    expect(JSON.stringify(public_config)).not.toContain('placeholder')
  })
})
