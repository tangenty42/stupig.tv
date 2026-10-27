import { parse } from 'dotenv'
import { describe, expect, it } from 'vitest'
import { runtime_environment } from './runtime-env'

describe('server runtime environment', () => {
  it('removes all publisher assignments while preserving every other value', () => {
    const source = [
      'MYSQL_PASSWORD="a # b"',
      'ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID=publisher',
      'export ALIYUN_ESA_PUBLISH_ACCESS_KEY_SECRET="secret\nsecond line"',
      'ALIYUN_ESA_PUBLISH_FUTURE_KEY=another',
      'ALIYUN_ESA_AUTH_KEY=application-auth',
      'CUSTOM="first\nALIYUN_ESA_PUBLISH_NOT_AN_ASSIGNMENT=value\nlast"',
      '',
    ].join('\r\n')
    const output = runtime_environment(source)
    expect(parse(output)).toEqual({ MYSQL_PASSWORD: 'a # b', ALIYUN_ESA_AUTH_KEY: 'application-auth', CUSTOM: 'first\nALIYUN_ESA_PUBLISH_NOT_AN_ASSIGNMENT=value\nlast' })
    expect(output).not.toContain('publisher')
    expect(output).not.toContain('secret')
  })

  it('fails closed for duplicate keys or unterminated quoted values', () => {
    expect(() => runtime_environment('FOO=one\nFOO=two\n')).toThrow(/Duplicate/)
    expect(() => runtime_environment('ALIYUN_ESA_PUBLISH_ACCESS_KEY_SECRET="unfinished\n')).toThrow(/Unterminated/)
  })
})
