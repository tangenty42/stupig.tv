import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 不加载本机环境文件：使用显式夹具验证 request runtime config 注入。
vi.mock('../../config/lib/environment.mjs', () => ({ load_environment: () => ({ ... process.env }) }))

const injected_url = 'wss://mqtt.example.com/mqtt'

// 让 load_config() 跑得通：密钥与连接信息全给占位值
const config_env = {
  NODE_ENV: 'production',
  APP_PORT: '3042',
  MYSQL_PASSWORD: 'placeholder',
  JWT_SECRET: 'y'.repeat(40),
  ALIYUN_DYPNS_ACCESS_KEY_ID: 'placeholder',
  ALIYUN_DYPNS_ACCESS_KEY_SECRET: 'placeholder',
  ALIYUN_DYPNS_CAPTCHA_APP_KEY: 'placeholder',
  ALIYUN_OSS_ACCESS_KEY_ID: 'aliyun-oss-id',
  ALIYUN_OSS_ACCESS_KEY_SECRET: 'aliyun-oss-secret',
  OSS_PUBLIC_ACCESS_KEY_ID: 'public-id',
  OSS_PUBLIC_ACCESS_KEY_SECRET: 'public-secret',
  OSS_PRIVATE_ACCESS_KEY_ID: 'private-id',
  OSS_PRIVATE_ACCESS_KEY_SECRET: 'private-secret',
  MYSQL_HOST: '127.0.0.1',
  MYSQL_PORT: '3306',
  MYSQL_USER: 'stupig_tv',
  MYSQL_DATABASE: 'stupig_tv',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  MQTT_HOST: '127.0.0.1',
  MQTT_TCP_PORT: '1883',
  MQTT_WEB_URL: injected_url,
  NUXT_OTP_DEBUG: 'false',
  NUXT_CAPTCHA_DEBUG: 'false',
}

// Nuxt build declares this shape; Nitro fills its validated values from YAML at startup.
const empty_public = {
  site: { url: '', indexable: false },
  oss: { buckets: { public: { publicBaseUrl: '' } } },
  mqtt: { web: { wsUrl: '' } },
  aliyun: { captcha: { appId: '' } },
  app: { captcha: { debug: false } },
}

const frozen_public = Object.freeze({
  site: Object.freeze({ ... empty_public.site }),
  oss: Object.freeze({ buckets: Object.freeze({ public: Object.freeze({ ... empty_public.oss.buckets.public }) }) }),
  mqtt: Object.freeze({ web: Object.freeze({ ... empty_public.mqtt.web }) }),
  aliyun: Object.freeze({ captcha: Object.freeze({ ... empty_public.aliyun.captcha }) }),
  app: Object.freeze({ captcha: Object.freeze({ ... empty_public.app.captcha }) }),
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
      site: { url: 'https://www.stupig.tv', indexable: true },
      oss: { buckets: { public: { publicBaseUrl: 'https://stupig-static.oss.tangenty.cn' } } },
      mqtt: { web: { wsUrl: injected_url } },
      aliyun: { captcha: { appId: '804af2e773219386ce8ff865dac64fbe' } },
      app: { captcha: { debug: false } },
    })
    expect(frozen_public.site.url).toBe('')
    expect(JSON.stringify(request_config.public)).not.toContain('placeholder')
  })
})
