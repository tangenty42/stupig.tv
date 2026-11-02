import { afterEach, describe, expect, it, vi } from 'vitest'
import { dump_command, redact_dump_line } from './export-sample'

vi.mock('@config/loader', () => ({ load_database_config: () => ({ host: 'selected-db', port: 13306, user: 'sample-user', password: 'fixture-only', name: 'selected-database' }) }))

afterEach(() => vi.unstubAllEnvs())

describe('dump target', () => {
  it('uses the selected database endpoint without probing or preferring local containers', () => {
    vi.stubEnv('MYSQL_CONTAINER', undefined)
    const command = dump_command()
    expect(command.command).toBe('mysqldump')
    expect(command.args).toEqual(['-h', 'selected-db', '-P', '13306', '-usample-user', '--single-transaction', '--routines', '--triggers', '--default-character-set=utf8mb4', 'selected-database'])
    expect(command.env.MYSQL_PWD).toBe('fixture-only')
    expect(command.args.join(' ')).not.toContain('fixture-only')
  })

  it('uses a container only when explicitly requested and keeps its credentials out of arguments', () => {
    vi.stubEnv('MYSQL_CONTAINER', 'chosen-mysql')
    const command = dump_command()
    expect(command.command).toBe('docker')
    expect(command.args).toEqual(['exec', '-i', '-e', 'MYSQL_PWD', 'chosen-mysql', 'mysqldump', '-usample-user', '--single-transaction', '--routines', '--triggers', '--default-character-set=utf8mb4', 'selected-database'])
    expect(command.env.MYSQL_PWD).toBe('fixture-only')
    expect(command.args.join(' ')).not.toContain('fixture-only')
  })
})

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
