import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { environment_file, load_environment, prepare_cli_environment } from './environment.mjs'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stupig-environment-'))
  writeFileSync(join(directory, '.env.dev'), 'NODE_ENV=development\nSELECTED=dev\nDEV_ONLY=dev-only\n')
  writeFileSync(join(directory, '.env.prod'), 'NODE_ENV=production\nSELECTED=prod\nPROD_ONLY=prod-only\n')
  writeFileSync(join(directory, '.env'), 'SELECTED=legacy\nLEGACY_ONLY=must-not-load\n')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('environment selection', () => {
  it.each([
    ['development', '.env.dev', 'dev', 'PROD_ONLY'],
    ['production', '.env.prod', 'prod', 'DEV_ONLY'],
  ])('loads only %s values without using legacy .env', (node_env, filename, selected, excluded) => {
    const input = { NODE_ENV: node_env }
    const result = load_environment({ env: input, cwd: directory })
    expect(environment_file(node_env)).toBe(filename)
    expect(result.SELECTED).toBe(selected)
    expect(result).not.toHaveProperty(excluded!)
    expect(result).not.toHaveProperty('LEGACY_ONLY')
    expect(input).toEqual({ NODE_ENV: node_env })
  })

  it('keeps deployment injection authoritative and never imports the other environment', () => {
    expect(load_environment({ env: { NODE_ENV: 'production', SELECTED: 'injected' }, cwd: directory }).SELECTED).toBe('injected')
    load_environment({ env: { NODE_ENV: 'development' }, cwd: directory })
    expect(load_environment({ env: { NODE_ENV: 'production' }, cwd: directory })).not.toHaveProperty('DEV_ONLY')
  })

  it('supports an injected container/CI environment with no local env file', () => {
    rmSync(join(directory, '.env.prod'))
    expect(load_environment({ env: { NODE_ENV: 'production', SELECTED: 'container' }, cwd: directory })).toEqual({ NODE_ENV: 'production', SELECTED: 'container' })
  })

  it('rejects unknown environments and files that declare the wrong environment', () => {
    expect(() => load_environment({ env: {}, cwd: directory })).toThrow(/NODE_ENV/)
    expect(() => environment_file('test')).toThrow(/NODE_ENV/)
    writeFileSync(join(directory, '.env.prod'), 'NODE_ENV=development\nSELECTED=wrong\n')
    expect(() => load_environment({ env: { NODE_ENV: 'production' }, cwd: directory })).toThrow(/NODE_ENV in .env.prod must be production/)
  })

  it.each([['--env=prod'], ['--env', 'prod'], ['--env=production']])('consumes explicit application selection %j without consuming ESA publishing options', (... selection) => {
    const result = prepare_cli_environment(['env', 'list', ... selection, '--environment', 'production'], {}, directory)
    expect(result.filename).toBe('.env.prod')
    expect(result.env.SELECTED).toBe('prod')
    expect(result.args).toEqual(['env', 'list', '--environment', 'production'])
  })

  it('uses a development default for local tools and honors NODE_ENV or an explicit selector', () => {
    expect(prepare_cli_environment([], {}, directory).env.SELECTED).toBe('dev')
    expect(prepare_cli_environment([], { NODE_ENV: 'production' }, directory).env.SELECTED).toBe('prod')
    expect(prepare_cli_environment(['--env=dev'], { NODE_ENV: 'production' }, directory).env.NODE_ENV).toBe('development')
    for (const args of [['--env'], ['--env='], ['--env=test'], ['--env=dev', '--env=prod']])
      expect(() => prepare_cli_environment(args, {}, directory)).toThrow(/--env/)
  })

  it('preloads the selected file before the actual command imports dependencies', () => {
    const script = join(directory, 'probe.mjs')
    writeFileSync(script, 'console.log(JSON.stringify({selected:process.env.SELECTED,node:process.env.NODE_ENV,legacy:process.env.LEGACY_ONLY,args:process.argv.slice(2)}))')
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(resolve('scripts/env/preload.mjs')).href, script, '--env=prod', '--environment', 'production'], {
      cwd: directory,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ selected: 'prod', node: 'production', args: ['--environment', 'production'] })
  })

  it('uses the same preload before a tsx tool starts', () => {
    const script = join(directory, 'probe.ts')
    writeFileSync(script, 'console.log(JSON.stringify({selected:process.env.SELECTED,args:process.argv.slice(2)}))')
    const result = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), '--tsconfig', resolve('scripts/tsconfig.json'), '--import', pathToFileURL(resolve('scripts/env/preload.mjs')).href, script, '--env', 'prod', '--status'], {
      cwd: directory, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ selected: 'prod', args: ['--status'] })
  })
})
