import { afterEach, describe, expect, it, vi } from 'vitest'
import { settings } from '../../server/shared/settings'
import { interpolate_config, load_config, load_database_config, merge_config_layers, public_config_from } from './loader'
import { public_config_defaults } from './schema'

const database_env = { MYSQL_HOST: 'db', MYSQL_PORT: '3306', MYSQL_PASSWORD: 'placeholder' }
const public_env = {
  MQTT_WEB_URL: 'wss://mqtt.example.com/mqtt',
}
const deployment_env = {
  ... database_env,
  ... public_env,
  APP_PORT: '3042',
  REDIS_HOST: 'redis',
  REDIS_PORT: '6379',
  MQTT_HOST: 'mqtt',
  MQTT_TCP_PORT: '1883',
  OSS_ACCESS_KEY_ID: 'placeholder',
  OSS_ACCESS_KEY_SECRET: 'placeholder',
  ALIYUN_ACCESS_KEY_ID: 'placeholder',
  ALIYUN_ACCESS_KEY_SECRET: 'placeholder',
  JWT_SECRET: 'x'.repeat(40),
}

afterEach(() => vi.unstubAllEnvs())

describe('deployment configuration', () => {
  it('validates missing and empty secrets without exposing their values', () => {
    expect(() => load_config({})).toThrow(/MYSQL_HOST/)
    expect(() => load_config({ ... deployment_env, MYSQL_PASSWORD: '' })).toThrow(/db\.password/)
    expect(() => load_config({ ... deployment_env, JWT_SECRET: 'short' })).toThrow(/app\.auth\.jwt\.secret/)
  })

  it('rejects empty hosts and invalid ports', () => {
    expect(() => load_config({ ... deployment_env, MYSQL_HOST: '' })).toThrow(/db\.host/)
    for (const MYSQL_PORT of ['0', '65536', '3.5', 'not-a-port']) {
      expect(() => load_database_config({ ... database_env, MYSQL_PORT })).toThrow(/db\.port/)
    }
  })

  it('combines static defaults with deployment overrides', () => {
    const config = load_config({ ... deployment_env, CONTENT_ENCRYPT_MAX_SIZE_MB: '999' })
    expect(config.app.content).toEqual(settings.app.content)
    expect(config.integrations).toEqual(settings.integrations)
    expect(config.app.client).toEqual(settings.app.client)
    expect(config.app).not.toHaveProperty('colorMode')
    expect(config.app).not.toHaveProperty('timezone')
    expect(config.app).not.toHaveProperty('sync')
    expect(config.app.auth.jwt.secret).toBe(deployment_env.JWT_SECRET)
    expect(config.app.auth.jwt.expiresInDays).toBe(settings.app.auth.jwt.expiresInDays)
    expect(config.mqtt.host).toBe(deployment_env.MQTT_HOST)
    expect(config.mqtt).not.toHaveProperty('qos')
    expect(config.mqtt.web).not.toHaveProperty('clientIdPrefix')
    expect(config.mqtt.web.wsUrl).toBe(public_env.MQTT_WEB_URL)
    expect(config.oss.bucket).toBe('static-stupig-tv')
  })

  it('uses the configured development MQTT WebSocket port', () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(load_config({ ... deployment_env, MQTT_WS_PORT: '18083' }).mqtt.web.wsUrl).toBe('ws://localhost:18083/mqtt')
    expect(load_config(deployment_env).mqtt.web.wsUrl).toBe('ws://localhost:8083/mqtt')
  })

  it('loads non-secret Aliyun settings from YAML and credentials from the environment', () => {
    const config = load_config(deployment_env)

    expect(config.aliyun.dypns).toEqual({ endpoint: 'dypnsapi.aliyuncs.com', regionId: 'cn-hongkong' })
    expect(config.aliyun.sms).toEqual({ signName: '速通互联验证服务', templateCode: '100001', schemeName: '蠢猪小组官网' })
    expect(config.aliyun.accessKeyId).toBe(deployment_env.ALIYUN_ACCESS_KEY_ID)
  })

  it('parses booleans explicitly and rejects invalid values', () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(load_config({ ... deployment_env, NUXT_OTP_DEBUG: 'false' }).app.otp.debug).toBe(false)
    expect(load_config({ ... deployment_env, NUXT_OTP_DEBUG: 'true' }).app.otp.debug).toBe(true)
    expect(() => load_config({ ... deployment_env, NUXT_OTP_DEBUG: 'yes' })).toThrow(/app\.otp\.debug/)
  })

  it('rejects OTP debug in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(load_config(deployment_env).site.indexable).toBe(true)
    expect(() => load_config({ ... deployment_env, NUXT_OTP_DEBUG: 'true' })).toThrow(/app\.otp\.debug/)
  })

  it('loads database configuration without unrelated services or secrets', () => {
    expect(load_database_config(database_env)).toEqual({ host: 'db', port: 3306, password: 'placeholder', user: 'stupig_tv', name: 'stupig_tv' })
  })

  it('projects only public deployment fields out of the full configuration', () => {
    expect(public_config_from(load_config(deployment_env))).toEqual({
      site: { url: 'https://www.stupig.tv', indexable: false, staticBaseUrl: 'https://stupig.oss.tangenty.cn' },
      mqtt: { web: { wsUrl: public_env.MQTT_WEB_URL } },
      aliyun: { captcha: { appId: '804af2e773219386ce8ff865dac64fbe' } },
    })
    expect(() => load_config({ ... deployment_env, MQTT_WEB_URL: 'https://invalid.example.com' })).toThrow(/mqtt\.web\.wsUrl/)
  })

  it('skips environment layers that have no YAML file', () => {
    vi.stubEnv('NODE_ENV', 'staging')
    expect(load_config(deployment_env).site.url).toBe('https://www.stupig.tv')
  })

  it('merges YAML maps recursively and replaces arrays', () => {
    expect(merge_config_layers(
      { service: { host: 'default', port: 1 }, list: ['a', 'b'] },
      { service: { port: 2 }, list: ['c'] },
    )).toEqual({ service: { host: 'default', port: 2 }, list: ['c'] })
  })

  it('interpolates only explicit variables and supports empty fallbacks', () => {
    expect(interpolate_config({ secret: `\${SECRET}`, optional: `\${OPTIONAL:-}` }, { SECRET: 'value' })).toEqual({ secret: 'value', optional: '' })
    expect(() => interpolate_config({ secret: `\${MISSING}` }, {})).toThrow(/MISSING.*config\.secret/)
    expect(interpolate_config(merge_config_layers({ value: `\${MISSING}` }, { value: 'override' }), {})).toEqual({ value: 'override' })
  })

  it('declares build defaults without requiring any deployment secrets', () => {
    expect(public_config_defaults.site.indexable).toBe(false)
    expect(public_config_defaults.mqtt.web.wsUrl).toBe('')
    expect(public_config_defaults).not.toHaveProperty('db')
    expect(public_config_defaults).not.toHaveProperty('JWT_SECRET')
  })
})
