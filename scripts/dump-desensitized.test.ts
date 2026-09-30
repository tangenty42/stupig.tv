import { describe, expect, it } from 'vitest'
import { redact_dump_line } from './dump-desensitized'

const sample_hash = '$2b$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ12'

describe('redact_dump_line', () => {
  it('手机号替换为递增假号，保持唯一', () => {
    const state = { phone: 0 }
    expect(redact_dump_line(`INSERT INTO users VALUES (1,'alice','13812345678','${sample_hash}',NULL);`, state))
      .toContain('\'19900000001\'')
    expect(redact_dump_line(`INSERT INTO otp_send_logs VALUES (3,'tok','13900001111','login');`, state))
      .toContain('\'19900000002\'')
  })

  it('bcrypt 哈希统一替换为本地密码哈希', () => {
    const state = { phone: 0 }
    const result = redact_dump_line(`INSERT INTO users VALUES (1,'a','13812345678','${sample_hash}',NULL);`, state)
    expect(result).not.toContain(sample_hash)
    expect(result).toContain('\'$2b$10$sT2LriomK70rzTJXync3GO0wK0ERbYBS24LrTBAv621WJ2EV/n3o6\'')
  })

  it('iPv4 替换为 127.0.0.1', () => {
    const state = { phone: 0 }
    expect(redact_dump_line(`VALUES (9,1,'tok','203.0.113.7','203.0.113.8');`, state))
      .toBe(`VALUES (9,1,'tok','127.0.0.1','127.0.0.1');`)
  })

  it('替换产物不会被二次替换（不会死循环/重复脱敏）', () => {
    const state = { phone: 0 }
    // '19900000001' 本身仍匹配手机号正则、'127.0.0.1' 仍匹配 IP 正则
    const result = redact_dump_line(`VALUES ('13812345678','203.0.113.7');`, state)
    expect(result).toBe(`VALUES ('19900000001','127.0.0.1');`)
    expect(redact_dump_line(result, state)).toBe(`VALUES ('19900000002','127.0.0.1');`)
  })
})
