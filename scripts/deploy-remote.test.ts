import type { SpawnSyncReturns } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * `scripts/deploy-remote.sh` runs on the production server and decides whether a
 * deploy is kept or rolled back, so its decision logic is worth pinning rather
 * than trusting. It is POSIX shell — the one production artefact a unit test
 * cannot import — so this drives it for real, through `sh`, against a stub
 * `docker` on PATH that replays a scripted container state.
 *
 * What the cases below lock in:
 *   - the happy path prunes and exits 0;
 *   - a container that exits is rolled back (the rollback anchor is a real image
 *     ID taken before the pull) and the run fails;
 *   - nothing to roll back to is reported, not silently "fixed";
 *   - a timeout (container still running, just not healthy yet) fails the run but
 *     does **not** downgrade the site — the deliberate asymmetry, since a slow
 *     start is not evidence of a broken image.
 */

const repo_root = join(import.meta.dirname, '..')
const script_path = join(repo_root, 'scripts/deploy-remote.sh')

/** `sh` is not on PATH on Windows, but Git for Windows ships one. */
function find_shell(): string | null {
  const candidates = [
    'sh',
    'C:/Program Files/Git/usr/bin/sh.exe',
    'C:/Program Files/Git/bin/sh.exe',
    'C:/Program Files (x86)/Git/usr/bin/sh.exe',
  ]
  for (const candidate of candidates) {
    if (candidate !== 'sh' && ! existsSync(candidate))
      continue
    const probe = spawnSync(candidate, ['-c', 'exit 0'])
    if (! probe.error && probe.status === 0)
      return candidate
  }
  return null
}

const shell = find_shell()

const stub_docker = `#!/bin/sh
# 替身 docker：把"容器现在的状态"按队列逐个吐给脚本，并记录所有有副作用的调用。
# 队列文件由测试写入；pop 用 sed 去掉首行（POSIX 下没有更简单的出队方式）。
pop() {
  file="$1"
  if [ ! -s "$file" ]; then
    echo "empty"
    return
  fi
  head -n 1 "$file"
  sed -n '2,$p' "$file" > "$file.next"
  mv "$file.next" "$file"
}

case "$1" in
  login|compose|tag|image)
    echo "$*" >> "$STUB_DIR/calls"
    exit 0
    ;;
  inspect)
    # 注意顺序：健康检查的 --format 是
    # '{{if .State.Health}}{{.State.Health.Status}}...'，里面也含 "State.Status"，
    # 所以必须先匹配 State.Health，否则健康查询会去弹状态队列
    for arg in "$@"; do
      case "$arg" in
        *State.Health*) pop "$STUB_DIR/health_queue"; exit 0 ;;
        *State.Status*) pop "$STUB_DIR/status_queue"; exit 0 ;;
        *.Image*) echo "$STUB_PREVIOUS_IMAGE"; exit 0 ;;
      esac
    done
    exit 0
    ;;
  logs)
    echo "log line from the container"
    exit 0
    ;;
esac
echo "unhandled docker call: $*" >> "$STUB_DIR/calls"
exit 0
`

interface RunResult {
  status: number | null
  output: string
  calls: string[]
}

interface Scenario {
  statuses: string[]
  healths: string[]
  previous_image?: string
}

function run_deploy(scenario: Scenario): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-remote-'))
  const fakebin = join(dir, 'fakebin')
  mkdirSync(fakebin)
  // 替身脚本必须是 LF：CRLF 的定界符会被 sh 当成 token 的一部分（`echo ... >> file\r`），
  // 于是记录下来的每一行都带一个 CR，断言看起来会"莫名其妙"地不相等
  writeFileSync(join(fakebin, 'docker'), stub_docker.replaceAll('\r\n', '\n'))
  chmodSync(join(fakebin, 'docker'), 0o755)
  writeFileSync(join(dir, 'status_queue'), `${scenario.statuses.join('\n')}\n`)
  writeFileSync(join(dir, 'health_queue'), `${scenario.healths.join('\n')}\n`)
  writeFileSync(join(dir, 'calls'), '')

  const shell_dir = shell ? shell.replace(/[/\\][^/\\]+$/, '') : ''
  const result = spawnSync(shell!, [script_path], {
    cwd: dir,
    encoding: 'utf-8',
    env: {
      ... process.env,
      // 替身 docker 自己要用 head/sed/mv，脚本要用 sleep —— Windows 上这些只在
      // Git 的 usr/bin 里，所以连 shell 自己的目录一起挂上（Linux 上就是 /bin）
      PATH: [fakebin, shell_dir, process.env.PATH ?? ''].join(process.platform === 'win32' ? ';' : ':'),
      DEPLOY_DIR: dir,
      IMAGE: 'registry.example.com/ns/app:latest',
      ACR_USERNAME: 'user',
      ACR_PASSWORD: 'secret',
      // 采样窗口要短：这里测的是分支，不是真实等待
      HEALTH_ATTEMPTS: '3',
      HEALTH_INTERVAL_SECONDS: '0',
      STUB_DIR: dir,
      STUB_PREVIOUS_IMAGE: scenario.previous_image ?? '',
    },
  }) as SpawnSyncReturns<string>

  const calls = readFileSync(join(dir, 'calls'), 'utf-8').split('\n').filter(Boolean)
  rmSync(dir, { recursive: true, force: true })
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls }
}

const needs_shell = shell ? describe : describe.skip

needs_shell('deploy-remote.sh（用替身 docker 跑真实脚本）', () => {
  let saved_attempts: string | undefined

  beforeEach(() => {
    saved_attempts = process.env.HEALTH_ATTEMPTS
  })

  afterEach(() => {
    if (saved_attempts === undefined)
      delete process.env.HEALTH_ATTEMPTS
    else
      process.env.HEALTH_ATTEMPTS = saved_attempts
  })

  it('容器健康：部署成功，清悬空镜像，不碰旧镜像', () => {
    const result = run_deploy({
      statuses: ['running', 'running'],
      healths: ['starting', 'healthy'],
      previous_image: 'sha256:old',
    })

    expect(result.status).toBe(0)
    expect(result.output).toContain('部署完成')
    expect(result.calls.some(call => call.startsWith('image prune'))).toBe(true)
    expect(result.calls.some(call => call.startsWith('tag '))).toBe(false)
  })

  it('容器退出：回滚到 pull 之前那一版，站点自己恢复，部署以失败退出', () => {
    const result = run_deploy({
      // 第一轮（新镜像）：running/starting → exited；第二轮（回滚后）：running/healthy
      statuses: ['running', 'exited', 'running'],
      healths: ['starting', 'starting', 'healthy'],
      previous_image: 'sha256:old',
    })

    expect(result.status).not.toBe(0)
    expect(result.calls).toContain('tag sha256:old registry.example.com/ns/app:latest')
    expect(result.calls).toContain('compose up -d --force-recreate')
    expect(result.output).toContain('已回滚')
    expect(result.output).toContain('log line from the container')
    // 回滚路径绝不能删镜像：$previous_image 正是回滚锚点
    expect(result.calls.some(call => call.startsWith('image prune'))).toBe(false)
  })

  it('回滚后仍起不来：如实报出需要人工介入，不谎报恢复', () => {
    const result = run_deploy({
      statuses: ['exited', 'exited', 'exited', 'exited'],
      healths: ['starting'],
      previous_image: 'sha256:old',
    })

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('回滚后仍未就绪，需要人工介入')
    expect(result.output).not.toContain('已回滚')
  })

  it('容器陷入重启循环：同样判定为坏消息并回滚', () => {
    const result = run_deploy({
      statuses: ['restarting', 'running'],
      healths: ['starting', 'healthy'],
      previous_image: 'sha256:old',
    })

    expect(result.status).not.toBe(0)
    expect(result.calls).toContain('tag sha256:old registry.example.com/ns/app:latest')
    expect(result.output).toContain('已回滚')
  })

  it('没有可回滚的旧镜像（首次部署）：明确报出来，不做假的补救', () => {
    const result = run_deploy({ statuses: ['exited'], healths: ['starting'] })

    expect(result.status).not.toBe(0)
    expect(result.calls.some(call => call.startsWith('tag '))).toBe(false)
    expect(result.output).toContain('没有可回滚的旧镜像')
  })

  it('超时未就绪但仍在运行：让部署失败，但不降级线上', () => {
    const result = run_deploy({
      statuses: ['running', 'running', 'running'],
      healths: ['starting', 'starting', 'starting'],
      previous_image: 'sha256:old',
    })

    expect(result.status).not.toBe(0)
    expect(result.calls.some(call => call.startsWith('tag '))).toBe(false)
    expect(result.output).toContain('未自动回滚')
  })
})
