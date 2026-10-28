import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse as parse_yaml } from 'yaml'
import { settings } from '../../server/shared/settings'
import { interpolate_config, load_aliyun_oss_config, load_config, load_content_migration_options, load_database_config, load_development_tunnel_layer, load_migration_image_profile, load_migration_source_config, merge_config_layers, public_config_from } from './loader'
import { aliyun_oss_config_schema, deployment_config_schema, public_config_defaults } from './schema'

const database_env = { MYSQL_HOST: 'db', MYSQL_PORT: '3306', MYSQL_PASSWORD: 'placeholder', MYSQL_USER: 'stupig_tv', MYSQL_DATABASE: 'stupig_tv' }
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
  MQTT_WS_PORT: '8083',
  OSS_PUBLIC_ACCESS_KEY_ID: 'public-id',
  OSS_PUBLIC_ACCESS_KEY_SECRET: 'public-secret',
  OSS_PRIVATE_ACCESS_KEY_ID: 'private-id',
  OSS_PRIVATE_ACCESS_KEY_SECRET: 'private-secret',
  ALIYUN_DYPNS_ACCESS_KEY_ID: 'placeholder',
  ALIYUN_DYPNS_ACCESS_KEY_SECRET: 'placeholder',
  ALIYUN_DYPNS_CAPTCHA_APP_KEY: 'placeholder',
  ALIYUN_OSS_ACCESS_KEY_ID: 'aliyun-oss-id',
  ALIYUN_OSS_ACCESS_KEY_SECRET: 'aliyun-oss-secret',
  JWT_SECRET: 'x'.repeat(40),
}

// Deployment tests select an explicit layer; NODE_ENV=test is not a deployment.
beforeEach(() => vi.stubEnv('NODE_ENV', 'production'))
afterEach(() => vi.unstubAllEnvs())

describe('deployment configuration', () => {
  it('excludes ESA publisher credentials from application and browser configuration', () => {
    const config = load_config({ ... deployment_env, ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID: 'publisher-id', ALIYUN_ESA_PUBLISH_ACCESS_KEY_SECRET: 'publisher-secret' })
    expect(config).not.toHaveProperty('esaFunction')
    expect(JSON.stringify(config)).not.toContain('publisher-secret')
    expect(public_config_from(config)).not.toHaveProperty('esaFunction')
  })
  it('loads source buckets, codec budgets, and migration options independently without exposing them', () => {
    const source = load_migration_source_config('public', { NODE_ENV: 'development', ALIYUN_OSS_ACCESS_KEY_ID: 'source-id', ALIYUN_OSS_ACCESS_KEY_SECRET: 'source-secret' })
    expect(source.accessKeyId).toBe('source-id')
    expect(source.accessKeySecret).toBe('source-secret')
    expect(() => load_migration_source_config('private', { NODE_ENV: 'development' })).toThrow('oss.buckets.private')
    expect(load_migration_image_profile({ NODE_ENV: 'development' })).toMatchObject({ profile_version: 1, profile: { avifQuality: 65 } })
    expect(load_content_migration_options({ NODE_ENV: 'production' }).partSizeMb).toBe(8)
    expect(public_config_from(load_config(deployment_env))).not.toHaveProperty('app.contentMigration')
  })
  it('loads only migration OSS credentials without unrelated application secrets', () => {
    const config = load_aliyun_oss_config({ ALIYUN_OSS_ACCESS_KEY_ID: 'migration-id', ALIYUN_OSS_ACCESS_KEY_SECRET: 'migration-secret' })
    expect(config).toMatchObject({ accessKeyId: 'migration-id', accessKeySecret: 'migration-secret' })
    expect(() => load_aliyun_oss_config({})).toThrow(/ALIYUN_OSS_ACCESS_KEY_ID/)
  })
  it('keeps runner deployment and per-process sweep capacities server-only', () => {
    const config = load_config(deployment_env)
    expect(config.app.backgroundRunner).toEqual({ mode: 'app', shutdownTimeoutMs: 30000, resources: { image: 1, oss: 2, esa: 1, notification: 1 } })
    expect(public_config_from(config)).not.toHaveProperty('app.backgroundRunner')
    for (const invalid of [{ mode: 'invalid' }, { shutdownTimeoutMs: 0 }, { resources: { ... config.app.backgroundRunner.resources, esa: 0 } }])
      expect(deployment_config_schema.safeParse({ ... config, app: { ... config.app, backgroundRunner: { ... config.app.backgroundRunner, ... invalid } } }).success).toBe(false)
  })
  it('keeps Content notification delivery independent and rejects leases shorter than ACK timeouts', () => {
    const config = load_config(deployment_env)
    expect(config.app.contentSync).toEqual({ enabled: true, sweepIntervalSeconds: 1, scanLimit: 50, leaseSeconds: 30, publishTimeoutMs: 10000, retrySeconds: 5, maxRetrySeconds: 300 })
    expect(public_config_from(config)).not.toHaveProperty('app.contentSync')
    for (const invalid of [{ scanLimit: 0 }, { scanLimit: 101 }, { leaseSeconds: 10 }, { publishTimeoutMs: 30000 }, { maxRetrySeconds: 1 }])
      expect(deployment_config_schema.safeParse({ ... config, app: { ... config.app, contentSync: { ... config.app.contentSync, ... invalid } } }).success).toBe(false)
  })
  it('loads upload lifecycle budgets independently of images and keeps them server-only', () => {
    const config = load_config(deployment_env)
    expect(config.app.contentUploads).toEqual({ enabled: true, sweepIntervalSeconds: 5, scanLimit: 20 })
    expect(public_config_from(config)).not.toHaveProperty('app.contentUploads')
    expect(deployment_config_schema.safeParse({ ... config, app: { ... config.app, contentImages: { ... config.app.contentImages, enabled: false } } }).success).toBe(true)
    for (const invalid of [{ scanLimit: 0 }, { scanLimit: 101 }, { sweepIntervalSeconds: 0 }])
      expect(deployment_config_schema.safeParse({ ... config, app: { ... config.app, contentUploads: { ... config.app.contentUploads, ... invalid } } }).success).toBe(false)
  })
  it('loads separate ESA management credentials and retirement limits without exposing them', () => {
    const configured = load_config({ ... deployment_env, ALIYUN_ESA_ACCESS_KEY_ID: 'purge-id', ALIYUN_ESA_ACCESS_KEY_SECRET: 'purge-secret', ALIYUN_ESA_SITE_ID: '123456' })
    expect(configured.aliyun.esaPurge).toMatchObject({ accessKeyId: 'purge-id', accessKeySecret: 'purge-secret', siteId: '123456', regionId: 'cn-hangzhou' })
    expect(configured.app.contentRetirement.enabled).toBe(true)
    expect(public_config_from(configured)).not.toHaveProperty('aliyun.esaPurge')
    expect(public_config_from(configured)).not.toHaveProperty('app.contentRetirement')
    expect(JSON.stringify(public_config_from(configured))).not.toContain('purge-secret')
    expect(load_config(deployment_env).aliyun.esaPurge?.siteId).toBe('')
    expect(() => load_config({ ... deployment_env, ALIYUN_ESA_ACCESS_KEY_ID: 'only-id' })).toThrow(/esaPurge/)
    expect(() => load_config({ ... deployment_env, ALIYUN_ESA_ACCESS_KEY_ID: '<required>' })).toThrow(/esaPurge/)
  })
  it('keeps prefetch opt-in, bounded and server-only', () => {
    const config = load_config({ ... deployment_env, NODE_ENV: 'production' })
    expect(config.app.contentPreload).toMatchObject({ enabled: false, deliveryVerified: false, dailyLimit: 500, quotaReserve: 1000 })
    expect(load_config({ ... deployment_env, NODE_ENV: 'development' }).app.contentPreload).toMatchObject({ enabled: true, deliveryVerified: true })
    expect(public_config_from(config)).not.toHaveProperty('app.contentPreload')
    for (const invalid of [{ dailyLimit: 0 }, { quotaReserve: - 1 }, { leaseSeconds: 30 }, { maxSubmissions: 6 }, { maxObjectBytes: 0 }, { taskClockSkewSeconds: 0 }, { taskClockSkewSeconds: 300 }])
      expect(deployment_config_schema.safeParse({ ... config, app: { ... config.app, contentPreload: { ... config.app.contentPreload, ... invalid } } }).success).toBe(false)
  })
  it('loads independent ESA secrets server-side and allows provisioning without a key', () => {
    const empty = load_config({ ... deployment_env, NODE_ENV: 'development', ALIYUN_ESA_AUTH_KEY: '' })
    expect(empty.aliyun.esa).toEqual({ baseUrl: 'https://stupig-static-dev.oss.tangenty.cn', authKey: '', urlTtlSeconds: 300 })
    const secret = 'a1'.repeat(32)
    const configured = load_config({ ... deployment_env, NODE_ENV: 'production', ALIYUN_ESA_AUTH_KEY: secret })
    expect(configured.aliyun.esa).toEqual({ baseUrl: 'https://stupig-static.oss.tangenty.cn', authKey: secret, urlTtlSeconds: 300 })
    expect(public_config_from(configured)).not.toHaveProperty('aliyun.esa')
    expect(JSON.stringify(public_config_from(configured))).not.toContain(secret)
    const special = load_config({ ... deployment_env, ALIYUN_ESA_AUTH_KEY: `${secret}#special!` })
    expect(special.aliyun.esa?.authKey).toBe(`${secret}#special!`)
    for (const authKey of ['<required>', 'short', ` ${secret}`, `${secret}\n`])
      expect(() => load_config({ ... deployment_env, ALIYUN_ESA_AUTH_KEY: authKey })).toThrow(/aliyun.esa.authKey/)
    for (const override of [{ baseUrl: 'http://example.test' }, { baseUrl: 'https://example.test/path' }, { baseUrl: 'https://user:secret@example.test' }, { baseUrl: 'https://example.test?auth_key=x' }, { urlTtlSeconds: 0 }, { urlTtlSeconds: 1.5 }])
      expect(deployment_config_schema.safeParse({ ... configured, aliyun: { ... configured.aliyun, esa: { ... configured.aliyun.esa, ... override } } }).success).toBe(false)
  })

  it('keeps image processing budgets server-only and rejects invalid lease/profile limits', () => {
    const config = load_config(deployment_env)
    expect(config.app.contentImages).toMatchObject({ enabled: true, concurrency: 1, profileVersion: 1 })
    expect(public_config_from(config).app).not.toHaveProperty('contentImages')
    const image = config.app.contentImages
    for (const invalid of [{ ... image, heartbeatSeconds: image.leaseSeconds }, { ... image, concurrency: 0 }, { ... image, profile: { ... image.profile, avifQuality: 101 } }])
      expect(deployment_config_schema.safeParse({ ... config, app: { ... config.app, contentImages: invalid } }).success).toBe(false)
  })

  it('supports a disabled Aliyun destination and strips an enabled one from browser config', () => {
    const legacy = load_config(deployment_env)
    const { oss: _destination, ... aliyun } = legacy.aliyun
    expect(deployment_config_schema.parse({ ... legacy, aliyun }).aliyun.oss).toBeNull()
    expect(deployment_config_schema.parse({ ... legacy, aliyun: { ... aliyun, oss: null } }).aliyun.oss).toBeNull()
    const oss = aliyun_oss_config_schema.parse({
      region: 'oss-cn-hangzhou', endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      bucket: 'aliyun-test-bucket', publicBaseUrl: 'https://assets.example.test',
      accessKeyId: 'aliyun-oss-id', accessKeySecret: 'aliyun-oss-secret',
    })
    const parsed = deployment_config_schema.parse({ ... legacy, aliyun: { ... legacy.aliyun, oss } })
    expect(parsed.aliyun.oss).toMatchObject({ timeoutMs: 120_000, copyPartSizeMb: 64, uploadRoleArn: null })
    const config = { ... legacy, aliyun: parsed.aliyun }
    const browser = JSON.stringify(public_config_from(config))
    expect(public_config_from(config)).not.toHaveProperty('aliyun.oss')
    expect(browser).not.toMatch(/aliyun-oss-id|aliyun-oss-secret|aliyun-test-bucket|oss-cn-hangzhou/)
    expect(config.oss.buckets.public.bucket).toBe(legacy.oss.buckets.public.bucket)
    expect(config.aliyun.dypns).toEqual(legacy.aliyun.dypns)
  })

  it.each([
    { endpoint: 'oss-cn-shenzhen.aliyuncs.com' },
    { endpoint: 'http://oss-cn-hangzhou.aliyuncs.com' },
    { endpoint: 'https://secret:password@oss-cn-hangzhou.aliyuncs.com' },
    { endpoint: 'https://oss-cn-hangzhou.aliyuncs.com/?token=secret' },
    { accessKeyId: '<required>' },
    { accessKeySecret: ' ' },
    { bucket: 'INVALID/another-bucket' },
    { timeoutMs: 0 },
    { uploadRoleArn: 'not-a-role' },
  ])('rejects an invalid enabled Aliyun destination: %j', (override) => {
    expect(aliyun_oss_config_schema.safeParse({
      region: 'oss-cn-hangzhou', endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      bucket: 'aliyun-test-bucket', publicBaseUrl: 'https://assets.example.test',
      accessKeyId: 'aliyun-oss-id', accessKeySecret: 'aliyun-oss-secret', ... override,
    }).success).toBe(false)
  })

  it('isolates DYPNS credentials from OSS credentials and rejects legacy-only names', () => {
    const env = {
      ... deployment_env,
      ALIYUN_DYPNS_ACCESS_KEY_ID: 'dypns-id',
      ALIYUN_DYPNS_ACCESS_KEY_SECRET: 'dypns-secret',
      ALIYUN_DYPNS_CAPTCHA_APP_KEY: 'captcha-secret',
      ALIYUN_OSS_ACCESS_KEY_ID: 'aliyun-oss-id',
      ALIYUN_OSS_ACCESS_KEY_SECRET: 'aliyun-oss-secret',
      ALIYUN_ACCESS_KEY_ID: 'legacy-id',
      ALIYUN_ACCESS_KEY_SECRET: 'legacy-secret',
      ALIYUN_CAPTCHA_APP_KEY: 'legacy-captcha',
    }
    const config = load_config(env)
    expect(config.aliyun.dypns).toMatchObject({ accessKeyId: 'dypns-id', accessKeySecret: 'dypns-secret' })
    expect(config.aliyun.captcha.appKey).toBe('captcha-secret')
    const browser = JSON.stringify(public_config_from(config))
    for (const secret of ['dypns-secret', 'captcha-secret', 'aliyun-oss-secret', 'legacy-secret'])
      expect(browser).not.toContain(secret)
    expect(() => load_config({ ... env, ALIYUN_DYPNS_ACCESS_KEY_ID: undefined })).toThrow(/ALIYUN_DYPNS_ACCESS_KEY_ID/)
    expect(() => load_config({ ... env, ALIYUN_DYPNS_ACCESS_KEY_SECRET: undefined })).toThrow(/ALIYUN_DYPNS_ACCESS_KEY_SECRET/)
    expect(() => load_config({ ... env, ALIYUN_DYPNS_CAPTCHA_APP_KEY: undefined })).toThrow(/ALIYUN_DYPNS_CAPTCHA_APP_KEY/)
  })

  it('uses current OSS credentials for static assets without exposing them to the browser', () => {
    const config = load_config(deployment_env)
    expect(config.oss.buckets.public.bucket).toBe('stupig-static')
    expect(config.oss.buckets.public).toMatchObject({ accessKeyId: 'aliyun-oss-id', accessKeySecret: 'aliyun-oss-secret' })
    expect(config.oss.buckets.private).toBeNull()
    const public_config = JSON.stringify(public_config_from(config))
    expect(public_config).not.toContain('private-secret')
    expect(public_config).not.toContain('public-secret')
    expect(public_config_from(config)).toHaveProperty('oss.buckets.public.publicBaseUrl', 'https://stupig-static.oss.tangenty.cn')
    expect(public_config_from(config).site).not.toHaveProperty('staticBaseUrl')
    expect(public_config_from(config)).not.toHaveProperty('oss.buckets.private')
    expect(config.oss.bucket).toBe(config.oss.buckets.public.bucket)
    expect(public_config).not.toMatch(/connectionTimeoutMs|requestTimeoutMs|copyPartSizeMb/)
    const input = structuredClone(config)
    input.oss.buckets.private = { ... input.oss.buckets.public, bucket: 'private-fixture', accessKeyId: 'private-key', accessKeySecret: 'private-secret' }
    const configured = deployment_config_schema.parse(input)
    expect(configured.oss.buckets.private?.bucket).toBe('private-fixture')
    expect(JSON.stringify(public_config_from({ ... config, oss: configured.oss }))).not.toContain('private-secret')
    input.oss.buckets.private.bucket = input.oss.buckets.public.bucket
    expect(() => deployment_config_schema.parse(input)).toThrow(/distinct/)
    input.oss.buckets.private.bucket = 'private-fixture'
    input.oss.buckets.private.requestTimeoutMs = 0
    expect(() => deployment_config_schema.parse(input)).toThrow(/requestTimeoutMs/)
    input.oss.buckets.private.requestTimeoutMs = 120_000
    for (const size of [4, 5121]) {
      input.oss.buckets.private.copyPartSizeMb = size
      expect(() => deployment_config_schema.parse(input)).toThrow(/copyPartSizeMb/)
    }
    input.oss.buckets.private.copyPartSizeMb = 64
    input.oss.buckets.private.accessKeySecret = ''
    expect(() => deployment_config_schema.parse(input)).toThrow()
    input.oss.buckets.private = null
    expect(deployment_config_schema.parse(input).oss.buckets.private).toBeNull()
  })

  it('starts without retired S3 credentials and rejects missing current OSS credentials', () => {
    const env = { ... deployment_env, OSS_PUBLIC_ACCESS_KEY_ID: undefined, OSS_PUBLIC_ACCESS_KEY_SECRET: undefined, OSS_PRIVATE_ACCESS_KEY_ID: undefined, OSS_PRIVATE_ACCESS_KEY_SECRET: undefined }
    expect(load_config(env).oss.buckets.private).toBeNull()
    expect(() => load_config({ ... env, ALIYUN_OSS_ACCESS_KEY_ID: undefined })).toThrow(/ALIYUN_OSS_ACCESS_KEY_ID/)
    expect(() => load_config({ ... env, ALIYUN_OSS_ACCESS_KEY_SECRET: '' })).toThrow(/accessKeySecret/)
  })
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
    expect(config.oss.bucket).toBe('stupig-static')
  })

  it('uses the configured development MQTT WebSocket port', () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(load_config({ ... deployment_env, MQTT_WS_PORT: '18083' }).mqtt.web.wsUrl).toBe('ws://localhost:18083/mqtt')
    expect(load_config(deployment_env).mqtt.web.wsUrl).toBe('ws://localhost:8083/mqtt')
    expect(() => load_config({ ... deployment_env, MQTT_WS_PORT: undefined })).toThrow(/MQTT_WS_PORT/)
  })

  it('uses development buckets while retaining independent credentials', () => {
    const config = load_config({ ... deployment_env, NODE_ENV: 'development' })
    expect(config.oss.buckets.public).toMatchObject({ bucket: 'stupig-static-dev', accessKeyId: 'aliyun-oss-id', accessKeySecret: 'aliyun-oss-secret' })
    expect(config.oss.buckets.private).toBeNull()
    expect(config.oss.buckets.public).toHaveProperty('publicBaseUrl', 'https://stupig-static-dev.oss.tangenty.cn')
    expect(config).not.toHaveProperty('devAuthTunnel')
    expect(public_config_from(config)).not.toHaveProperty('devAuthTunnel')
  })

  it('requires explicit database identity and captcha configuration', () => {
    expect(() => load_database_config({ ... database_env, MYSQL_USER: undefined })).toThrow(/MYSQL_USER/)
    expect(() => load_database_config({ ... database_env, MYSQL_DATABASE: undefined })).toThrow(/MYSQL_DATABASE/)
    expect(() => load_config({ ... deployment_env, ALIYUN_DYPNS_CAPTCHA_APP_KEY: undefined })).toThrow(/ALIYUN_DYPNS_CAPTCHA_APP_KEY/)
  })

  it('loads non-secret Aliyun settings from YAML and credentials from the environment', () => {
    const config = load_config(deployment_env)

    expect(config.aliyun.dypns).toEqual({ endpoint: 'dypnsapi.aliyuncs.com', regionId: 'cn-hongkong', accessKeyId: deployment_env.ALIYUN_DYPNS_ACCESS_KEY_ID, accessKeySecret: deployment_env.ALIYUN_DYPNS_ACCESS_KEY_SECRET })
    expect(config.aliyun.sms).toEqual({ signName: '速通互联验证服务', templateCode: '100001', schemeName: '蠢猪小组官网' })
    expect(config.aliyun).not.toHaveProperty('accessKeyId')
    expect(config.aliyun).not.toHaveProperty('accessKeySecret')
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

  it('captcha debug defaults on only in development and can be suppressed there', () => {
    const config = load_config({ ... deployment_env, NODE_ENV: 'development' })
    expect(config.app).toHaveProperty('captcha.debug', true)
    expect(public_config_from(config)).toHaveProperty('app.captcha.debug', true)
    expect(load_config({ ... deployment_env, NODE_ENV: 'development', NUXT_CAPTCHA_DEBUG: 'false' }).app).toHaveProperty('captcha.debug', false)
    expect(() => load_config({ ... deployment_env, NODE_ENV: 'development', NUXT_CAPTCHA_DEBUG: 'yes' })).toThrow(/app\.captcha\.debug/)
  })

  it.each(['production'])('rejects captcha debug outside development (%s)', (NODE_ENV) => {
    expect(load_config({ ... deployment_env, NODE_ENV, NUXT_CAPTCHA_DEBUG: 'false' }).app).toHaveProperty('captcha.debug', false)
    expect(() => load_config({ ... deployment_env, NODE_ENV, NUXT_CAPTCHA_DEBUG: 'true' })).toThrow(/app\.captcha\.debug/)
  })

  it('loads database configuration without unrelated services or secrets', () => {
    expect(load_database_config(database_env)).toEqual({ host: 'db', port: 3306, password: 'placeholder', user: 'stupig_tv', name: 'stupig_tv' })
  })

  it('projects only public deployment fields out of the full configuration', () => {
    expect(public_config_from(load_config(deployment_env))).toEqual({
      site: { url: 'https://www.stupig.tv', indexable: true },
      oss: { buckets: { public: { publicBaseUrl: 'https://stupig-static.oss.tangenty.cn' } } },
      mqtt: { web: { wsUrl: public_env.MQTT_WEB_URL } },
      aliyun: { captcha: { appId: '804af2e773219386ce8ff865dac64fbe' } },
      app: { captcha: { debug: false } },
    })
    expect(() => load_config({ ... deployment_env, MQTT_WEB_URL: 'https://invalid.example.com' })).toThrow(/mqtt\.web\.wsUrl/)
  })

  it.each(['test', 'staging', '', 'shared', 'local', 'dev', 'prod', undefined])('rejects an unspecified or unsupported deployment instead of falling back to production (%s)', (NODE_ENV) => {
    vi.stubEnv('NODE_ENV', NODE_ENV)
    expect(() => load_config({ ... deployment_env, NODE_ENV })).toThrow(/Invalid NODE_ENV/)
    expect(() => load_database_config({ ... database_env, NODE_ENV })).toThrow(/Invalid NODE_ENV/)
  })

  it('keeps storage destinations in environment layers and defaults in shared', () => {
    // Source-level contract: merged runtime values cannot reveal which layer owns a key.
    const shared = parse_yaml(readFileSync('config/shared.yaml', 'utf8'))
    const dev = parse_yaml(readFileSync('config/dev.yaml', 'utf8'))
    const prod = parse_yaml(readFileSync('config/prod.yaml', 'utf8'))
    expect(shared.oss.buckets.private).toBeNull()
    for (const name of ['public']) {
      expect(shared.oss.buckets[name]).toEqual({
        accessKeyId: `\${ALIYUN_OSS_ACCESS_KEY_ID}`,
        accessKeySecret: `\${ALIYUN_OSS_ACCESS_KEY_SECRET}`,
        forcePathStyle: false, connectionTimeoutMs: 30000, requestTimeoutMs: 120000, copyPartSizeMb: 64,
      })
      for (const layer of [dev, prod])
        expect(Object.keys(layer.oss.buckets[name]).sort()).toEqual(['bucket', 'endpoint', 'publicBaseUrl', 'region'])
    }
    for (const key of ['region', 'endpoint', 'bucket', 'publicBaseUrl', 'uploadRoleArn']) {
      expect(shared.aliyun.oss).not.toHaveProperty(key)
      expect(dev.aliyun.oss).toHaveProperty(key)
      expect(prod.aliyun.oss).toHaveProperty(key)
    }
    expect(shared.aliyun.esa).not.toHaveProperty('baseUrl')
    expect(shared).not.toHaveProperty('site')
  })

  it('applies local last only in development and requires the selected environment file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'stupig-config-layers-'))
    if (! directory.startsWith(join(tmpdir(), 'stupig-config-layers-')))
      throw new Error('Refusing to use a directory outside the test fixture prefix')
    const source = process.cwd()
    mkdirSync(join(directory, 'config'))
    for (const file of ['shared.yaml', 'dev.yaml', 'prod.yaml', 'app-settings.yaml'])
      copyFileSync(join(source, 'config', file), join(directory, 'config', file))
    writeFileSync(join(directory, 'config/local.yaml'), 'oss:\n  buckets:\n    public:\n      bucket: local-test-bucket\napp:\n  contentSync:\n    scanLimit: 7\ndevAuthTunnel:\n  proxy:\n    listenPort: 55501\n')
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory)
    try {
      const dev = load_config({ ... deployment_env, NODE_ENV: 'development' })
      expect(dev.oss.buckets.public).toMatchObject({ bucket: 'local-test-bucket', connectionTimeoutMs: 30000, accessKeyId: 'aliyun-oss-id' })
      expect(dev.app.contentSync.scanLimit).toBe(7)
      expect(load_development_tunnel_layer()).toMatchObject({ proxy: { listenPort: 55501, targetHost: '127.0.0.1' }, frp: { version: '0.71.0' } })
      const prod = load_config({ ... deployment_env, NODE_ENV: 'production' })
      expect(prod.oss.buckets.public.bucket).toBe('stupig-static')
      expect(prod.app.contentSync.scanLimit).toBe(50)
      rmSync(join(directory, 'config/prod.yaml'))
      expect(() => load_config({ ... deployment_env, NODE_ENV: 'production' })).toThrow(/prod\.yaml/)
    }
    finally {
      cwd.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
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
