import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

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

export type CryptAction = 'encrypt' | 'decrypt'

export function crypt_env(action: CryptAction, { cwd = process.cwd(), passphrase = process.env.ENV_PASSPHRASE }: { cwd?: string, passphrase?: string } = {}) {
  const gpg = find_gpg()
  if (! gpg) {
    throw new Error('找不到 gpg：PATH 里没有，Git for Windows 的 usr/bin/gpg.exe 也不存在')
  }
  const plain = resolve(cwd, '.env.prod')
  const encrypted = resolve(cwd, '.env.prod.gpg')
  // 交互运行时让 gpg 自己弹 pinentry；CI 里用 ENV_PASSPHRASE 走批处理模式，
  // loopback 是必需的，否则新版 gpg 在 batch 下仍会去等 pinentry 而挂住
  const batch = passphrase === undefined ? ['--yes'] : ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase', passphrase]
  const args = action === 'encrypt'
    ? [... batch, '--symmetric', '--cipher-algo', 'AES256', '--output', encrypted, plain]
    : [... batch, '--yes', '--decrypt', '--output', plain, encrypted]
  const result = spawnSync(gpg, args, { cwd, stdio: passphrase === undefined ? 'inherit' : 'pipe' })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`gpg ${action} failed (exit ${result.status}): ${result.stderr?.toString().trim() ?? 'no stderr'}`)
  }
}

function main() {
  const action = process.argv[2]
  if (action !== 'encrypt' && action !== 'decrypt') {
    throw new Error('Usage: tsx scripts/gpg-env.ts <encrypt|decrypt>')
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
