import { resolve } from 'node:path'
import { config as load_dotenv } from 'dotenv'
import * as z from 'zod'

// Read .env in production — Nuxt only auto-loads it in dev mode.
load_dotenv({ path: resolve(process.cwd(), '.env') })

const env_schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DB_HOST: z.string().min(1, 'DB_HOST is required'),
  DB_PORT: z.coerce.number(),
  DB_USER: z.string().min(1, 'DB_USER is required'),
  DB_PASSWORD: z.string().min(1, 'DB_PASSWORD is required'),
  DB_NAME: z.string().min(1, 'DB_NAME is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string(),
  BCRYPT_ROUNDS: z.coerce.number(),
  ALIYUN_ACCESS_KEY_ID: z.string().min(1, 'ALIYUN_ACCESS_KEY_ID is required'),
  ALIYUN_ACCESS_KEY_SECRET: z.string().min(1, 'ALIYUN_ACCESS_KEY_SECRET is required'),
  ALIYUN_DYPNSAPI_ENDPOINT: z.string().min(1),
  ALIYUN_DYPNSAPI_REGION_ID: z.string().min(1),
  IDENTITY_COOKIE_NAME: z.string().min(1),
  IDENTITY_COOKIE_MAX_AGE_DAYS: z.coerce.number(),
  OTP_EXPIRES_MINUTES: z.coerce.number(),
  OTP_TIER1_DAILY_LIMIT: z.coerce.number(),
  OTP_TIER1_COOLDOWN_MS: z.coerce.number(),
  OTP_TIER2_DAILY_LIMIT: z.coerce.number(),
  OTP_TIER2_COOLDOWN_MS: z.coerce.number(),
  OTP_SMS_SIGN_NAME: z.string().min(1, 'OTP_SMS_SIGN_NAME is required'),
  OTP_SMS_TEMPLATE_CODE: z.string().min(1, 'OTP_SMS_TEMPLATE_CODE is required'),
  OTP_SMS_SCHEME_NAME: z.string().optional(),
  OTP_DEBUG: z.string().optional()
    .transform(value => value === 'true'),
  CAPTCHA_APP_ID: z.string().optional(),
  CAPTCHA_APP_KEY: z.string().optional(),
  API_BASE: z.string(),
  COOKIE_MAX_AGE_DAYS: z.coerce.number(),
  SESSION_MAX_AGE_DAYS: z.coerce.number(),
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
  STATIC_ROOT: z.string().min(1),
  STATIC_BASE_URL: z.string(),
  ONLINE_TIMEOUT_SECONDS: z.coerce.number(),
  PING_IDLE_INTERVAL_SECONDS: z.coerce.number(),
  POLL_INTERVAL_SECONDS: z.coerce.number(),
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

const parsed_env = env_schema.safeParse(process.env)

if (! parsed_env.success) {
  throw new Error(`Invalid environment configuration: ${parsed_env.error.issues.map(issue => issue.message).join('; ')}`)
}

export const env = parsed_env.data
