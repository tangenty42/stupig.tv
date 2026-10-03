import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as load_dotenv } from 'dotenv'
import { parse as parse_yaml } from 'yaml'
import * as z from 'zod'

// 配置载体分工：YAML 管层次结构，.env 只管密钥（YAML 里用 ${VAR} 插值引用）。
// 生产环境 Nuxt 不会自动加载 .env，这里显式加载。
load_dotenv({ path: resolve(process.cwd(), '.env') })

const env_var_pattern = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g

// 递归替换字符串中的 ${VAR} / ${VAR:-default}。无默认值且未设置（或为空）的
// 变量替换为空串并记入 missing，由调用方决定是否致命：运行期（load_config）
// 必须报错，构建期（load_public_config）只要 public 白名单，缺密钥也得能出产物。
function interpolate(value: unknown, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(env_var_pattern, (match, name: string, fallback?: string) => {
      if (fallback !== undefined) {
        return process.env[name] ?? fallback
      }
      const env_value = process.env[name]
      if (! env_value) {
        missing.add(name)
        return ''
      }
      return env_value
    })
  }
  if (Array.isArray(value)) {
    return value.map(item => interpolate(item, missing))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, missing)]))
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

// 主机名等连接信息在 default.yaml 里用 ${VAR} 插值（无默认值）：构建机
// （Dockerfile/CI）没有 .env，未设置的变量插值为空串，所以这类字段只约束类型，
// 不能卡非空，否则镜像根本构建不出来。运行期不需要靠 schema 拦空值——load_config
// 的缺失检查（interpolate 记下的 missing_environment）会先一步报错。
const env_host = z.string()
const env_port = z.coerce.number()

const config_schema = z.object({
  db: z.object({
    host: env_host,
    // 端口走 ${VAR} 插值（见 development.yaml），interpolate 只产出字符串，故
    // coerce 归一为 number；以下各端口字段同理
    port: env_port,
    user: z.string().min(1),
    // 以下密钥类字段值来自 .env；缺失/为空由 load_config 统一报错（见 required 校验），
    // 构建期不校验，所以这里只约束类型
    password: z.string(),
    name: z.string().min(1),
  }),
  redis: z.object({
    host: env_host,
    port: env_port,
    password: z.string().optional(),
  }),
  mqtt: z.object({
    host: env_host,
    port: env_port,
    username: z.string().optional(),
    password: z.string().optional(),
    qos: z.number(),
    topicPrefix: z.string().min(1),
    clientIdPrefixServer: z.string().min(1),
    publishQueueSize: z.number().int().min(1),
    web: z.object({
      // 构建期为空串（见 env_host）；一旦有值，仍必须是合法的 ws/wss 地址
      wsUrl: z.union([z.literal(''), z.url({ protocol: /^wss?$/ })]),
      clientIdPrefix: z.string().min(1),
    }),
  }),
  oss: z.object({
    endpoint: z.string().min(1),
    region: z.string().min(1),
    bucket: z.string().min(1),
    accessKeyId: z.string(),
    accessKeySecret: z.string(),
    forcePathStyle: z.boolean(),
  }),
  aliyun: z.object({
    accessKeyId: z.string(),
    accessKeySecret: z.string(),
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
    url: z.url({ protocol: /^https?$/ }),
    indexable: z.boolean(),
    staticBaseUrl: z.string(),
  }),
  app: z.object({
    api: z.object({
      base: z.string(),
    }),
    auth: z.object({
      jwt: z.object({
        // 长度下限在 load_config 里校验（构建期密钥为空，schema 不能卡长度）
        secret: z.string(),
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

function load_layers(): { tree: unknown, missing_environment: Set<string> } {
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

  const missing_environment = new Set<string>()
  return { tree: interpolate(merged, missing_environment), missing_environment }
}

function parse_tree(tree: unknown): AppConfig {
  const result = config_schema.safeParse(tree)
  if (! result.success) {
    throw new Error(`Invalid configuration: ${result.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`)
  }
  return result.data
}

// 服务端运行时的唯一入口：密钥/连接信息缺失（含空值）或 JWT 过短都应在启动时
// 炸掉，而不是带病运行。刻意不做模块级 eager 导出：构建期工具只取 public 白名单，
// 不能因为构建机没有 .env 就加载失败。
export function load_config(): AppConfig {
  const { tree, missing_environment } = load_layers()
  if (missing_environment.size) {
    throw new Error(`.env 缺少必需的环境变量：${[... missing_environment].sort().join('、')}（config/*.yaml 通过插值引用它们）`)
  }
  const parsed = parse_tree(tree)
  if (parsed.app.auth.jwt.secret.length < 32) {
    throw new Error('JWT_SECRET 至少需要 32 个字符')
  }
  return parsed
}

// nuxt.config 专用：构建期只需要 runtimeConfig.public 白名单（其中不含任何密钥），
// 而构建机（Dockerfile/CI）没有 .env，所以这条路径不校验密钥与连接信息：${VAR}
// 无默认值的字段插值成空串也能出产物，空值由运行期的 load_config 拦截。客户端
// 可见的那部分来自 config/*.yaml 的字面量；唯一插值字段 mqtt.web.wsUrl 在容器启动
// 时由 NUXT_PUBLIC_MQTT_WEB_URL 覆盖（见 docker-compose.yml）。
export function load_public_config(): AppConfig {
  return parse_tree(load_layers().tree)
}

// 「构建期烘焙不了、必须运行期注入」的 public 白名单字段：键是 runtimeConfig.public 里的
// 名字，值是它必须等于什么——同一份 .env 推出的配置，也就是服务端自己在用的那份。
// 构建机没有 .env，这类字段在镜像里只能是空串，唯一来源是容器启动时的 NUXT_PUBLIC_<键>
// （见 docker-compose.yml）。server/plugins/public-config-guard.ts 在启动时按这张表断言，
// 所以以后白名单里再加 .env 插值的字段，只要在这里补一行就算接上了守卫。
export function runtime_injected_public(config: AppConfig): Record<string, unknown> {
  return {
    mqtt_web_url: config.mqtt.web.wsUrl,
  }
}
