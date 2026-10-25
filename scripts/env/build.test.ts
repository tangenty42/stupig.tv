import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parse_dotenv } from 'dotenv'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { environment_from_argv, missing_required_keys, sync_env_files, sync_summary } from './build'

describe('sync_env_files', () => {
  let directory: string
  let shared_path: string
  let environment_path: string
  let env_path: string
  let template_paths: string[]

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'stupig-env-sync-'))
    shared_path = join(directory, '.env.shared.layer')
    environment_path = join(directory, '.env.dev.layer')
    env_path = join(directory, '.env.dev')
    template_paths = [shared_path, environment_path]
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it.each(['dev', 'prod'] as const)('uses .env.%s for default helper paths and never creates legacy .env', (environment) => {
    const prod_path = join(directory, '.env.prod.layer')
    writeFileSync(shared_path, 'SECRET=<required>\n')
    writeFileSync(environment_path, 'SIDE=dev\n')
    writeFileSync(prod_path, 'SIDE=prod\n')
    const paths = [... template_paths, prod_path]
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory)
    try {
      sync_env_files(paths, undefined, {}, environment)
      expect(missing_required_keys(paths, undefined, environment)).toEqual(['SECRET'])
      sync_env_files(paths, undefined, { SECRET: 'filled' }, environment)
      expect(parse_dotenv(readFileSync(join(directory, `.env.${environment}`), 'utf8'))).toEqual({ SECRET: 'filled', SIDE: environment })
      expect(missing_required_keys(paths, undefined, environment)).toEqual([])
      expect(existsSync(join(directory, '.env'))).toBe(false)
    }
    finally { cwd.mockRestore() }
  })

  // Exercise the shipped templates through the real builder: both deployment
  // environments request current OSS credentials without the retired S3 keys.
  it.each(['dev', 'prod'] as const)('reserves current OSS credentials in the shipped %s templates', (environment) => {
    const paths = ['shared', 'dev', 'prod'].map(tag => join(process.cwd(), `.env.${tag}.layer`))
    const credentials = {
      ALIYUN_OSS_ACCESS_KEY_ID: 'aliyun-id',
      ALIYUN_OSS_ACCESS_KEY_SECRET: 'aliyun-secret',
      ALIYUN_ESA_AUTH_KEY: 'a1'.repeat(32),
    }
    const result = sync_env_files(paths, env_path, {}, environment)
    expect(result.required).toEqual(expect.arrayContaining(Object.keys(credentials)))
    expect(result.required.some(key => /^OSS_(?:PUBLIC|PRIVATE)_/.test(key))).toBe(false)
    expect(missing_required_keys(paths, env_path, environment)).toEqual(expect.arrayContaining(Object.keys(credentials)))
    sync_env_files(paths, env_path, credentials, environment)
    const filled = readFileSync(env_path, 'utf8')
    for (const [key, value] of Object.entries(credentials))
      expect(filled).toContain(`${key}="${value}"`)
    for (const key of Object.keys(credentials))
      expect(missing_required_keys(paths, env_path, environment)).not.toContain(key)
    sync_env_files(paths, env_path, {}, environment)
    expect(readFileSync(env_path, 'utf8')).toBe(filled)
  })

  it('rebuilds the template with existing values and moves local-only keys to the end', () => {
    writeFileSync(shared_path, '# Application\nSECRET=example-secret\n')
    writeFileSync(environment_path, '# MQTT / EMQX\n# Browser WebSocket URL\nMQTT_WEB_URL=ws://localhost:8083/mqtt\nNEW_KEY=sample\n')
    writeFileSync(env_path, '# Old comment\nMQTT_WEB_URL="wss://local.example/mqtt"\nSECRET=actual-secret\nLOCAL_ONLY=value\n')

    const result = sync_env_files(template_paths, env_path)
    const synced = readFileSync(env_path, 'utf8')

    expect(result).toEqual({ created: false, added: ['NEW_KEY'], unknown: ['LOCAL_ONLY'], overridden: ['SECRET', 'MQTT_WEB_URL'], required: [] })
    expect(synced).toBe('# Application\nSECRET="actual-secret"\n\n# MQTT / EMQX\n# Browser WebSocket URL\nMQTT_WEB_URL="wss://local.example/mqtt"\nNEW_KEY="sample"\n\n# Local-only keys preserved by pnpm env:build\nLOCAL_ONLY="value"\n')
    expect(JSON.stringify(result)).not.toContain('actual-secret')
  })

  it('is idempotent and preserves comments for local-only keys', () => {
    writeFileSync(shared_path, 'SECRET=example\n')
    writeFileSync(environment_path, 'MQTT_WEB_URL=ws://localhost:8083/mqtt\n')
    writeFileSync(env_path, '# Private setting\nLOCAL_ONLY=value\nMQTT_WEB_URL=ws://local.example/mqtt\nSECRET=actual\n')

    sync_env_files(template_paths, env_path)
    const synced = readFileSync(env_path, 'utf8')

    expect(sync_env_files(template_paths, env_path).added).toEqual([])
    expect(readFileSync(env_path, 'utf8')).toBe(synced)
    expect(synced).toContain('# Private setting\nLOCAL_ONLY="value"\n')
  })

  it('creates a missing .env.dev from the merged templates', () => {
    writeFileSync(shared_path, '# Shared\nSECRET=<replace-me>\n')
    writeFileSync(environment_path, '# Environment\nMQTT_WEB_URL=ws://localhost:8083/mqtt\n')

    expect(sync_env_files(template_paths, env_path)).toEqual({ created: true, added: ['SECRET', 'MQTT_WEB_URL'], unknown: [], overridden: [], required: [] })
    expect(readFileSync(env_path, 'utf8')).toBe('# Shared\nSECRET="<replace-me>"\n\n# Environment\nMQTT_WEB_URL="ws://localhost:8083/mqtt"\n')
  })

  it('refuses duplicate keys instead of choosing one value silently', () => {
    writeFileSync(shared_path, 'SECRET=example\n')
    writeFileSync(environment_path, 'MQTT_WEB_URL=ws://localhost:8083/mqtt\n')
    const original = 'SECRET=first\nSECRET=second\n'
    writeFileSync(env_path, original)

    expect(() => sync_env_files(template_paths, env_path)).toThrow(/Duplicate environment key SECRET/)
    expect(readFileSync(env_path, 'utf8')).toBe(original)
  })

  it('collapses keys repeated across templates to the first occurrence', () => {
    writeFileSync(shared_path, 'SECRET=shared-default\n')
    writeFileSync(environment_path, 'SECRET=dev-default\n')
    writeFileSync(env_path, 'SECRET=actual\n')

    const result = sync_env_files(template_paths, env_path)
    expect(result.added).toEqual([])
    expect(readFileSync(env_path, 'utf8')).toBe('SECRET="actual"\n')
  })

  it('uses the synced environment default for a missing repeated key', () => {
    writeFileSync(shared_path, 'SECRET=shared-default\n')
    writeFileSync(environment_path, 'SECRET=dev-default\n')
    writeFileSync(env_path, '# no keys yet\n')

    sync_env_files(template_paths, env_path, {}, 'dev')
    expect(readFileSync(env_path, 'utf8')).toBe('SECRET="dev-default"\n')
  })

  it('omits other environment templates entirely', () => {
    const prod_path = join(directory, '.env.prod.layer')
    writeFileSync(shared_path, 'SECRET=shared-default\n')
    writeFileSync(environment_path, '# MQTT / EMQX\n# Browser WebSocket URL\nMQTT_WEB_URL=ws://localhost:8083/mqtt\n')
    writeFileSync(prod_path, '# MQTT / EMQX\n# 反代+SSL 后的完整地址\nMQTT_WEB_URL=<required>\nACR_IMAGE=<required>\n')
    writeFileSync(env_path, 'MQTT_WEB_URL=ws://local.example/mqtt\n')

    const paths = [shared_path, environment_path, prod_path]
    const result = sync_env_files(paths, env_path)

    expect(result).toEqual({ created: false, added: ['SECRET'], unknown: [], overridden: ['MQTT_WEB_URL'], required: [] })
    const synced = readFileSync(env_path, 'utf8')
    expect(synced).toBe('SECRET="shared-default"\n\n# MQTT / EMQX\n# Browser WebSocket URL\nMQTT_WEB_URL="ws://local.example/mqtt"\n')
    expect(synced.match(/MQTT_WEB_URL/g)).toHaveLength(1)
    expect(synced).not.toContain('ACR_IMAGE')
    expect(synced).not.toContain('反代+SSL')
  })

  it('prompts only for required keys of the synced environment', () => {
    const prod_path = join(directory, '.env.prod.layer')
    writeFileSync(shared_path, 'SECRET=<required>\n')
    writeFileSync(environment_path, 'MQTT_WEB_URL=ws://localhost:8083/mqtt\n')
    writeFileSync(prod_path, 'ACR_IMAGE=<required>\n')
    writeFileSync(env_path, 'MQTT_WEB_URL=ws://local.example/mqtt\n')

    const paths = [shared_path, environment_path, prod_path]
    expect(missing_required_keys(paths, env_path, 'dev')).toEqual(['SECRET'])
    expect(missing_required_keys(paths, env_path, 'prod')).toEqual(['SECRET', 'ACR_IMAGE'])
  })

  it('fills missing required keys from provided values and reports the rest', () => {
    writeFileSync(shared_path, 'SECRET=<required>\nOTHER=<required>\n')
    writeFileSync(environment_path, 'MQTT_WEB_URL=ws://localhost:8083/mqtt\n')
    writeFileSync(env_path, 'MQTT_WEB_URL=ws://local.example/mqtt\n')

    expect(missing_required_keys(template_paths, env_path)).toEqual(['SECRET', 'OTHER'])

    const result = sync_env_files(template_paths, env_path, { SECRET: 'entered-value' })
    const synced = readFileSync(env_path, 'utf8')

    expect(result.added).toEqual(['SECRET', 'OTHER'])
    expect(result.required).toEqual(['OTHER'])
    expect(synced).toBe('SECRET="entered-value"\nOTHER="<required>"\n\nMQTT_WEB_URL="ws://local.example/mqtt"\n')
  })

  it.each([
    'prefix#suffix', '#starts-with-comment', 'with spaces', ' padded ',
    'double"quote#hash', 'single\'quote#hash', 'backtick`quote#hash',
    String.raw`literal\n#hash`, 'first\nsecond', 'dollar$and#hash',
  ])('preserves CLI input through dotenv parsing and repeat sync (%#)', (secret) => {
    writeFileSync(shared_path, 'SECRET=<required>\n')
    writeFileSync(environment_path, '')
    writeFileSync(env_path, 'SECRET=<required>\n')
    sync_env_files(template_paths, env_path, { SECRET: secret })
    const written = readFileSync(env_path, 'utf8')
    expect(parse_dotenv(written).SECRET).toBe(secret)
    expect(missing_required_keys(template_paths, env_path)).toEqual([])
    sync_env_files(template_paths, env_path)
    expect(readFileSync(env_path, 'utf8')).toBe(written)
  })

  it('rejects unrepresentable input before writing and without exposing it', () => {
    writeFileSync(shared_path, 'SECRET=<required>\n')
    writeFileSync(environment_path, '')
    const before = 'SECRET=<required>\n'
    writeFileSync(env_path, before)
    const secret = 'private\0value'
    expect(() => sync_env_files(template_paths, env_path, { SECRET: secret })).toThrow('Cannot safely serialize input for SECRET; target file was not changed')
    expect(readFileSync(env_path, 'utf8')).toBe(before)
  })

  it('formats existing values with double quotes, preserving literal escapes and quoted placeholders', () => {
    writeFileSync(shared_path, 'SECRET=<required>\nOTHER=<required>\n')
    writeFileSync(environment_path, '')
    writeFileSync(env_path, 'SECRET=\'kept#secret\'\nOTHER="<required>"\n# Keep this note\nLOCAL_ONLY=\'literal\\n#value\'\nEMPTY=\n')
    const before = parse_dotenv(readFileSync(env_path, 'utf8'))
    expect(missing_required_keys(template_paths, env_path)).toEqual(['OTHER'])
    sync_env_files(template_paths, env_path)
    const output = readFileSync(env_path, 'utf8')
    expect(parse_dotenv(output)).toEqual(before)
    expect(output).toContain('SECRET="kept#secret"')
    expect(output).toContain('EMPTY=""')
    expect(output).toContain('# Keep this note\nLOCAL_ONLY=\'literal\\n#value\'')
    expect(missing_required_keys(template_paths, env_path)).toEqual(['OTHER'])
    sync_env_files(template_paths, env_path, { OTHER: 'filled#value' })
    expect(parse_dotenv(readFileSync(env_path, 'utf8')).OTHER).toBe('filled#value')
  })

  it('treats every required key as missing when the target file does not exist yet', () => {
    writeFileSync(shared_path, 'SECRET=<required>\n')
    writeFileSync(environment_path, 'MQTT_WEB_URL=ws://localhost:8083/mqtt\n')

    expect(missing_required_keys(template_paths, env_path)).toEqual(['SECRET'])
  })

  it('treats an existing <required> value as empty and fills it from input', () => {
    writeFileSync(shared_path, 'SECRET=<required>\n')
    writeFileSync(environment_path, 'MQTT_WEB_URL=ws://localhost:8083/mqtt\n')
    writeFileSync(env_path, 'SECRET=<required>\nMQTT_WEB_URL=ws://local.example/mqtt\n')

    expect(missing_required_keys(template_paths, env_path)).toEqual(['SECRET'])
    const result = sync_env_files(template_paths, env_path, { SECRET: 'filled' })

    expect(result.required).toEqual([])
    expect(readFileSync(env_path, 'utf8')).toBe('SECRET="filled"\n\nMQTT_WEB_URL="ws://local.example/mqtt"\n')
  })

  it('reports only existing values that differ from the selected layers', () => {
    writeFileSync(shared_path, 'SHARED_VALUE=shared\nSAME_VALUE=same\n')
    writeFileSync(environment_path, 'DEV_VALUE=template\nSAME_VALUE=same\nREQUIRED=<required>\n')
    writeFileSync(env_path, 'SHARED_VALUE=shared\nSAME_VALUE=same\nDEV_VALUE=custom\nREQUIRED=filled\nLOCAL_ONLY=value\n')

    const result = sync_env_files(template_paths, env_path)

    expect(result.overridden).toEqual(['DEV_VALUE'])
    expect(result.required).toEqual([])
    expect(result.unknown).toEqual(['LOCAL_ONLY'])
  })
})

describe('environment_from_argv', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('prefers the explicit flag over NODE_ENV', () => {
    expect(environment_from_argv(['--dev'], 'production')).toBe('dev')
    expect(environment_from_argv(['--prod'], 'development')).toBe('prod')
  })

  it('maps NODE_ENV names when no flag is given', () => {
    expect(environment_from_argv([], 'development')).toBe('dev')
    expect(environment_from_argv([], 'production')).toBe('prod')
  })

  it('defaults local env generation to dev and rejects unknown environments', () => {
    vi.stubEnv('NODE_ENV', undefined)
    expect(environment_from_argv([])).toBe('dev')
    expect(() => environment_from_argv([], 'test')).toThrow(/Unknown environment "test"/)
  })
})

describe('sync_summary', () => {
  it('names the created prod file and omits required guidance when everything is filled', () => {
    const summary = sync_summary(
      { created: true, added: ['JWT_SECRET'], unknown: [], overridden: [], required: [] },
      'C:/project/.env.prod',
      'prod',
      { JWT_SECRET: 'provided' },
    )

    expect(summary).toEqual([
      'Created .env.prod from the shared and prod layers.',
      'Filled from input: JWT_SECRET',
    ])
    expect(summary.join('\n')).not.toMatch(/placeholder|Fill these required values/)
  })

  it('lists only the required keys still missing from the target file', () => {
    expect(sync_summary(
      { created: true, added: ['JWT_SECRET', 'ACR_IMAGE'], unknown: [], overridden: [], required: ['ACR_IMAGE'] },
      '/deploy/.env.prod',
      'prod',
      { JWT_SECRET: 'provided' },
    )).toEqual([
      'Created .env.prod from the shared and prod layers.',
      'Filled from input: JWT_SECRET',
      'Fill these required values in .env.prod: ACR_IMAGE',
    ])
  })

  it('lists preserved local-only keys by name', () => {
    expect(sync_summary(
      { created: false, added: [], unknown: ['CUSTOM_LOCAL_KEY', 'EXTRA_URL'], overridden: [], required: [] },
      '/project/.env.dev',
      'dev',
    )).toEqual([
      'Synchronized .env.dev with the dev defaults.',
      'Preserved local-only keys: CUSTOM_LOCAL_KEY, EXTRA_URL',
    ])
  })

  it('lists keys whose existing values override the selected layer defaults', () => {
    expect(sync_summary(
      { created: false, added: [], unknown: [], overridden: ['MYSQL_HOST', 'MQTT_WEB_URL'], required: [] },
      '/deploy/.env.prod',
      'prod',
    )).toEqual([
      'Synchronized .env.prod with the prod defaults.',
      'Overrides from existing values: MYSQL_HOST, MQTT_WEB_URL',
    ])
  })
})
