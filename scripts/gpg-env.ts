import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parse_dotenv } from 'dotenv'

// Git for Windows 自带的 gpg 是真实可执行文件；scoop 的是 shim，Node 用管道
// stdio 拉起时会挂住，所以本机路径优先于 PATH。
const gpg_candidates = [
  'C:/Program Files/Git/usr/bin/gpg.exe',
  'C:/Program Files/Git/bin/gpg.exe',
  'C:/Program Files (x86)/Git/usr/bin/gpg.exe',
  'gpg',
]

export function find_gpg(candidates = gpg_candidates): string | null {
  for (const candidate of candidates) {
    if (candidate !== 'gpg' && ! existsSync(candidate)) {
      continue
    }
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' })
    if (! probe.error && probe.status === 0) {
      return candidate
    }
  }
  return null
}

export type CryptAction = 'encrypt' | 'decrypt' | 'check'

function resolve_passphrase(cwd: string, passphrase: string | undefined) {
  if (passphrase !== undefined) {
    return passphrase
  }
  if (process.env.ENV_PASSPHRASE !== undefined) {
    return process.env.ENV_PASSPHRASE
  }
  const env_path = resolve(cwd, '.env')
  return existsSync(env_path) ? parse_dotenv(readFileSync(env_path, 'utf8')).ENV_PASSPHRASE : undefined
}

function run_gpg(args: string[], cwd: string, passphrase: string | undefined) {
  const gpg = find_gpg()
  if (! gpg) {
    throw new Error('找不到 gpg：PATH 里没有，Git for Windows 的 usr/bin/gpg.exe 也不存在')
  }
  // 交互运行时让 gpg 自己弹 pinentry；CI 里用 ENV_PASSPHRASE 走批处理模式，
  // loopback 是必需的，否则新版 gpg 在 batch 下仍会去等 pinentry 而挂住
  const batch = passphrase === undefined ? ['--yes'] : ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase', passphrase]
  const result = spawnSync(gpg, [... batch, ... args], { cwd, stdio: passphrase === undefined ? 'inherit' : 'pipe' })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`gpg failed (exit ${result.status}): ${result.stderr?.toString().trim() ?? 'no stderr'}`)
  }
}

export function crypt_env(action: 'encrypt' | 'decrypt', { cwd = process.cwd(), passphrase = process.env.ENV_PASSPHRASE }: { cwd?: string, passphrase?: string } = {}) {
  const plain = resolve(cwd, '.env.prod')
  const encrypted = resolve(cwd, '.env.prod.gpg')
  const resolved_passphrase = resolve_passphrase(cwd, passphrase)
  const args = action === 'encrypt'
    ? ['--symmetric', '--cipher-algo', 'AES256', '--output', encrypted, plain]
    : ['--decrypt', '--output', plain, encrypted]
  run_gpg(args, cwd, resolved_passphrase)
}

export interface EnvCheckResult {
  ok: boolean
}

// 解密到临时文件后直接按字节比较，任何格式差异都要求重新加密。
export function check_env({ cwd = process.cwd(), passphrase = process.env.ENV_PASSPHRASE }: { cwd?: string, passphrase?: string } = {}): EnvCheckResult {
  const plain = resolve(cwd, '.env.prod')
  const encrypted = resolve(cwd, '.env.prod.gpg')
  if (! existsSync(encrypted)) {
    throw new Error('.env.prod.gpg 不存在：先运行 pnpm env:encrypt')
  }
  if (! existsSync(plain)) {
    throw new Error('.env.prod 不存在：先运行 pnpm env:build:prod 生成')
  }

  const work_dir = mkdtempSync(join(tmpdir(), 'stupig-env-check-'))
  try {
    const decrypted = join(work_dir, 'decrypted.env')
    run_gpg(['--decrypt', '--output', decrypted, encrypted], cwd, resolve_passphrase(cwd, passphrase))

    const current = readFileSync(plain)
    const committed = readFileSync(decrypted)
    return { ok: current.equals(committed) }
  }
  finally {
    rmSync(work_dir, { recursive: true, force: true })
  }
}

function main() {
  const action = process.argv[2]
  if (action !== 'encrypt' && action !== 'decrypt' && action !== 'check') {
    throw new Error('Usage: tsx scripts/gpg-env.ts <encrypt|decrypt|check>')
  }
  if (action === 'check') {
    const drift = check_env()
    if (! drift.ok) {
      process.stderr.write('.env.prod 与 .env.prod.gpg 不一致，请运行 pnpm env:encrypt 重新加密\n')
      process.exitCode = 1
    }
    return
  }
  crypt_env(action)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main()
  }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
