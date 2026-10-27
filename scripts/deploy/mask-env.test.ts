import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mask_commands } from './mask-env'

describe('production log masks', () => {
  it('registers sensitive values once and escapes GitHub workflow command data', () => {
    const input = [
      'JWT_SECRET="abc%def"',
      'MYSQL_PASSWORD="line1\nline2"',
      'ALIYUN_DYPNS_CAPTCHA_APP_KEY=secret-key',
      'ALIYUN_OSS_ACCESS_KEY_ID=secret-id',
      'ALIYUN_OSS_ACCESS_KEY_SECRET=secret-key',
      'APP_PORT=3042',
      'NUXT_OTP_DEBUG=false',
    ].join('\n')
    expect(mask_commands(input)).toEqual([
      '::add-mask::abc%25def',
      '::add-mask::line1%0Aline2',
      '::add-mask::secret-key',
      '::add-mask::secret-id',
    ])
  })

  it('executes the real entry point against the decrypted file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deploy-mask-test-'))
    try {
      writeFileSync(join(directory, '.env.prod'), 'JWT_SECRET=fixture-secret\nAPP_PORT=3042\n')
      const result = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/deploy/mask-env.ts')], { cwd: directory, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe('::add-mask::fixture-secret\n')
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('covers every credential declared by the current production templates', () => {
    const keys = [
      'JWT_SECRET', 'MYSQL_PASSWORD', 'REDIS_PASSWORD', 'MQTT_PASSWORD',
      'ALIYUN_DYPNS_ACCESS_KEY_ID', 'ALIYUN_DYPNS_ACCESS_KEY_SECRET', 'ALIYUN_DYPNS_CAPTCHA_APP_KEY',
      'ALIYUN_OSS_ACCESS_KEY_ID', 'ALIYUN_OSS_ACCESS_KEY_SECRET', 'ALIYUN_ESA_AUTH_KEY',
      'ALIYUN_ESA_ACCESS_KEY_ID', 'ALIYUN_ESA_ACCESS_KEY_SECRET', 'ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID', 'ALIYUN_ESA_PUBLISH_ACCESS_KEY_SECRET',
    ]
    const templates = readFileSync('.env.shared.layer', 'utf8') + readFileSync('.env.prod.layer', 'utf8')
    for (const key of keys)
      expect(templates).toContain(`${key}=`)
    const commands = mask_commands(keys.map((key, index) => `${key}=fixture-${index}`).join('\n'))
    expect(commands).toHaveLength(keys.length)
    for (const [index] of keys.entries())
      expect(commands).toContain(`::add-mask::fixture-${index}`)
  })
})
