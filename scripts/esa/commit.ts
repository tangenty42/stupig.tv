import type { PublishConfig } from './config'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { PublishError } from './config'

export function create_commit_description(environment: PublishConfig['appEnvironment'], run: string) {
  // Keep cloud metadata short; the full timestamp and source digest stay in the receipt.
  return `stupig-${environment}-${run.slice(- 36)}`
}

export function parse_commit_version(output: string) {
  const versions = [... stripVTControlCharacters(output).matchAll(/Version generated:\s*(\d+)/g)].map(match => match[1])
  if (versions.length !== 1)
    throw new PublishError('ESA commit did not return one unambiguous version; inspect ESA before retrying')
  return versions[0]!
}

/** Official, pinned CLI packages just the captured entry; no source secrets or assets. */
export async function commit_source(config: PublishConfig, source: Buffer, description: string) {
  // Run the pinned CLI's Node entry directly. Its bin launcher spawns another
  // Node process, which could outlive execFile's timeout on Windows.
  const launcher = resolve('node_modules/esa-cli/dist/index.js')
  const node_path = resolve('node_modules/.pnpm/node_modules')
  const directory = await mkdtemp(join(tmpdir(), 'stupig-esa-'))
  try {
    await writeFile(join(directory, 'entry.mjs'), source)
    await writeFile(join(directory, 'esa.jsonc'), JSON.stringify({ name: config.name, entry: './entry.mjs' }))
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
      if (process.env[key] !== undefined)
        env[key] = process.env[key]
    }
    Object.assign(env, {
      ESA_ACCESS_KEY_ID: config.accessKeyId, ESA_ACCESS_KEY_SECRET: config.accessKeySecret,
      NODE_PATH: node_path, NO_COLOR: '1', CI: 'true', LANG: 'en_US.UTF-8',
    })
    const output = await new Promise<string>((accept, reject) => {
      const child = execFile(process.execPath, [launcher, '--skip-update-check', 'commit', './entry.mjs',
        '--name', config.name, '--environment', config.environment, '--no-bundle', '--description', description], {
        cwd: directory, env, windowsHide: true, timeout: config.readinessTimeoutMs, maxBuffer: 4 * 1024 * 1024,
      }, (error, stdout) => {
        // Never forward CLI stderr/errors: official SDK diagnostics can contain credentials.
        if (error)
          reject(new PublishError('ESA commit failed or timed out; a version may already exist. Inspect ESA before retrying'))
        else accept(stdout)
      })
      child.stdin?.end()
    })
    return parse_commit_version(output)
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
}
