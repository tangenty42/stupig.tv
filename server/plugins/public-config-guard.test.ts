import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 不加载真实 .env：本测试明确提供 YAML 插值所需值，验证 request runtime config 注入。
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

const frozen_public = Object.freeze({
  site: Object.freeze({ ... empty_public.site }),
  mqtt: Object.freeze({ web: Object.freeze({ ... empty_public.mqtt.web }) }),
  aliyun: Object.freeze({ captcha: Object.freeze({ ... empty_public.aliyun.captcha }) }),
})
const request_configs = new WeakMap<object, { public: Record<string, unknown> }>()
let request_hook: ((event: object) => void) | undefined

vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin)
vi.stubGlobal('useRuntimeConfig', (event?: object) => {
  if (! event) {
    return { public: frozen_public }
  }
  let request_config = request_configs.get(event)
  if (! request_config) {
    request_config = { public: structuredClone(empty_public) }
    request_configs.set(event, request_config)
  }
  return request_config
})

const guard = (await import('./public-config-guard')).default as unknown as () => void

type RequestEvent = NonNullable<Parameters<typeof useRuntimeConfig>[0]>

function run_guard(event = {} as RequestEvent) {
  (guard as unknown as (app: { hooks: { hook: (name: string, callback: (event: object) => void) => void } }) => void)({
    hooks: {
      hook: (name, callback) => {
        expect(name).toBe('request')
        request_hook = callback
      },
    },
  })
  request_hook?.(event)
  return event
}

beforeEach(() => {
  request_hook = undefined
  for (const [key, value] of Object.entries(config_env)) {
    vi.stubEnv(key, value)
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('public 配置的运行期注入守卫', () => {
  it('把 YAML 的 public 子集注入请求级 runtime config，不修改冻结的进程配置', () => {
    const event = run_guard()
    const request_config = useRuntimeConfig(event)
    expect(request_config.public).toEqual({
      site: { url: 'https://www.stupig.tv', indexable: false, staticBaseUrl: 'https://stupig.oss.tangenty.cn' },
      mqtt: { web: { wsUrl: injected_url } },
      aliyun: { captcha: { appId: '804af2e773219386ce8ff865dac64fbe' } },
    })
    expect(frozen_public.site.url).toBe('')
    expect(JSON.stringify(request_config.public)).not.toContain('placeholder')
  })
})
