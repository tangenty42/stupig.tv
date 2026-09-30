import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 不加载真实 .env：本测试要证明"没有密钥时运行路径报错、构建路径可用"，
// 而仓库里的 .env 恰好是有密钥的。
vi.mock('dotenv', () => ({ config: () => ({ parsed: {} }) }))

const secret_keys = [
  'DB_PASSWORD',
  'JWT_SECRET',
  'ALIYUN_ACCESS_KEY_ID',
  'ALIYUN_ACCESS_KEY_SECRET',
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
]

const { load_config, load_public_config } = await import('./config')

beforeEach(() => {
  for (const key of secret_keys) {
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of secret_keys) {
    delete process.env[key]
  }
})

describe('load_config（服务端运行时）', () => {
  it('缺少密钥时抛错，并点名缺失的环境变量', () => {
    expect(() => load_config()).toThrowError(/DB_PASSWORD/)
    expect(() => load_config()).toThrowError(/JWT_SECRET/)
    expect(() => load_config()).toThrowError(/OSS_ACCESS_KEY/)
  })

  it('空值视同缺失', () => {
    process.env.DB_PASSWORD = ''
    expect(() => load_config()).toThrowError(/DB_PASSWORD/)
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
