import type { EsaFunctionVariables } from '../../config/esa/content-auth.mjs'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import { interpolate_config, load_esa_function_layer } from '../../config/lib/loader'

export class PublishError extends Error {}

const schema = z.strictObject({
  name: z.string().regex(/^[a-z\d][a-z\d-]{1,99}$/),
  entry: z.string().min(1),
  environment: z.enum(['production', 'staging']),
  siteId: z.string(),
  regionId: z.literal('cn-hangzhou'),
  endpoint: z.literal('esa.cn-hangzhou.aliyuncs.com'),
  accessKeyId: z.string(),
  accessKeySecret: z.string(),
  authKey: z.string(),
  deliveryUrl: z.string().url(),
  callbackUrl: z.string().url(),
  timeoutMs: z.coerce.number().int().min(1000).max(60000),
  readinessTimeoutMs: z.coerce.number().int().min(1000).max(600000),
  authTimeoutMs: z.coerce.number().int().min(1).max(15000),
})

export type PublishConfig = z.infer<typeof schema> & { appEnvironment: 'dev' | 'prod' }

export function configured(value: string) {
  return Boolean(value.trim()) && ! /<[^>]*>|\$\{/.test(value)
}

export function parse_publish_config(input: unknown, env: NodeJS.ProcessEnv, cwd = process.cwd()): PublishConfig {
  const result = schema.safeParse(interpolate_config(input, env, 'esaFunction'))
  if (! result.success)
    throw new PublishError(`Invalid esaFunction configuration: ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`)
  if (! ['development', 'production'].includes(env.NODE_ENV ?? ''))
    throw new PublishError('Select --env=dev or --env=prod')
  const config = result.data
  const entry = resolve(cwd, config.entry)
  const path = relative(cwd, entry)
  if (isAbsolute(config.entry) || path.startsWith('..') || isAbsolute(path) || ! path.endsWith('.mjs'))
    throw new PublishError('esaFunction.entry must be an .mjs file within the repository')
  const callback = new URL(config.callbackUrl)
  const delivery = new URL(config.deliveryUrl)
  for (const url of [callback, delivery]) {
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port)
      throw new PublishError('ESA callback/delivery must be HTTPS URLs without credentials, query, fragment or custom port')
  }
  if (callback.pathname !== '/api/content/authorize' || delivery.pathname !== '/' || callback.origin === delivery.origin)
    throw new PublishError('Invalid ESA callback path or delivery origin; callback must not loop into delivery')
  return { ... config, entry, appEnvironment: env.NODE_ENV === 'production' ? 'prod' : 'dev' }
}

export function load_publish_config(env = process.env) {
  const node_env = env.NODE_ENV ?? ''
  const selected = load_esa_function_layer(node_env)
  const other = load_esa_function_layer(node_env === 'production' ? 'development' : 'production')
  if (selected?.name === other?.name || selected?.deliveryUrl === other?.deliveryUrl)
    throw new PublishError('dev/prod must use different ESA function names and delivery origins')
  return parse_publish_config(selected, env)
}

export function require_publish_credentials(config: PublishConfig) {
  for (const key of ['accessKeyId', 'accessKeySecret', 'authKey', 'siteId'] as const) {
    if (! configured(config[key]))
      throw new PublishError(`Missing esaFunction.${key}; configure .env.${config.appEnvironment}`)
  }
  if (! /^\d+$/.test(config.siteId))
    throw new PublishError('Invalid esaFunction.siteId')
  if (! /^[\x21-\x7E]{32,128}$/.test(config.authKey))
    throw new PublishError('Invalid aliyun.esa.authKey: expected 32–128 printable ASCII characters without spaces')
}

/** Names must stay in sync with the `env` contract in config/esa/content-auth.mjs. */
export function publish_variables(config: PublishConfig): Record<keyof EsaFunctionVariables, { Type: 'secret_text' | 'plain_text', Value: string }> {
  return {
    ALIYUN_ESA_AUTH_KEY: { Type: 'secret_text', Value: config.authKey },
    CONTENT_AUTH_URL: { Type: 'plain_text', Value: config.callbackUrl },
    CONTENT_AUTH_TIMEOUT_MS: { Type: 'plain_text', Value: String(config.authTimeoutMs) },
  }
}

export function publish_plan(config: PublishConfig) {
  return {
    application: config.appEnvironment,
    function: config.name,
    environment: config.environment,
    siteId: configured(config.siteId) ? config.siteId : '(missing)',
    entry: relative(process.cwd(), config.entry),
    callbackUrl: config.callbackUrl,
    deliveryUrl: config.deliveryUrl,
    credentialsConfigured: configured(config.accessKeyId) && configured(config.accessKeySecret),
    authKeyConfigured: configured(config.authKey),
    routeRule: `(http.host eq "${new URL(config.deliveryUrl).hostname}" and starts_with(http.request.uri, "/content/"))`,
    routeFlags: { RouteEnable: 'on', Bypass: 'on', Fallback: 'off' },
  }
}
