import { resolve } from 'node:path'
import { config as load_dotenv } from 'dotenv'
import * as z from 'zod'

// Read .env in production — Nuxt only auto-loads it in dev mode.
load_dotenv({ path: resolve(process.cwd(), '.env') })

const env_schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number(),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  // Token lifetime in days. Kept numeric rather than a duration string so the
  // cross-field checks below can compare it with the windows defined relative to
  // it; sign_auth_token converts it to seconds for jsonwebtoken.
  JWT_EXPIRES_IN_DAYS: z.coerce.number().positive(),
  JWT_RENEW_BEFORE_DAYS: z.coerce.number().min(0),
  BCRYPT_ROUNDS: z.coerce.number(),
  ALIYUN_ACCESS_KEY_ID: z.string().min(1),
  ALIYUN_ACCESS_KEY_SECRET: z.string().min(1),
  ALIYUN_DYPNSAPI_ENDPOINT: z.string().min(1),
  ALIYUN_DYPNSAPI_REGION_ID: z.string().min(1),
  IDENTITY_COOKIE_NAME: z.string().min(1),
  IDENTITY_COOKIE_MAX_AGE_DAYS: z.coerce.number(),
  OTP_EXPIRES_MINUTES: z.coerce.number(),
  OTP_TIER1_DAILY_LIMIT: z.coerce.number(),
  OTP_TIER1_COOLDOWN_MS: z.coerce.number(),
  OTP_TIER2_DAILY_LIMIT: z.coerce.number(),
  OTP_TIER2_COOLDOWN_MS: z.coerce.number(),
  OTP_SMS_SIGN_NAME: z.string().min(1),
  OTP_SMS_TEMPLATE_CODE: z.string().min(1),
  OTP_SMS_SCHEME_NAME: z.string().optional(),
  OTP_DEBUG: z.string().optional()
    .transform(value => value === 'true'),
  CAPTCHA_APP_ID: z.string().optional(),
  CAPTCHA_APP_KEY: z.string().optional(),
  API_BASE: z.string(),
  COOKIE_MAX_AGE_DAYS: z.coerce.number(),
  // Idle window: a session survives this long without any request. There is no
  // absolute lifetime cap on top of it — an actively used session stays signed
  // in indefinitely.
  SESSION_MAX_AGE_DAYS: z.coerce.number(),
  // Upper bound on a session's live token generations. A client stuck on an
  // older generation is re-issued one on every authenticated request (the
  // presence ping polls continuously), so the family needs a ceiling.
  SESSION_MAX_TOKEN_GENERATIONS: z.coerce.number().int().min(1),
  COLOR_MODE_FALLBACK: z.enum(['light', 'dark']),
  COLOR_MODE_COOKIE_NAME: z.string().min(1),
  TIMEZONE_COOKIE_NAME: z.string().min(1),
  AUTH_TOKEN_COOKIE_NAME: z.string().min(1),
  AUTH_USER_COOKIE_NAME: z.string().min(1),
  SYNC_BROADCAST_CHANNEL_NAME: z.string().min(1),
  SYNC_CLIENT_ID_STORAGE_KEY: z.string().min(1),
  MAX_AVATAR_SIZE_MB: z.coerce.number(),
  MAX_CONTENT_ATTACHMENT_SIZE_MB: z.coerce.number(),
  CONTENT_STORY_TITLE_MAX_LENGTH: z.coerce.number().int().min(1).max(120),
  CONTENT_LINK_FILE_NAME_MAX_BYTES: z.coerce.number().int().min(1).max(255),
  CONTENT_STORY_LABEL_MAX_BYTES: z.coerce.number().int().min(1).max(255),
  CONTENT_STORY_DESC_MAX_BYTES: z.coerce.number().int().min(1).max(500),
  CONTENT_STORY_COVER_MAX_BYTES: z.coerce.number().int().min(1).max(255),
  // `markdown` is a mediumtext column (max 16,777,215 bytes).
  CONTENT_STORY_MARKDOWN_MAX_BYTES: z.coerce.number().int().min(1).max(16_777_215),
  CONTENT_DRAFT_SCHEMA_VERSION: z.coerce.number().int().positive(),
  CONTENT_DRAFT_STORAGE_PREFIX: z.string().min(1),
  CONTENT_DRAFT_AUTOSAVE_DELAY_MS: z.coerce.number().int().min(0).max(60_000),
  CONTENT_UPLOAD_HANDLE_STORAGE_NAME: z.string().min(1),
  // Lease on a scope's attachment-operation lock. Must outlive the slowest
  // structure change (a folder move rewrites every row beneath it one by one),
  // otherwise the lease expires mid-operation and a second request can steal it.
  CONTENT_OPERATION_LOCK_TTL_SECONDS: z.coerce.number().int().min(10),
  OSS_ENDPOINT: z.string().min(1),
  OSS_REGION: z.string().min(1),
  OSS_BUCKET: z.string().min(1),
  OSS_ACCESS_KEY_ID: z.string().min(1),
  OSS_ACCESS_KEY_SECRET: z.string().min(1),
  OSS_FORCE_PATH_STYLE: z.string().optional()
    .transform(value => value === 'true'),
  STATIC_BASE_URL: z.string(),
  SITE_URL: z.url(),
  SITE_INDEXABLE: z.string().optional()
    .transform(value => value !== 'false'),
  ONLINE_TIMEOUT_SECONDS: z.coerce.number(),
  PING_IDLE_INTERVAL_SECONDS: z.coerce.number(),
  POLL_INTERVAL_SECONDS: z.coerce.number(),
  BILIBILI_FETCH_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000),
  BILIBILI_CACHE_TTL_MS: z.coerce.number().int().min(0),
  BILIBILI_NEGATIVE_CACHE_TTL_MS: z.coerce.number().int().min(0),
  BILIBILI_FETCH_FAILURE_COOLDOWN_MS: z.coerce.number().int().min(0),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number(),
  REDIS_PASSWORD: z.string().optional(),
  MQTT_HOST: z.string().min(1),
  MQTT_PORT: z.coerce.number(),
  MQTT_WS_HOST: z.string().min(1),
  MQTT_WS_PORT: z.coerce.number(),
  MQTT_WSS_PORT: z.coerce.number(),
  MQTT_USERNAME: z.string().optional(),
  MQTT_PASSWORD: z.string().optional(),
  MQTT_QOS: z.coerce.number(),
  MQTT_TOPIC_PREFIX: z.string().min(1),
  MQTT_CLIENT_ID_PREFIX_SERVER: z.string().min(1),
  MQTT_CLIENT_ID_PREFIX_WEB: z.string().min(1),
})
  // The auth windows only work as a set. A token is renewed while it has
  // JWT_RENEW_BEFORE_DAYS left, so a user walks away holding between
  // JWT_RENEW_BEFORE_DAYS (worst case) and JWT_EXPIRES_IN_DAYS (best case) of
  // validity, and everything downstream has to outlive that. Messages name their
  // own field because the aggregated error only prints `message`, not `path`.
  .refine(value => value.JWT_RENEW_BEFORE_DAYS < value.JWT_EXPIRES_IN_DAYS, {
    message: 'JWT_RENEW_BEFORE_DAYS must be less than JWT_EXPIRES_IN_DAYS: a token that is always due for renewal is renewed on every request',
    path: ['JWT_RENEW_BEFORE_DAYS'],
  })
  .refine(value => value.COOKIE_MAX_AGE_DAYS >= value.JWT_EXPIRES_IN_DAYS, {
    message: 'COOKIE_MAX_AGE_DAYS must be >= JWT_EXPIRES_IN_DAYS, otherwise the cookie expires before the token it carries and the user is logged out early',
    path: ['COOKIE_MAX_AGE_DAYS'],
  })
  .refine(value => value.SESSION_MAX_AGE_DAYS > value.JWT_RENEW_BEFORE_DAYS, {
    message: 'SESSION_MAX_AGE_DAYS must exceed JWT_RENEW_BEFORE_DAYS, otherwise the idle window expires sessions before their token would be renewed',
    path: ['SESSION_MAX_AGE_DAYS'],
  })

const parsed_env = env_schema.safeParse(process.env)

if (! parsed_env.success) {
  throw new Error(`Invalid environment configuration: ${parsed_env.error.issues.map(issue => issue.message).join('; ')}`)
}

export const env = parsed_env.data
