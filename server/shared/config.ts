import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as load_dotenv } from 'dotenv'
import { parse as parse_yaml } from 'yaml'
import * as z from 'zod'

// 配置载体分工：YAML 管层次结构，.env 只管密钥（YAML 里用 ${VAR} 插值引用）。
// 生产环境 Nuxt 不会自动加载 .env，这里显式加载。
load_dotenv({ path: resolve(process.cwd(), '.env') })

const env_var_pattern = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g

// 递归替换字符串中的 ${VAR} / ${VAR:-default}。引用了未设置且无默认值的环境
// 变量时直接抛错——密钥缺失应当在启动时炸掉，而不是带病运行。
function interpolate(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(env_var_pattern, (match, name: string, fallback?: string) => {
      const env_value = process.env[name]
      if (env_value === undefined) {
        if (fallback !== undefined) {
          return fallback
        }
        throw new Error(`YAML 配置引用了这个，不知何意味：${name} (${match})`)
      }
      return env_value
    })
  }
  if (Array.isArray(value)) {
    return value.map(interpolate)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item)]))
  }
  return value
}

// 深度合并：override 的非空对象递归覆盖 base，其余（含数组、null）整体替换。
function deep_merge(base: unknown, override: unknown): unknown {
  if (base !== null && override !== null && typeof base === 'object' && typeof override === 'object'
    && ! Array.isArray(base) && ! Array.isArray(override)) {
    const result: Record<string, unknown> = { ... base }
    for (const [key, value] of Object.entries(override)) {
      result[key] = key in result ? deep_merge(result[key], value) : value
    }
    return result
  }
  return override === undefined ? base : override
}

const config_schema = z.object({
  db: z.object({
    host: z.string().min(1),
    port: z.number(),
    user: z.string().min(1),
    password: z.string().min(1),
    name: z.string().min(1),
  }),
  redis: z.object({
    host: z.string().min(1),
    port: z.number(),
    password: z.string().optional(),
  }),
  mqtt: z.object({
    host: z.string().min(1),
    port: z.number(),
    username: z.string().optional(),
    password: z.string().optional(),
    qos: z.number(),
    topicPrefix: z.string().min(1),
    clientIdPrefixServer: z.string().min(1),
    publishQueueSize: z.number().int().min(1),
    web: z.object({
      wsHost: z.string().min(1),
      wsPort: z.number(),
      wssPort: z.number(),
      clientIdPrefix: z.string().min(1),
    }),
  }),
  oss: z.object({
    endpoint: z.string().min(1),
    region: z.string().min(1),
    bucket: z.string().min(1),
    accessKeyId: z.string().min(1),
    accessKeySecret: z.string().min(1),
    forcePathStyle: z.boolean(),
  }),
  aliyun: z.object({
    accessKeyId: z.string().min(1),
    accessKeySecret: z.string().min(1),
    dypns: z.object({
      endpoint: z.string().min(1),
      regionId: z.string().min(1),
    }),
    sms: z.object({
      signName: z.string().min(1),
      templateCode: z.string().min(1),
      schemeName: z.string().optional(),
    }),
    captcha: z.object({
      appId: z.string().optional(),
      appKey: z.string().optional(),
    }),
  }),
  site: z.object({
    url: z.url(),
    indexable: z.boolean(),
    staticBaseUrl: z.string(),
  }),
  app: z.object({
    api: z.object({
      base: z.string(),
    }),
    auth: z.object({
      jwt: z.object({
        secret: z.string().min(32),
        expiresInDays: z.number().positive(),
        renewBeforeDays: z.number().min(0),
      }),
      session: z.object({
        maxAgeDays: z.number(),
        maxTokenGenerations: z.number().int().min(1),
      }),
      cookie: z.object({
        maxAgeDays: z.number(),
        tokenName: z.string().min(1),
        userName: z.string().min(1),
      }),
      bcryptRounds: z.number(),
    }),
    otp: z.object({
      expiresMinutes: z.number(),
      debug: z.boolean(),
      tier1: z.object({
        dailyLimit: z.number(),
        cooldownMs: z.number(),
      }),
      tier2: z.object({
        dailyLimit: z.number(),
        cooldownMs: z.number(),
      }),
    }),
    identity: z.object({
      cookieName: z.string().min(1),
      cookieMaxAgeDays: z.number(),
    }),
    colorMode: z.object({
      fallback: z.enum(['light', 'dark']),
      cookieName: z.string().min(1),
    }),
    timezone: z.object({
      cookieName: z.string().min(1),
    }),
    sync: z.object({
      broadcastChannelName: z.string().min(1),
      clientIdStorageKey: z.string().min(1),
    }),
    online: z.object({
      timeoutSeconds: z.number(),
      pingIdleIntervalSeconds: z.number(),
      pollIntervalSeconds: z.number(),
    }),
    avatar: z.object({
      maxSizeMb: z.number().positive(),
    }),
    content: z.object({
      story: z.object({
        titleMaxLength: z.number().int().min(1).max(120),
        labelMaxBytes: z.number().int().min(1).max(255),
        descMaxBytes: z.number().int().min(1).max(500),
        coverMaxBytes: z.number().int().min(1).max(255),
        markdownMaxBytes: z.number().int().min(1).max(16_777_215),
      }),
      link: z.object({
        fileNameMaxBytes: z.number().int().min(1).max(255),
      }),
      draft: z.object({
        schemaVersion: z.number().int().positive(),
        storagePrefix: z.string().min(1),
        autosaveDelayMs: z.number().int().min(0).max(60_000),
      }),
      upload: z.object({
        handleStorageName: z.string().min(1),
      }),
      redact: z.object({
        maxDimension: z.number().int().min(1),
      }),
      operationLock: z.object({
        ttlSeconds: z.number().int().min(10),
      }),
      encrypt: z.object({
        maxSizeMb: z.number(),
      }),
      bilibili: z.object({
        fetchTimeoutMs: z.number().int().min(500).max(30_000),
        cacheTtlMs: z.number().int().min(0),
        negativeCacheTtlMs: z.number().int().min(0),
        fetchFailureCooldownMs: z.number().int().min(0),
      }),
    }),
  }),
})
  // 认证时间窗必须作为整体自洽：token 在剩余 renewBeforeDays 时换发，用户实际
  // 持有 renewBeforeDays（最坏）到 expiresInDays（最好）之间的有效期，下游一切
  // 存活期都要覆盖它。错误消息自带字段名，因为聚合错误只打印 message 不打印 path。
  .refine(value => value.app.auth.jwt.renewBeforeDays < value.app.auth.jwt.expiresInDays, {
    message: 'app.auth.jwt.renewBeforeDays must be less than expiresInDays: a token that is always due for renewal is renewed on every request',
  })
  .refine(value => value.app.auth.cookie.maxAgeDays >= value.app.auth.jwt.expiresInDays, {
    message: 'app.auth.cookie.maxAgeDays must be >= jwt.expiresInDays, otherwise the cookie expires before the token it carries and the user is logged out early',
  })
  .refine(value => value.app.auth.session.maxAgeDays > value.app.auth.jwt.renewBeforeDays, {
    message: 'app.auth.session.maxAgeDays must exceed jwt.renewBeforeDays, otherwise the idle window expires sessions before their token would be renewed',
  })

export type AppConfig = z.infer<typeof config_schema>

export function load_config(): AppConfig {
  const env_name = process.env.NODE_ENV ?? 'development'
  const config_dir = resolve(process.cwd(), 'config')

  let merged: unknown = {}
  // local.yaml：可选的本机覆盖（gitignore，不进仓库），优先级最高——
  // 用于开发者的本地环境差异（如 Windows 本地 MySQL/Redis/EMQX 指向 127.0.0.1）。
  for (const file of ['default.yaml', `${env_name}.yaml`, 'local.yaml']) {
    const path = resolve(config_dir, file)
    if (! existsSync(path)) {
      continue
    }
    const parsed: unknown = parse_yaml(readFileSync(path, 'utf-8'))
    if (parsed !== null && parsed !== undefined) {
      merged = deep_merge(merged, parsed)
    }
  }

  const result = config_schema.safeParse(interpolate(merged))
  if (! result.success) {
    throw new Error(`Invalid configuration: ${result.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`)
  }
  return result.data
}

export const config = load_config()
