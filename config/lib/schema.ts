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
      sync: z.strictObject({
        broadcastChannelName: identifier,
        clientIdStorageKey: identifier,
        eventDeduplicationLimit: z.number().int().positive(),
        resourceGatherDelayMs: z.number().int().positive(),
        reconnectDelayMs: z.number().int().positive(),
        connectTimeoutMs: z.number().int().positive(),
      }),
    }),
    online: z.strictObject({ timeoutSeconds: positive_integer, pingIdleIntervalSeconds: positive_integer, pollIntervalSeconds: positive_integer }),
    admin: z.strictObject({ pollIntervalSeconds: positive_integer }),
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
      reference: z.strictObject({ journalRetentionDays: positive_integer, sweepIntervalSeconds: positive_integer }),
      workspace: z.strictObject({ batchLimit: positive_integer, draftReferenceLimit: positive_integer, suffixAttempts: positive_integer, receiptHours: positive_integer, sessionHours: positive_integer, leaseSeconds: positive_integer, heartbeatSeconds: positive_integer, parallelUploads: positive_integer }),
      name: z.strictObject({ suffixSeparator: z.literal('_') }),
      upload: z.strictObject({
        requestTimeoutSeconds: positive_integer,
        handleStorageName: identifier,
        partSizeMb: positive_integer.min(5),
        signBatchSize: positive_integer.max(1000),
        urlTtlSeconds: positive_integer,
        maxSizeMb: positive_integer,
      }),
      download: z.strictObject({ urlTtlSeconds: positive_integer }),
      read: z.strictObject({ urlTtlSeconds: positive_integer }),
      redact: z.strictObject({ maxDimension: positive_integer }),
      imageEditor: z.strictObject({ maxPixels: positive_integer, maxActions: positive_integer, maxStrokePoints: positive_integer }),
      image: z.strictObject({ lqipMaxBytes: positive_integer.max(8192) }),
      encrypt: z.strictObject({ maxSizeMb: positive_integer }),
    }),
  }),
  integrations: z.strictObject({
    mqtt: z.strictObject({ qos: z.union([z.literal(0), z.literal(1), z.literal(2)]), topicPrefix: identifier, clientIdPrefixServer: identifier, clientIdPrefixWeb: identifier, publishQueueSize: positive_integer }),
    bilibili: z.strictObject({ fetchTimeoutMs: positive_integer, cacheTtlMs: positive_integer, negativeCacheTtlMs: positive_integer,
      fetchFailureCooldownMs: positive_integer, fetchFailureMaxCooldownMs: positive_integer, retryJitterRatio: z.number().min(0).max(1) }),
  }),
}).superRefine(({ app, integrations }, context) => {
  const { auth, content } = app
  const checks = [
    [auth.jwt.renewBeforeDays < auth.jwt.expiresInDays, ['app', 'auth', 'jwt', 'renewBeforeDays']],
    [auth.cookie.maxAgeDays >= auth.jwt.expiresInDays, ['app', 'auth', 'cookie', 'maxAgeDays']],
    [auth.session.maxAgeDays > auth.jwt.renewBeforeDays, ['app', 'auth', 'session', 'maxAgeDays']],
    [content.workspace.heartbeatSeconds < content.workspace.leaseSeconds, ['app', 'content', 'workspace', 'heartbeatSeconds']],
    [content.upload.maxSizeMb <= content.upload.partSizeMb * 10000, ['app', 'content', 'upload', 'maxSizeMb']],
    [content.encrypt.maxSizeMb <= content.upload.maxSizeMb, ['app', 'content', 'encrypt', 'maxSizeMb']],
    [integrations.bilibili.fetchFailureCooldownMs <= integrations.bilibili.fetchFailureMaxCooldownMs, ['integrations', 'bilibili', 'fetchFailureMaxCooldownMs']],
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
})
const mqtt_web_config_schema = z.object({ wsUrl: z.url({ protocol: /^wss?$/ }) })
const redis_config_schema = z.object({ host: required_string, port, password: z.string() })
const mqtt_config_schema = z.object({
  host: required_string,
  port,
  username: z.string(),
  password: z.string(),
  web: mqtt_web_config_schema,
})
const captcha_config_schema = z.object({ appId: required_string, appKey: z.string() })
export const oss_bucket_config_schema = z.object({
  endpoint: z.url({ protocol: /^https?$/ }),
  region: required_string,
  bucket: required_string,
  publicBaseUrl: z.url({ protocol: /^https?$/ }).nullable().default(null),
  accessKeyId: required_string,
  accessKeySecret: required_string,
  forcePathStyle: boolean_value,
  connectionTimeoutMs: positive_integer.default(30_000),
  requestTimeoutMs: positive_integer.default(120_000),
  copyPartSizeMb: positive_integer.min(5).max(5120).default(64),
})
const public_bucket_config_schema = oss_bucket_config_schema.extend({
  publicBaseUrl: z.url({ protocol: /^https?$/ }),
})
export const aliyun_esa_config_schema = z.object({
  baseUrl: z.url({ protocol: /^https$/ }).refine((value) => {
    const url = new URL(value)
    return ! url.username && ! url.password && ! url.search && ! url.hash && url.pathname === '/'
  }, 'Use an HTTPS ESA origin without credentials, path or query'),
  // Empty while provisioning; this is independent of OSS RAM credentials.
  authKey: z.union([z.literal(''), z.string().regex(/^[\x21-\x7E]{32,128}$/)]).default(''),
  // Must match TTL_SECONDS in the deployed Content edge function.
  urlTtlSeconds: positive_integer.max(3600).default(300),
})

const esa_credential = z.union([z.literal(''), required_string.refine(value => value !== '<required>' && value.trim() === value, 'Fill the ESA management credential')])
export const aliyun_esa_purge_config_schema = z.object({
  accessKeyId: esa_credential,
  accessKeySecret: esa_credential,
  siteId: z.union([z.literal(''), z.string().regex(/^[1-9]\d{0,15}$/).refine(value => Number.isSafeInteger(Number(value)))]),
  regionId: z.enum(['cn-hangzhou', 'ap-southeast-1']),
  endpoint: z.enum(['esa.cn-hangzhou.aliyuncs.com', 'esa.ap-southeast-1.aliyuncs.com']),
  timeoutMs: positive_integer.max(60_000),
}).refine(value => value.endpoint === `esa.${value.regionId}.aliyuncs.com`, 'ESA endpoint and region must match')
  .refine(value => Boolean(value.accessKeyId) === Boolean(value.accessKeySecret), 'Configure both ESA management credentials together')
  .refine(value => ! value.accessKeyId || Boolean(value.siteId), 'Configure an ESA site ID when management credentials are enabled')

export const content_retirement_config_schema = z.object({
  enabled: boolean_value, sweepIntervalSeconds: positive_integer, scanLimit: positive_integer.max(100),
  leaseSeconds: positive_integer.max(3600), retrySeconds: positive_integer, maxRetrySeconds: positive_integer,
  pollSeconds: positive_integer, taskTimeoutSeconds: positive_integer.max(86400),
}).refine(value => value.retrySeconds <= value.maxRetrySeconds && value.pollSeconds < value.taskTimeoutSeconds, 'Invalid retirement retry intervals')

export const content_preload_config_schema = z.object({
  enabled: boolean_value, deliveryVerified: boolean_value,
  sweepIntervalSeconds: positive_integer, scanLimit: positive_integer.max(20),
  leaseSeconds: positive_integer.max(3600), retrySeconds: positive_integer, maxRetrySeconds: positive_integer,
  pollSeconds: positive_integer, taskTimeoutSeconds: positive_integer.max(172800),
  taskClockSkewSeconds: positive_integer.max(300),
  dailyLimit: positive_integer, quotaReserve: z.number().int().nonnegative(),
  maxSubmissions: positive_integer.max(5), maxObjectBytes: positive_integer,
}).refine(value => value.leaseSeconds >= 180 && value.retrySeconds <= value.maxRetrySeconds && value.pollSeconds < value.taskTimeoutSeconds && value.taskClockSkewSeconds < value.retrySeconds,
  'Invalid preload lease or retry intervals')

export const background_runner_config_schema = z.object({
  mode: z.enum(['app', 'worker', 'disabled']),
  shutdownTimeoutMs: positive_integer.max(300000),
  // Capacities count concurrent bounded sweeps in this process.
  resources: z.object({ image: positive_integer.max(16), oss: positive_integer.max(16), esa: positive_integer.max(16), notification: positive_integer.max(16) }),
})

export const storage_audit_config_schema = z.object({
  enabled: boolean_value,
  sweepIntervalSeconds: positive_integer,
  cycleIntervalSeconds: positive_integer.min(3600),
  retrySeconds: positive_integer,
  leaseSeconds: positive_integer.min(180).max(3600),
  batchSize: positive_integer.max(100),
  batchBudgetMs: positive_integer.max(60000),
  orphanGraceSeconds: positive_integer.min(3600),
  orphanCleanup: z.object({
    enabled: boolean_value.default(false),
    minAgeSeconds: positive_integer.min(604800).default(604800),
    minObservations: positive_integer.min(2).default(2),
  }).prefault({}),
  staticKeys: z.array(z.string().regex(/^imgs\/[\w!./-]+$/).max(512)
    .refine(value => ! value.split('/').some(part => part === '.' || part === '..'))).max(1000),
}).refine(value => value.batchBudgetMs < value.leaseSeconds * 1000 && new Set(value.staticKeys).size === value.staticKeys.length, 'Invalid audit budget or duplicate static keys')

// The Aliyun destination stays separate from legacy S3 source locations.
// A null destination permits staging this release before credentials are ready.
export const aliyun_oss_config_schema = z.object({
  region: z.string().regex(/^oss-[a-z\d-]+$/),
  endpoint: z.url({ protocol: /^https$/ }).refine((value) => {
    try {
      const url = new URL(value)
      return ! url.username && ! url.password && ! url.search && ! url.hash && url.pathname === '/'
    }
    catch {
      return false
    }
  }, 'Use an HTTPS OSS API endpoint without credentials, path or query'),
  bucket: z.string().regex(/^[a-z\d][a-z\d-]{1,61}[a-z\d]$/),
  publicBaseUrl: z.url({ protocol: /^https$/ }),
  accessKeyId: required_string.refine(value => value !== '<required>' && value.trim() === value, 'Fill the OSS-specific credential'),
  accessKeySecret: required_string.refine(value => value !== '<required>' && value.trim() === value, 'Fill the OSS-specific credential'),
  timeoutMs: positive_integer.default(120_000),
  copyPartSizeMb: positive_integer.min(1).max(5120).default(64),
  uploadRoleArn: z.string().regex(/^acs:ram::\d+:role\/[\w/-]+$/).nullable().default(null),
})
export const image_processing_options_schema = z.strictObject({
  maxInputBytes: z.number().int().positive(), maxPixels: z.number().int().positive(),
  avifQuality: z.number().int().min(1).max(100), avifEffort: z.number().int().min(0).max(9),
  jpegQuality: z.number().int().min(1).max(100), jpegBackground: z.string().regex(/^#[0-9a-f]{6}$/i),
  lqipMaxDimension: z.number().int().positive(), lqipQuality: z.number().int().min(1).max(100),
  timeoutSeconds: z.number().int().positive(),
})
const content_images_config_schema = z.object({
  enabled: boolean_value, sweepIntervalSeconds: positive_integer, concurrency: positive_integer.max(4), scanLimit: positive_integer.max(100),
  leaseSeconds: positive_integer.max(600), heartbeatSeconds: positive_integer, profileVersion: positive_integer,
  profile: image_processing_options_schema,
}).refine(value => value.heartbeatSeconds < value.leaseSeconds, 'Image heartbeat must be shorter than its lease')

export const deployment_config_schema = z.object({
  db: database_config_schema,
  redis: redis_config_schema,
  mqtt: mqtt_config_schema,
  oss: z.object({
    buckets: z.object({
      public: public_bucket_config_schema,
      private: oss_bucket_config_schema.nullable().default(null),
    }),
  }).superRefine(({ buckets }, context) => {
    if (buckets.private && new URL(buckets.private.endpoint).origin === new URL(buckets.public.endpoint).origin && buckets.private.bucket === buckets.public.bucket)
      context.addIssue({ code: 'custom', path: ['buckets', 'private', 'bucket'], message: 'Private and public buckets must be distinct' })
  }).transform(value => ({ ... value.buckets.public, ... value })),
  aliyun: z.object({
    esa: aliyun_esa_config_schema.nullable().default(null),
    esaPurge: aliyun_esa_purge_config_schema.nullable().default(null),
    oss: aliyun_oss_config_schema.nullable().default(null),
    dypns: z.object({ endpoint: required_string, regionId: required_string, accessKeyId: required_string, accessKeySecret: required_string }),
    sms: z.object({ signName: required_string, templateCode: required_string, schemeName: required_string }),
    captcha: captcha_config_schema,
  }),
  site: site_config_schema,
  app: z.object({
    storageAudit: storage_audit_config_schema,
    contentMigration: z.object({ partSizeMb: positive_integer.min(5).max(5120) }).default({ partSizeMb: 8 }),
    contentSync: z.object({
      enabled: boolean_value, sweepIntervalSeconds: positive_integer, scanLimit: positive_integer.max(100),
      leaseSeconds: positive_integer, publishTimeoutMs: positive_integer, retrySeconds: positive_integer, maxRetrySeconds: positive_integer,
    }).refine(value => value.leaseSeconds * 1000 > value.publishTimeoutMs && value.maxRetrySeconds >= value.retrySeconds,
      'Content sync lease must exceed publish timeout and maximum retry must cover initial retry'),
    contentUploads: z.object({ enabled: boolean_value, sweepIntervalSeconds: positive_integer, scanLimit: positive_integer.max(100) }),
    contentImages: content_images_config_schema,
    contentRetirement: content_retirement_config_schema,
    contentPreload: content_preload_config_schema,
    backgroundRunner: background_runner_config_schema,
    auth: z.object({ jwt: z.object({ secret: z.string().min(32) }) }),
    otp: z.object({ debug: boolean_value }),
    captcha: z.object({ debug: boolean_value }),
  }),
})

// The browser-visible subset; parsing a full config strips every field not listed here.
export const public_config_schema = z.object({
  site: site_config_schema,
  oss: z.object({ buckets: z.object({ public: public_bucket_config_schema.pick({ publicBaseUrl: true }) }) }),
  mqtt: z.object({ web: mqtt_web_config_schema }),
  aliyun: z.object({ captcha: captcha_config_schema.pick({ appId: true }) }),
  app: z.object({ captcha: deployment_config_schema.shape.app.shape.captcha }),
})

// Build-time shape only; Nitro fills the real values at startup.
export const public_config_defaults = {
  site: { url: '', indexable: false },
  oss: { buckets: { public: { publicBaseUrl: '' } } },
  mqtt: { web: { wsUrl: '' } },
  aliyun: { captcha: { appId: '' } },
  app: { captcha: { debug: false } },
} satisfies z.input<typeof public_config_schema>
