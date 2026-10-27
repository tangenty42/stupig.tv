import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
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

  it('keeps the selected shard when Playwright reloads its config in a worker', async () => {
    const root = process.cwd()
    await mkdir(resolve(root, '.dev'), { recursive: true })
    const directory = await mkdtemp(resolve(root, '.dev/playwright-shard-test-'))
    const config = resolve(directory, 'playwright.config.ts')
    try {
      await writeFile(config, `import base from ${JSON.stringify(resolve(root, 'playwright.config.ts').replaceAll('\\', '/'))}\nexport default { ...base, testDir: '.', globalSetup: undefined, reporter: 'list' }\n`)
      const spec = `import { test, expect } from '@playwright/test'\ntest('worker receives shard target', async ({ baseURL }, info) => { expect(baseURL).toBe('http://localhost:3143'); expect(info.outputDir).toContain('results-shard-2') })\n`
      await Promise.all(['a.spec.ts', 'b.spec.ts'].map(name => writeFile(resolve(directory, name), spec)))
      const environment = { ... process.env }
      delete environment.STUPIG_E2E_SHARD
      const { stdout } = await promisify(execFile)(process.execPath, [resolve(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', config, '--shard=2/2'], {
        cwd: root, env: environment, timeout: 20_000,
      })
      expect(stdout).toContain('1 passed')
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it.each(['0/3', '4/3', '2/0', '2', 'a/b', '2/21', '2/3/4', '-1/3', ' 1/3'])('rejects unusable shard arguments: %s', (value) => {
    expect(() => e2e_target([`--shard=${value}`])).toThrow('Invalid Playwright --shard value')
  })
})
