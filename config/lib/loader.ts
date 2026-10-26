import type * as z from 'zod'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parse_yaml } from 'yaml'
import { load_environment } from './environment.mjs'
import { aliyun_oss_config_schema, database_config_schema, deployment_config_schema, image_processing_options_schema, oss_bucket_config_schema, public_config_schema, settings_schema } from './schema'

export type { Settings } from './schema'

function environment(): NodeJS.ProcessEnv {
  return load_environment()
}

function parse_config<Output>(schema: z.ZodType<Output>, input: unknown, path_prefix = ''): Output {
  const result = schema.safeParse(input)
  if (! result.success) {
    throw new Error(`Invalid configuration: ${result.error.issues.map(issue => `${[path_prefix, ... issue.path].filter(Boolean).join('.')}: ${issue.message}`).join('; ')}`)
  }
  return result.data
}

function is_config_object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && ! Array.isArray(value)
}

function merge_config_layer(base: unknown, override: unknown): unknown {
  if (! is_config_object(override)) {
    return override
  }

  const result = is_config_object(base) ? { ... base } : {}
  for (const [key, value] of Object.entries(override)) {
    result[key] = is_config_object(value) ? merge_config_layer(result[key], value) : value
  }
  return result
}

type MergedConfig<Base, Override> = Base extends Record<string, unknown>
  ? Override extends Record<string, unknown>
    ? {
        [Key in keyof Base | keyof Override]: Key extends keyof Override
          ? Key extends keyof Base ? MergedConfig<Base[Key], Override[Key]> : Override[Key]
          : Key extends keyof Base ? Base[Key] : never
      }
    : Override
  : Override

export function merge_config_layers<Base, Override>(base: Base, override: Override): MergedConfig<Base, Override>
export function merge_config_layers(... layers: unknown[]): unknown
export function merge_config_layers(... layers: unknown[]): unknown {
  return layers.reduce<unknown>((merged, layer) => merge_config_layer(merged, layer), {})
}

export function interpolate_config(value: unknown, env: NodeJS.ProcessEnv, path = 'config'): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z_][A-Z\d_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
      const environment_value = env[name]
      if (environment_value !== undefined && (environment_value !== '' || fallback === undefined)) {
        return environment_value
      }
      if (fallback !== undefined) {
        return fallback
      }
      throw new Error(`Missing environment variable ${name} referenced at ${path}`)
    })
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => interpolate_config(item, env, `${path}[${index}]`))
  }
  if (is_config_object(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate_config(item, env, `${path}.${key}`)]))
  }
  return value
}

function config_path(file_name: string) {
  return resolve(process.cwd(), 'config', file_name)
}

function read_yaml(file_name: string) {
  const layer = parse_yaml(readFileSync(config_path(file_name), 'utf8'))
  if (! is_config_object(layer)) {
    throw new Error(`Invalid configuration file ${file_name}: expected a YAML mapping`)
  }
  return layer
}

export function load_settings() {
  return parse_config(settings_schema, read_yaml('app-settings.yaml'), 'settings')
}

function node_env_of(env: NodeJS.ProcessEnv) {
  return env.NODE_ENV ?? process.env.NODE_ENV
}

function read_yaml_config(node_env: string | undefined) {
  if (node_env !== 'development' && node_env !== 'production')
    throw new Error('Invalid NODE_ENV: expected development or production to select dev.yaml or prod.yaml')
  const file_names = ['shared.yaml', node_env === 'development' ? 'dev.yaml' : 'prod.yaml']
  if (node_env === 'development' && existsSync(config_path('local.yaml'))) {
    file_names.push('local.yaml')
  }

  return merge_config_layers(... file_names.map(read_yaml))
}

export function load_database_config(env = environment()) {
  const merged_config = read_yaml_config(node_env_of(env))
  const db = interpolate_config(is_config_object(merged_config) ? merged_config.db : undefined, env, 'db')
  return parse_config(database_config_schema, db, 'db')
}

// Migration scripts load OSS only when requested, without JWT/MQTT/SMS secrets.
export function load_aliyun_oss_config(env = environment()) {
  const merged = read_yaml_config(node_env_of(env))
  const aliyun = is_config_object(merged) ? merged.aliyun : undefined
  const oss = is_config_object(aliyun) ? aliyun.oss : undefined
  return parse_config(aliyun_oss_config_schema.nullable(), interpolate_config(oss, env, 'aliyun.oss'), 'aliyun.oss')
}

export function load_migration_source_config(bucket: 'public' | 'private', env = environment()) {
  const merged = read_yaml_config(node_env_of(env))
  const oss = is_config_object(merged) && is_config_object(merged.oss) ? merged.oss : undefined
  const buckets = oss && is_config_object(oss.buckets) ? oss.buckets : undefined
  return parse_config(oss_bucket_config_schema, interpolate_config(buckets?.[bucket], env, `oss.buckets.${bucket}`), `oss.buckets.${bucket}`)
}

export function load_migration_image_profile(env = environment()) {
  const merged = read_yaml_config(node_env_of(env))
  const app = is_config_object(merged) && is_config_object(merged.app) ? merged.app : undefined
  const images = app && is_config_object(app.contentImages) ? app.contentImages : undefined
  return {
    profile: parse_config(image_processing_options_schema, interpolate_config(images?.profile, env, 'app.contentImages.profile'), 'app.contentImages.profile'),
    profile_version: parse_config(deployment_config_schema.shape.app.shape.contentImages.shape.profileVersion, interpolate_config(images?.profileVersion, env, 'app.contentImages.profileVersion'), 'app.contentImages.profileVersion'),
  }
}

export function load_content_migration_options(env = environment()) {
  const merged = read_yaml_config(node_env_of(env))
  const app = is_config_object(merged) && is_config_object(merged.app) ? merged.app : undefined
  return parse_config(deployment_config_schema.shape.app.shape.contentMigration, interpolate_config(app?.contentMigration, env, 'app.contentMigration'), 'app.contentMigration')
}

// Read only this raw subtree: development tools must not require application secrets.
export function load_development_tunnel_layer() {
  const merged_config = read_yaml_config('development')
  if (! is_config_object(merged_config) || ! is_config_object(merged_config.devAuthTunnel))
    return undefined
  const esa = merged_config.esaFunction
  return { ... merged_config.devAuthTunnel, callbackUrl: is_config_object(esa) ? esa.callbackUrl : undefined }
}

// Publish tools do not need database, JWT, OSS or tunnel credentials.
export function load_esa_function_layer(node_env: string): Record<string, unknown> | undefined {
  const merged = read_yaml_config(node_env)
  if (! is_config_object(merged))
    return undefined
  const aliyun = merged.aliyun
  const delivery = is_config_object(aliyun) && is_config_object(aliyun.esa) ? aliyun.esa : {}
  return {
    ... (is_config_object(merged.esaFunction) ? merged.esaFunction : {}),
    deliveryUrl: delivery.baseUrl,
    authKey: delivery.authKey,
  }
}

export function load_config(env = environment()) {
  const node_env = node_env_of(env)
  const settings = load_settings()
  const deployment = read_yaml_config(node_env)
  // Tool credentials are validated by their launchers, not by app startup.
  if (is_config_object(deployment)) {
    delete deployment.devAuthTunnel
    delete deployment.esaFunction
  }
  const value = parse_config(deployment_config_schema, interpolate_config(deployment, env))
  for (const kind of ['otp', 'captcha'] as const) {
    if (node_env !== 'development' && value.app[kind].debug) {
      throw new Error(`Invalid configuration: app.${kind}.debug: debug mode is only allowed in development`)
    }
  }

  return merge_config_layers(settings, value)
}

export type AppConfig = ReturnType<typeof load_config>

export function public_config_from(config: AppConfig) {
  return parse_config(public_config_schema, config)
}

let runtime_config_cache: AppConfig | undefined

export function runtime_config() {
  return runtime_config_cache ??= load_config()
}
