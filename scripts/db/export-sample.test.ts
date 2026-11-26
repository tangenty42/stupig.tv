import { afterEach, describe, expect, it, vi } from 'vitest'
import { dump_command, redact_dump_line } from './export-sample'

vi.mock('@config/loader', () => ({ load_database_config: () => ({ host: 'selected-db', port: 13306, user: 'sample-user', password: 'fixture-only', name: 'selected-database' }) }))

afterEach(() => vi.unstubAllEnvs())

describe('dump target', () => {
  it('uses the selected database endpoint without probing or preferring local containers', () => {
    vi.stubEnv('MYSQL_CONTAINER', undefined)
    const command = dump_command()
    expect(command.command).toBe('mysqldump')
    expect(command.args).toEqual(['-h', 'selected-db', '-P', '13306', '-usample-user', '--single-transaction', '--complete-insert', '--routines', '--triggers', '--default-character-set=utf8mb4', 'selected-database'])
    expect(command.env.MYSQL_PWD).toBe('fixture-only')
    expect(command.args.join(' ')).not.toContain('fixture-only')
  })

  it('uses a container only when explicitly requested and keeps its credentials out of arguments', () => {
    vi.stubEnv('MYSQL_CONTAINER', 'chosen-mysql')
    const command = dump_command()
    expect(command.command).toBe('docker')
    expect(command.args).toEqual(['exec', '-i', '-e', 'MYSQL_PWD', 'chosen-mysql', 'mysqldump', '-usample-user', '--single-transaction', '--complete-insert', '--routines', '--triggers', '--default-character-set=utf8mb4', 'selected-database'])
    expect(command.env.MYSQL_PWD).toBe('fixture-only')
    expect(command.args.join(' ')).not.toContain('fixture-only')
  })
})

const dev_hash = '$argon2id$v=19$m=19456,t=2,p=1$devsalt$devalways'

describe('redact_dump_line', () => {
  it('手机号替换为递增假号，保持唯一', () => {
    const state = { phone: 0, password_hash: dev_hash }
    expect(redact_dump_line('INSERT INTO `users` (`id`,`username`,`phone`,`password_hash`) VALUES (1,\'alice\',\'13812345678\',NULL);', state))
      .toContain('\'19900000001\'')
    expect(redact_dump_line(`INSERT INTO otp_send_logs VALUES (3,'tok','13900001111','login');`, state))
      .toContain('\'19900000002\'')
  })

  it('用户密码列脱敏后包含本地密码哈希，包括清空密码的账号', () => {
    const state = { phone: 0, password_hash: dev_hash }
    const prefix = 'INSERT INTO `users` (`id`,`verified_note`,`password_hash`,`username`) VALUES '
    const bcrypt_hash = '$2b$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ12'
    const argon_hash = '$argon2id$v=19$m=19456,t=2,p=1$productionsalt$productionfixture'
    const note = String.raw`'I\'m a comma, next to (), backslash \\ and escaped newlines (\n)'`
    const result = redact_dump_line(`${prefix}(1,${note},'${bcrypt_hash}','ab'),(2,NULL,'${argon_hash}','cd'),(3,NULL,NULL,'ef');`, state)
    expect(result).toBe(`${prefix}(1,${note},'${dev_hash}','ab'),(2,NULL,'${dev_hash}','cd'),(3,NULL,'${dev_hash}','ef');`)
  })

  it('无法定位密码列或完整解析用户行时终止导出', () => {
    const state = { phone: 0, password_hash: dev_hash }
    expect(() => redact_dump_line('INSERT INTO `users` VALUES (1,\'unredacted\');', state)).toThrow('无法定位用户样本的密码列')
    expect(() => redact_dump_line('INSERT INTO `users` (`id`,`password_hash`) VALUES (1,\'unredacted\'),(2);', state)).toThrow('无法脱敏用户样本的密码列')
  })

  it('iPv4 替换为 127.0.0.1', () => {
    const state = { phone: 0, password_hash: dev_hash }
    expect(redact_dump_line(`VALUES (9,1,'tok','203.0.113.7','203.0.113.8');`, state))
      .toBe(`VALUES (9,1,'tok','127.0.0.1','127.0.0.1');`)
  })

  it('替换产物不会被二次替换（不会死循环/重复脱敏）', () => {
    const state = { phone: 0, password_hash: dev_hash }
    // '19900000001' 本身仍匹配手机号正则、'127.0.0.1' 仍匹配 IP 正则
    const result = redact_dump_line(`VALUES ('13812345678','203.0.113.7');`, state)
    expect(result).toBe(`VALUES ('19900000001','127.0.0.1');`)
    expect(redact_dump_line(result, state)).toBe(`VALUES ('19900000002','127.0.0.1');`)
  })
})
