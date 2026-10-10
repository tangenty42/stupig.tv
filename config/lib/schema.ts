import * as z from 'zod'

const positive_integer = z.number().int().positive()
const identifier = z.string().min(1).refine(value => ! value.includes('${'), 'Environment interpolation is not allowed in app settings')
const otp_tier = z.strictObject({ dailyLimit: positive_integer, cooldownMs: positive_integer })

export const settings_schema = z.strictObject({
  app: z.strictObject({
    api: z.strictObject({ base: identifier }),
    auth: z.strictObject({
      jwt: z.strictObject({ expiresInDays: positive_integer, renewBeforeDays: positive_integer }),
      session: z.strictObject({ maxAgeDays: positive_integer, maxTokenGenerations: positive_integer }),
      cookie: z.strictObject({ maxAgeDays: positive_integer, tokenName: identifier, userName: identifier }),
      bcryptRounds: z.number().int().min(4).max(31),
    }),
    otp: z.strictObject({ expiresMinutes: positive_integer, tier1: otp_tier, tier2: otp_tier }),
    identity: z.strictObject({ cookieName: identifier, cookieMaxAgeDays: positive_integer }),
    client: z.strictObject({
      colorMode: z.strictObject({ fallback: z.enum(['light', 'dark']), cookieName: identifier }),
      timezone: z.strictObject({ cookieName: identifier }),
      sync: z.strictObject({ broadcastChannelName: identifier, clientIdStorageKey: identifier }),
    }),
    online: z.strictObject({ timeoutSeconds: positive_integer, pingIdleIntervalSeconds: positive_integer, pollIntervalSeconds: positive_integer }),
    avatar: z.strictObject({ maxSizeMb: positive_integer }),
    content: z.strictObject({
      story: z.strictObject({
        titleMaxLength: positive_integer.max(120),
        labelMaxBytes: positive_integer.max(255),
        descMaxBytes: positive_integer.max(500),
        coverMaxBytes: positive_integer.max(255),
        markdownMaxBytes: positive_integer.max(16777215),
      }),
      link: z.strictObject({ fileNameMaxBytes: positive_integer.max(255) }),
      draft: z.strictObject({ schemaVersion: positive_integer, storagePrefix: identifier, autosaveDelayMs: positive_integer }),
      upload: z.strictObject({
        handleStorageName: identifier,
        partSizeMb: positive_integer.min(5),
        signBatchSize: positive_integer.max(1000),
        urlTtlSeconds: positive_integer,
        maxSizeMb: positive_integer,
      }),
      download: z.strictObject({ urlTtlSeconds: positive_integer }),
      redact: z.strictObject({ maxDimension: positive_integer }),
      operationLock: z.strictObject({ ttlSeconds: positive_integer }),
      task: z.strictObject({ heartbeatSeconds: positive_integer, queuedTimeoutSeconds: positive_integer, retentionHours: positive_integer, sweepIntervalSeconds: positive_integer, clientIdStorageName: identifier }),
      encrypt: z.strictObject({ maxSizeMb: positive_integer }),
    }),
  }),
  integrations: z.strictObject({
    mqtt: z.strictObject({ qos: z.union([z.literal(0), z.literal(1), z.literal(2)]), topicPrefix: identifier, clientIdPrefixServer: identifier, clientIdPrefixWeb: identifier, publishQueueSize: positive_integer }),
    bilibili: z.strictObject({ fetchTimeoutMs: positive_integer, cacheTtlMs: positive_integer, negativeCacheTtlMs: positive_integer, fetchFailureCooldownMs: positive_integer }),
  }),
}).superRefine(({ app }, context) => {
  const { auth, content } = app
  const checks = [
    [auth.jwt.renewBeforeDays < auth.jwt.expiresInDays, ['app', 'auth', 'jwt', 'renewBeforeDays']],
    [auth.cookie.maxAgeDays >= auth.jwt.expiresInDays, ['app', 'auth', 'cookie', 'maxAgeDays']],
    [auth.session.maxAgeDays > auth.jwt.renewBeforeDays, ['app', 'auth', 'session', 'maxAgeDays']],
    [content.task.heartbeatSeconds < content.operationLock.ttlSeconds, ['app', 'content', 'task', 'heartbeatSeconds']],
    [content.upload.maxSizeMb <= content.upload.partSizeMb * 10000, ['app', 'content', 'upload', 'maxSizeMb']],
    [content.encrypt.maxSizeMb <= content.upload.maxSizeMb, ['app', 'content', 'encrypt', 'maxSizeMb']],
  ] as const
  for (const [valid, path] of checks) {
    if (! valid) {
      context.addIssue({ code: 'custom', path: [... path], message: 'Inconsistent application settings' })
    }
  }
})

export type Settings = z.infer<typeof settings_schema>
const required_string = z.string().min(1)
const port = z.coerce.number().int().min(1).max(65535)
const boolean_value = z.union([z.boolean(), z.enum(['true', 'false']).transform(value => value === 'true')])
export const database_config_schema = z.object({
  host: required_string,
  port,
  user: required_string,
  password: required_string,
  name: required_string,
})
const site_config_schema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  indexable: boolean_value,
  staticBaseUrl: z.url({ protocol: /^https?$/ }),
})
const mqtt_web_config_schema = z.object({ wsUrl: z.url({ protocol: /^wss?$/ }) })
const captcha_config_schema = z.object({ appId: required_string, appKey: z.string() })
export const deployment_config_schema = z.object({
  db: database_config_schema,
  redis: z.object({ host: required_string, port, password: z.string() }),
  mqtt: z.object({
    host: required_string,
    port,
    username: z.string(),
    password: z.string(),
    web: mqtt_web_config_schema,
  }),
  oss: z.object({
    endpoint: z.url({ protocol: /^https?$/ }),
    region: required_string,
    bucket: required_string,
    accessKeyId: required_string,
    accessKeySecret: required_string,
    forcePathStyle: boolean_value,
  }),
  aliyun: z.object({
    dypns: z.object({ endpoint: required_string, regionId: required_string }),
    sms: z.object({ signName: required_string, templateCode: required_string, schemeName: required_string }),
    accessKeyId: required_string,
    accessKeySecret: required_string,
    captcha: captcha_config_schema,
  }),
  site: site_config_schema,
  app: z.object({
    auth: z.object({ jwt: z.object({ secret: z.string().min(32) }) }),
    otp: z.object({ debug: boolean_value }),
  }),
})

// The browser-visible subset; parsing a full config strips every field not listed here.
export const public_config_schema = z.object({
  site: site_config_schema,
  mqtt: z.object({ web: mqtt_web_config_schema }),
  aliyun: z.object({ captcha: captcha_config_schema.pick({ appId: true }) }),
})

// Build-time shape only; Nitro fills the real values at startup.
export const public_config_defaults = {
  site: { url: '', indexable: false, staticBaseUrl: '' },
  mqtt: { web: { wsUrl: '' } },
  aliyun: { captcha: { appId: '' } },
} satisfies z.input<typeof public_config_schema>
