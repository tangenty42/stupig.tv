import type * as z from 'zod'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as load_dotenv } from 'dotenv'
import { parse as parse_yaml } from 'yaml'
import { database_config_schema, deployment_config_schema, public_config_schema, settings_schema } from './schema'

export type { Settings } from './schema'

function environment() {
  load_dotenv({ path: resolve(process.cwd(), '.env'), quiet: true })
  return process.env
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

// Names that are not environment layers: the base layer and the development-only override.
const reserved_layer_names = new Set(['default', 'local'])

function read_yaml_config(node_env: string | undefined) {
  const file_names = ['default.yaml']
  const is_environment_layer = !! node_env && /^[a-z]+$/.test(node_env) && ! reserved_layer_names.has(node_env)
  if (is_environment_layer && existsSync(config_path(`${node_env}.yaml`))) {
    file_names.push(`${node_env}.yaml`)
  }
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

export function load_config(env = environment()) {
  const node_env = node_env_of(env)
  const settings = load_settings()
  const value = parse_config(deployment_config_schema, interpolate_config(read_yaml_config(node_env), env))
  if (node_env === 'production' && value.app.otp.debug) {
    throw new Error('Invalid configuration: app.otp.debug: OTP debug mode must be disabled in production')
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
