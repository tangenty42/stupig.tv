import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/sh.exe' : 'sh'
const script = join(import.meta.dirname, 'stage-env.sh')

function stage(fail: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'stage-env-'))
  try {
    const bin = join(directory, 'bin')
    const deploy = join(directory, 'deploy')
    mkdirSync(bin)
    mkdirSync(deploy)
    writeFileSync(join(deploy, '.env.prod.incoming'), 'old content\n')
    writeFileSync(join(directory, 'runtime'), 'secret runtime\n')
    const ssh = '#!/bin/sh\nfor arg do command=$arg; done\nsh -c "$command"\n'
    const scp = '#!/bin/sh\n[ "$1" = -p ] || exit 1\n[ "$2" = -P ] || exit 1\n[ "$' + '{FAIL_SCP:-}" != 1 ] || exit 1\npath=$' + '{5#*:}\nstat -c %a "$(dirname "$path")" "$4" > "$TRACE_FILE"\ncp -p "$4" "$path"\n'
    for (const [name, source] of [['ssh', ssh], ['scp', scp]]) {
      writeFileSync(join(bin, name), source)
      chmodSync(join(bin, name), 0o755)
    }
    const posix_path = spawnSync(shell, ['-c', 'pwd'], { cwd: deploy, encoding: 'utf8' }).stdout.trim()
    const result = spawnSync(shell, [script, join(directory, 'runtime')], {
      env: {
        ... process.env,
        PATH: [bin, process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin' : '/usr/bin', process.env.PATH ?? ''].join(process.platform === 'win32' ? ';' : ':'),
        SSH_HOST: 'example.test', SSH_USER: 'deploy', SSH_PORT: '2222', DEPLOY_DIR: posix_path,
        GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', FAIL_SCP: fail ? '1' : '', TRACE_FILE: join(directory, 'mode'),
      },
      encoding: 'utf8',
    })
    const mode = existsSync(join(directory, 'mode')) ? readFileSync(join(directory, 'mode'), 'utf8') : ''
    return { status: result.status, stderr: result.stderr, files: readdirSync(deploy), incoming: readFileSync(join(deploy, '.env.prod.incoming'), 'utf8'), mode }
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform === 'win32' && ! existsSync(shell))('secure runtime environment upload', () => {
  it('atomically replaces the incoming file and removes the private staging directory', () => {
    const result = stage(false)
    expect(result.status, result.stderr).toBe(0)
    expect(result.incoming).toBe('secret runtime\n')
    expect(result.files).toEqual(['.env.prod.incoming'])
    if (process.platform !== 'win32')
      expect(result.mode).toBe('700\n600\n')
  })

  it('preserves the old incoming file and cleans the staging directory when upload fails', () => {
    const result = stage(true)
    expect(result.status).not.toBe(0)
    expect(result.incoming).toBe('old content\n')
    expect(result.files).toEqual(['.env.prod.incoming'])
  })
})
