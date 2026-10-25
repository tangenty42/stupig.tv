import { execFile, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stupig-esa-cli-test-'))
  mkdirSync(join(directory, 'config/esa'), { recursive: true })
  for (const filename of ['shared.yaml', 'dev.yaml', 'prod.yaml', 'esa/content-auth.mjs'])
    copyFileSync(resolve('config', filename), join(directory, 'config', filename))
  writeFileSync(join(directory, '.env.dev'), 'ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID=dev-identity\nALIYUN_ESA_PUBLISH_ACCESS_KEY_SECRET=dev-secret\nALIYUN_ESA_AUTH_KEY=dev-test-key\nALIYUN_ESA_SITE_ID=111\n')
  writeFileSync(join(directory, '.env.prod'), 'ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID=prod-identity\nALIYUN_ESA_PUBLISH_ACCESS_KEY_SECRET=prod-secret\nALIYUN_ESA_AUTH_KEY=prod-test-key\nALIYUN_ESA_SITE_ID=222\n')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function run(target: string, args: string[]) {
  const scripts = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).scripts as Record<string, string>
  const [command, ... configured_args] = scripts[`esa:deploy:${target}`]!.split(' ')
  if (command !== 'tsx')
    throw new Error('Expected an ESA tsx entry')
  // Run the actual package recipe in an isolated config fixture, including its
  // fixed --env argument. This catches accidentally wiring prod to dev.
  const absolute_args = configured_args.map((arg, index) => {
    if (configured_args[index - 1] === '--import')
      return pathToFileURL(resolve(arg)).href
    return arg.startsWith('scripts/') || arg.startsWith('./scripts/') ? resolve(arg) : arg
  })
  return spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), ... absolute_args, ... args], {
    cwd: directory, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ESA_ACCESS_KEY_ID: 'must-not-override' },
    encoding: 'utf8', timeout: 20000,
  })
}

describe('eSA command entry point', () => {
  it('loads the pinned official CLI directly without a second launcher process', async () => {
    // Match commit_source's asynchronous child lifecycle, including closing
    // stdin. The official CLI must not wait for an interactive input stream.
    const result = await new Promise<{ status: string | number, stdout: string, stderr: string }>((accept) => {
      const child = execFile(process.execPath, [resolve('node_modules/esa-cli/dist/index.js'), '--skip-update-check', 'commit', '--help'], {
        cwd: directory, encoding: 'utf8', timeout: 20000,
        // Match the non-secret host environment forwarded by commit_source. On
        // Windows, omitting the user profile makes CLI home discovery very slow.
        env: {
          PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
          USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME,
          TEMP: process.env.TEMP, TMP: process.env.TMP,
          CI: 'true', NO_COLOR: '1', LANG: 'en_US.UTF-8',
          NODE_PATH: resolve('node_modules/.pnpm/node_modules'),
        },
      }, (error, stdout, stderr) => accept({ status: error?.code ?? 0, stdout, stderr }))
      child.stdin?.end()
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('--environment')
    expect(result.stdout).toContain('--bundle')
  // The real CLI has a 20 s process deadline; let its assertion report an exit
  // failure before Vitest's shorter default deadline interrupts this test.
  }, 25000)
  it.each([['dev', '111'], ['prod', '222']])('plans %s with its selected YAML/env and no cloud writes', (target, siteId) => {
    const output = run(target, ['--plan'])
    expect(output.status, output.stderr).toBe(0)
    expect(JSON.parse(output.stdout)).toMatchObject({ application: target, function: `stupig-content-auth-bypass-${target}`, siteId, environment: 'production', credentialsConfigured: true })
    expect(output.stdout).not.toMatch(/dev-secret|prod-secret|dev-test-key|prod-test-key|must-not-override/)
    expect(existsSync(join(directory, '.data'))).toBe(false)
  })

  it('rejects command-line target overrides and overlapping configured targets', () => {
    const overridden = run('prod', ['--name', 'stupig-content-auth-bypass-dev', '--plan'])
    expect(overridden.status).not.toBe(0)
    expect(overridden.stderr).toContain('targets come only from YAML')
    const prod = parse(readFileSync(join(directory, 'config/prod.yaml'), 'utf8'))
    prod.esaFunction.name = 'stupig-content-auth-bypass-dev'
    writeFileSync(join(directory, 'config/prod.yaml'), stringify(prod))
    const overlapping = run('prod', ['--plan'])
    expect(overlapping.status).not.toBe(0)
    expect(overlapping.stderr).toContain('different ESA function names')
  })

  it('fails missing credentials before attempting cloud or creating receipts', () => {
    writeFileSync(join(directory, '.env.prod'), '')
    const output = run('prod', ['--check'])
    expect(output.status).not.toBe(0)
    expect(output.stderr).toContain('Missing esaFunction.accessKeyId')
    expect(existsSync(join(directory, '.data'))).toBe(false)
  })
})
