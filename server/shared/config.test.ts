import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 不加载真实 .env：本测试要证明"没有密钥时运行路径报错、构建路径可用"，
// 而仓库里的 .env 恰好是有密钥的。
vi.mock('dotenv', () => ({ config: () => ({ parsed: {} }) }))

const secret_keys = [
  'MYSQL_PASSWORD',
  'JWT_SECRET',
  'ALIYUN_ACCESS_KEY_ID',
  'ALIYUN_ACCESS_KEY_SECRET',
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
]

// default.yaml 的连接信息全靠插值，这些不是密钥（故不在 load_config 的缺失
// 检查里），但缺了会过不了 schema 校验，测试统一给占位值
const connection_stubs = {
  MYSQL_HOST: '127.0.0.1',
  MYSQL_PORT: '3306',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  MQTT_HOST: '127.0.0.1',
  MQTT_TCP_PORT: '1883',
  MQTT_WEB_URL: 'ws://localhost:8083/mqtt',
}

const { load_config, load_public_config } = await import('./config')
const default_config_path = resolve(import.meta.dirname, '../../config/default.yaml')
let work_dir = ''

beforeEach(() => {
  work_dir = mkdtempSync(resolve(tmpdir(), 'stupig-config-test-'))
  mkdirSync(resolve(work_dir, 'config'))
  copyFileSync(default_config_path, resolve(work_dir, 'config/default.yaml'))
  vi.spyOn(process, 'cwd').mockReturnValue(work_dir)
  vi.stubEnv('NODE_ENV', 'test')
  for (const key of secret_keys) {
    vi.stubEnv(key, undefined)
  }
  for (const [key, value] of Object.entries(connection_stubs)) {
    vi.stubEnv(key, value)
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (work_dir) {
    rmSync(work_dir, { recursive: true, force: true })
  }
})

describe('load_config（服务端运行时）', () => {
  it('缺少密钥时抛错，并点名缺失的环境变量', () => {
    expect(() => load_config()).toThrowError(/MYSQL_PASSWORD/)
    expect(() => load_config()).toThrowError(/JWT_SECRET/)
    expect(() => load_config()).toThrowError(/OSS_ACCESS_KEY/)
  })

  it('空值视同缺失', () => {
    process.env.MYSQL_PASSWORD = ''
    expect(() => load_config()).toThrowError(/MYSQL_PASSWORD/)
  })

  it('jWT_SECRET 短于 32 字符被拒', () => {
    for (const key of secret_keys) {
      process.env[key] = 'x'.repeat(40)
    }
    process.env.JWT_SECRET = 'too-short'
    expect(() => load_config()).toThrowError(/32/)
  })

  it('密钥齐备时正常加载', () => {
    for (const key of secret_keys) {
      process.env[key] = key === 'JWT_SECRET' ? 'y'.repeat(40) : 'placeholder'
    }
    const config = load_config()
    expect(config.db.password).toBe('placeholder')
    expect(config.site.url).toBe('https://www.stupig.tv')
  })
})

describe('load_public_config（构建期）', () => {
  it('没有 .env 也能加载，且 public 白名单来自 YAML 字面量', () => {
    const config = load_public_config()
    expect(config.site.url).toBe('https://www.stupig.tv')
    expect(config.mqtt.topicPrefix).toBe('stupig/sync')
    expect(config.app.content.draft.schemaVersion).toBeGreaterThan(0)
  })

  it('密钥字段为空串，但结构校验照常生效', () => {
    const config = load_public_config()
    expect(config.db.password).toBe('')
    expect(config.oss.accessKeySecret).toBe('')
  })
})
