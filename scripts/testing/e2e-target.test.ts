import { describe, expect, it } from 'vitest'
import { e2e_target } from './e2e-target'

describe('e2E target ports', () => {
  it('keeps the documented port and artifacts for an unsharded run', () => {
    expect(e2e_target([])).toEqual({ port: 3142, baseUrl: 'http://localhost:3142', shard: { current: 1, total: 1 } })
    expect(e2e_target(['--reporter=list']).port).toBe(3142)
  })

  it('gives every shard a port of its own in both CLI spellings', () => {
    expect(e2e_target(['--shard=1/3'])).toEqual({ port: 3142, baseUrl: 'http://localhost:3142', shard: { current: 1, total: 3 } })
    expect(e2e_target(['--shard=2/3']).port).toBe(3143)
    expect(e2e_target(['--shard', '3/3']).port).toBe(3144)
    // 分片参数与端口一一对应，不会因为参数顺序改变结果。
    expect(e2e_target(['--workers=1', '--shard=2/3', '--reporter=list']).port).toBe(3143)
  })

  it.each(['0/3', '4/3', '2/0', '2', 'a/b', '2/21', '2/3/4', '-1/3', ' 1/3'])('rejects unusable shard arguments: %s', (value) => {
    expect(() => e2e_target([`--shard=${value}`])).toThrow('Invalid Playwright --shard value')
  })
})
