import type { ExecFileException } from 'node:child_process'
import type { PublishConfig } from './config'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { PublishError } from './config'

/** A compact, line-ending-independent fingerprint of the published source. */
export function source_fingerprint(source: Buffer) {
  return createHash('sha256').update(source.toString('utf8').replace(/\r\n/g, '\n')).digest().subarray(0, 16).toString('base64url')
}

export function create_commit_description(environment: PublishConfig['appEnvironment'], run: string, source: Buffer) {
  const uuid = run.slice(- 36)
  if (environment === 'prod')
    return `stupig-prod-${uuid}`

  // Keep the full UUID and source fingerprint in a 49-character description.
  const encoded_uuid = Buffer.from(uuid.replaceAll('-', ''), 'hex').toString('base64url')
  return `dev-${source_fingerprint(source)}-${encoded_uuid}`
}

export function parse_commit_version(output: string) {
  const versions = [... stripVTControlCharacters(output).matchAll(/Version generated:\s*(\d+)/g)].map(match => match[1])
  if (versions.length !== 1)
    throw new PublishError('ESA commit did not return one unambiguous version; inspect ESA before retrying')
  return versions[0]!
}

export interface CommitDiagnostics {
  timed_out: boolean
  exit_code?: number
  signal?: string
  reached?: string
  failed_at?: string
  api?: string
  error_code?: string
  http_status?: number
  request_id?: string
}

export class CommitFailure extends PublishError {
  constructor(message: string, readonly diagnostics: CommitDiagnostics) {
    super(message)
  }
}

// Fixed phrases printed by the pinned esa-cli (1.0.13). Only these labels, never
// the surrounding output, leave the child process.
const milestones = [
  ['Logged in', 'logged-in'],
  ['Routine has already exists', 'routine-exists'],
  ['Routine created successfully', 'routine-created'],
  ['Generating code version', 'generating-version'],
] as const
const failures = [
  [/You are not logged in|Maybe you are not logged in yet/, 'login'],
  [/Routine created failed/, 'create-routine'],
  [/Missing required OSS configuration fields/, 'oss-upload-config'],
  [/Error uploading to OSS/, 'oss-upload'],
  [/Generate version failed/, 'generate-version'],
  [/Missing CodeVersion in response/, 'missing-version'],
] as const

/** Extracts allowlisted, credential-free facts from a failed CLI run. */
export function diagnose_commit_failure(error: ExecFileException, stdout: string, stderr: string, secrets: readonly string[]): CommitDiagnostics {
  const out = stripVTControlCharacters(stdout)
  const err = stripVTControlCharacters(stderr)
  const all = `${out}\n${err}`
  const result: CommitDiagnostics = { timed_out: error.killed === true && Boolean(error.signal) }
  if (typeof error.code === 'number')
    result.exit_code = error.code
  if (error.signal)
    result.signal = error.signal
  let reached_at = - 1
  for (const [phrase, label] of milestones) {
    const index = out.lastIndexOf(phrase)
    if (index > reached_at) {
      reached_at = index
      result.reached = label
    }
  }
  result.failed_at = failures.find(([pattern]) => pattern.test(all))?.[1]
  result.api = /Error calling ([A-Z][A-Za-z]{2,60}):/.exec(err)?.[1]
  // Alibaba error codes are letters and dots; anything with digits is refused,
  // which also excludes AccessKey IDs and secrets.
  result.error_code = /\bcode: '([A-Z][A-Za-z]*(?:\.[A-Za-z]+)*)'/.exec(err)?.[1]?.slice(0, 100)
  const status = /\bstatusCode: (\d{3})\b/.exec(err)?.[1] ?? /\bcode: (\d{3}),/.exec(err)?.[1]
  if (status)
    result.http_status = Number(status)
  result.request_id = /request id: ([\dA-F]{8}-[\dA-F]{4}-[\dA-F]{4}-[\dA-F]{4}-[\dA-F]{12})\b/i.exec(err)?.[1]
  const tokens = secrets.filter(secret => secret.length >= 4)
  for (const key of ['signal', 'reached', 'failed_at', 'api', 'error_code', 'request_id'] as const) {
    const value = result[key]
    if (value === undefined || tokens.some(token => value.includes(token)))
      delete result[key]
  }
  return result
}

function describe_commit_failure(diagnostics: CommitDiagnostics, timeout_ms: number) {
  const facts = Object.entries(diagnostics).filter(([key, value]) => key !== 'timed_out' && value !== undefined).map(([key, value]) => `${key}=${String(value)}`)
  const cause = diagnostics.timed_out ? `timed out after ${timeout_ms} ms` : 'failed'
  return `ESA commit ${cause}; a version may already exist. Inspect ESA before retrying${facts.length ? ` (${facts.join(', ')})` : ''}`
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
      }, (error, stdout, stderr) => {
        // Never forward CLI stderr/errors: official SDK diagnostics can contain credentials.
        if (error) {
          const diagnostics = diagnose_commit_failure(error, String(stdout), String(stderr), [config.accessKeyId ?? '', config.accessKeySecret ?? ''])
          reject(new CommitFailure(describe_commit_failure(diagnostics, config.readinessTimeoutMs), diagnostics))
        }
        else {
          accept(stdout)
        }
      })
      child.stdin?.end()
    })
    return parse_commit_version(output)
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
}
