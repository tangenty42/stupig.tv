import type { SpawnSyncReturns } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * `scripts/deploy/remote.sh` runs on the production server and decides whether a
 * deploy is kept or rolled back, so its decision logic is worth pinning rather
 * than trusting. It is POSIX shell — the one production artefact a unit test
 * cannot import — so this drives it for real, through `sh`, against a stub
 * `docker` that replays a scripted container state.
 *
 * The harness covers candidate config staging, complete rollback, and readiness gates.
 */

const repo_root = join(import.meta.dirname, '../..')
const script_path = join(repo_root, 'scripts/deploy/remote.sh')
const workflow_steps = parse(readFileSync(join(repo_root, '.github/workflows/deploy.yml'), 'utf8')).jobs['build-and-deploy'].steps as {
  name?: string
  env?: Record<string, string>
  run?: string
}[]

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
# 队列文件由测试写入；用 shell 内建读写，避免每次 inspect 额外启动 head/sed/mv。
# Git for Windows 的进程启动成本会让回滚场景超时，即使健康检查间隔为零。
pop() {
  file="$1"
  if [ ! -s "$file" ]; then
    echo "empty"
    return
  fi
  remainder=''
  {
    IFS= read -r first
    while IFS= read -r line; do
      remainder="$remainder$line
"
    done
  } < "$file"
  printf '%s\\n' "$first"
  printf '%s' "$remainder" > "$file"
}

case "$1" in
  exec)
    echo "$*" >> "$STUB_DIR/calls"
    case "$*" in
      *"SELECT @@server_uuid"*) echo '11111111-1111-1111-1111-111111111111' ;;
      *"information_schema.processlist"*|*"information_schema.triggers"*) echo 0 ;;
      *mysqldump*)
        [ -z "$STUB_BACKUP_FAILS" ] || exit 1
        echo 'INSERT INTO backup_ok VALUES (1);' ;;
    esac
    exit 0
    ;;
  login)
    echo "$*" >> "$STUB_DIR/calls"
    cat > "$STUB_DIR/login-password"
    exit 0
    ;;
  rm)
    echo "$*" >> "$STUB_DIR/calls"
    rm -f "$STUB_DIR/mqtt-created"
    exit 0
    ;;
  tag|image)
    echo "$*" >> "$STUB_DIR/calls"
    case "$1:$3" in tag:*@sha256:*) exit 1 ;; esac
    exit 0
    ;;
  compose)
    echo "$*" >> "$STUB_DIR/calls"
    # "compose ps -q <service>" 是脚本解析容器的方式（不靠固定容器名）。容器 ID
    # 故意取一个与任何名字都不像的值：写死 stupig-tv 的实现在这里就会暴露。
    case "$*" in
      *"release.mjs plan"*)
        [ -z "$STUB_PREFLIGHT_FAILS" ] || exit 1
        case "$*" in
          *"plan new"*)
            printf 'PLAN_ID=%s\\nMAINTENANCE_REQUIRED=%s\\nSQL_RECOVERY_REQUIRED=0\\nDB_HOST=mysql\\nDB_NAME=qa\\nDB_UUID=11111111-1111-1111-1111-111111111111\\nCLOUD_BACKFILL=0\\n' "$STUB_PLAN_ID" "$STUB_MAINTENANCE_REQUIRED" > "$candidate_dir/decision.env"
            echo '{}' > "$candidate_dir/plan.json" ;;
          *) [ -z "$STUB_PLAN_DRIFT" ] || exit 1 ;;
        esac
        ;;
      *"release.mjs verify-public"*) [ -z "$STUB_PUBLIC_FAILS" ] || exit 1 ;;
      *"release.mjs rollback"*) [ -z "$STUB_ROLLBACK_UNSAFE" ] || exit 1 ;;
      *"migrate.mjs --maintenance"*) [ -z "$STUB_MIGRATION_FAILS" ] || exit 1 ;;
      *"ps -q emqx"*)
        if [ -f "$STUB_DIR/mqtt-created" ] || [ -n "$STUB_PREVIOUS_MQTT_IMAGE" ]; then
          echo mqtt-service-id
        fi
        ;;
      *"ps -q"*) echo "$STUB_CONTAINER_ID" ;;
      *" up -d") : > "$STUB_DIR/mqtt-created" ;;
      # 校验送来的 compose：默认通过，STUB_COMPOSE_CONFIG_FAILS 非空则失败
      *"config -q"*) [ -n "\${STUB_COMPOSE_CONFIG_FAILS:-}" ] && exit 1 ;;
      *" pull"*) [ -n "\${STUB_COMPOSE_PULL_FAILS:-}" ] && exit 1 ;;
    esac
    exit 0
    ;;
  inspect)
    case "$*" in
      *State.Running*) echo true; exit 0 ;;
      *Config.Labels*) echo deploy-fixture; exit 0 ;;
    esac
    case "$*" in
      *mqtt-service-id*)
        for arg in "$@"; do
          case "$arg" in
            *State.Health*)
              if [ -s "$STUB_DIR/mqtt_health_queue" ]; then pop "$STUB_DIR/mqtt_health_queue"; else echo healthy; fi
              exit 0 ;;
            *State.Status*) echo running; exit 0 ;;
            *Config.Image*) echo "\${STUB_PREVIOUS_MQTT_REF:-registry.example.com/ns/app:mqtt}"; exit 0 ;;
            *.Image*) echo "$STUB_PREVIOUS_MQTT_IMAGE"; exit 0 ;;
          esac
        done
        ;;
    esac
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
  login_password: string | null
  /** 部署目录里留下什么（compose 换位/备份的断言要看它） */
  files: Record<string, string>
}

interface Scenario {
  maintenance_required?: boolean
  preflight_fails?: boolean
  public_fails?: boolean
  rollback_unsafe?: boolean
  mode?: 'normal' | 'maintenance'
  plan_drift?: boolean
  backup_fails?: boolean
  migration_fails?: boolean
  statuses: string[]
  healths: string[]
  previous_image?: string
  previous_mqtt_image?: string
  previous_mqtt_ref?: string
  mqtt_healths?: string[]
  /** 设为空字符串即模拟"compose 找不到该服务的容器" */
  container_id?: string
  /** 预置到部署目录的文件（用来模拟服务器上已有的 compose 与送来的那一份） */
  files?: Record<string, string>
  /** 让 `compose config` 校验失败（模拟送来的 compose 有问题） */
  compose_config_fails?: boolean
  /** 让镜像拉取失败 */
  compose_pull_fails?: boolean
  /** 部署目录里 .env.prod 的内容；null 表示不存在（默认是一份无占位符的最小文件） */
  env_content?: string | null
  /** CD 上传的 .env.prod.incoming 内容；null 表示候选文件缺失 */
  incoming_env_content?: string | null
  registry_username?: string | null
  registry_password?: string | null
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
  writeFileSync(join(dir, 'mqtt_health_queue'), `${(scenario.mqtt_healths ?? []).join('\n')}`)
  writeFileSync(join(dir, 'calls'), '')
  const env_content = scenario.env_content === undefined ? 'APP_PORT=3042\nDEPLOYMENT_ENV=old\n' : scenario.env_content
  if (env_content !== null) {
    writeFileSync(join(dir, '.env.prod'), env_content)
  }
  const incoming_env_content = scenario.incoming_env_content === undefined ? 'APP_PORT=3042\nDEPLOYMENT_ENV=new\n' : scenario.incoming_env_content
  if (incoming_env_content !== null) {
    writeFileSync(join(dir, '.env.prod.incoming'), incoming_env_content)
  }
  writeFileSync(join(dir, 'docker-compose.yml'), 'old-compose\n')
  writeFileSync(join(dir, 'docker-compose.yml.incoming'), 'new-compose\n')
  const plan_id = 'a'.repeat(64)
  if (scenario.mode === 'maintenance') {
    const pending = join(dir, '.release-plans', plan_id)
    mkdirSync(pending, { recursive: true })
    writeFileSync(join(pending, '.env.prod'), incoming_env_content ?? '')
    writeFileSync(join(pending, 'docker-compose.yml'), 'new-compose\n')
    writeFileSync(join(pending, 'plan.json'), '{}')
    writeFileSync(join(pending, 'decision.env'), `PLAN_ID=${plan_id}\nMAINTENANCE_REQUIRED=1\nSQL_RECOVERY_REQUIRED=0\nDB_HOST=mysql\nDB_NAME=qa\nDB_UUID=11111111-1111-1111-1111-111111111111\nCLOUD_BACKFILL=0\n`)
  }
  for (const [name, content] of Object.entries(scenario.files ?? {}))
    writeFileSync(join(dir, name), content)

  const shell_dir = shell ? shell.replace(/[/\\][^/\\]+$/, '') : ''
  // Source the real deploy script with a docker function in a subshell. This
  // retains command exit codes and variable isolation, but avoids launching a
  // new Git-for-Windows shell executable for every simulated Docker call.
  // Production still uses the unchanged executable / SSH entry point.
  const result = spawnSync(shell!, ['-c', 'flock() { :; }; docker() ( . "$STUB_DOCKER" ); . "$DEPLOY_SCRIPT"'], {
    cwd: dir,
    encoding: 'utf-8',
    env: {
      ... process.env,
      // 部署脚本要用 head/cp/mv/sleep 等命令 —— Windows 上这些只在
      // Git 的 usr/bin 里，所以连 shell 自己的目录一起挂上（Linux 上就是 /bin）
      PATH: [fakebin, shell_dir, process.env.PATH ?? ''].join(process.platform === 'win32' ? ';' : ':'),
      DEPLOY_DIR: dir,
      IMAGE: 'registry.example.com/ns/app:latest',
      ACR_USERNAME: scenario.registry_username === null ? undefined : scenario.registry_username ?? 'registry-user',
      ACR_PASSWORD: scenario.registry_password === null ? undefined : scenario.registry_password ?? 'registry-secret',
      // 采样窗口要短：这里测的是分支，不是真实等待
      HEALTH_ATTEMPTS: '3',
      HEALTH_INTERVAL_SECONDS: '0',
      DEPLOY_MODE: scenario.mode ?? 'normal',
      APPROVED_PLAN_ID: plan_id,
      CONFIRM_MAINTENANCE: 'true',
      STUB_PLAN_ID: plan_id,
      STUB_MAINTENANCE_REQUIRED: scenario.maintenance_required ? '1' : '0',
      STUB_PREFLIGHT_FAILS: scenario.preflight_fails ? '1' : '',
      STUB_PUBLIC_FAILS: scenario.public_fails ? '1' : '',
      STUB_ROLLBACK_UNSAFE: scenario.rollback_unsafe ? '1' : '',
      STUB_PLAN_DRIFT: scenario.plan_drift ? '1' : '',
      STUB_BACKUP_FAILS: scenario.backup_fails ? '1' : '',
      STUB_MIGRATION_FAILS: scenario.migration_fails ? '1' : '',
      STUB_DIR: dir,
      STUB_DOCKER: join(fakebin, 'docker'),
      DEPLOY_SCRIPT: script_path,
      STUB_PREVIOUS_IMAGE: scenario.previous_image ?? '',
      STUB_PREVIOUS_MQTT_IMAGE: scenario.previous_mqtt_image ?? '',
      STUB_PREVIOUS_MQTT_REF: scenario.previous_mqtt_ref ?? '',
      STUB_CONTAINER_ID: scenario.container_id ?? 'a1b2c3d4e5f6',
      STUB_COMPOSE_CONFIG_FAILS: scenario.compose_config_fails ? '1' : '',
      STUB_COMPOSE_PULL_FAILS: scenario.compose_pull_fails ? '1' : '',
    },
  }) as SpawnSyncReturns<string>

  const calls = readFileSync(join(dir, 'calls'), 'utf-8').split('\n').filter(Boolean)
  const files: Record<string, string> = {}
  for (const name of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    // 队列/记录文件是测试自己的脚手架，不是被测对象留下的东西
    if (name.isDirectory() || name.parentPath.includes('fakebin') || ['fakebin', 'status_queue', 'health_queue', 'mqtt_health_queue', 'mqtt-created', 'calls', 'login-password'].includes(name.name))
      continue
    const path = join(name.parentPath, name.name)
    files[path.slice(dir.length + 1).replaceAll('\\', '/')] = readFileSync(path, 'utf-8')
  }
  const password_path = join(dir, 'login-password')
  const login_password = existsSync(password_path) ? readFileSync(password_path, 'utf8') : null
  rmSync(dir, { recursive: true, force: true })
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls, files, login_password }
}

const needs_shell = shell ? describe : describe.skip

describe('registry identity workflow wiring', () => {
  it.skipIf(! shell)('allows documentation-only main advances and rejects superseded runtime code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-source-'))
    const origin = join(dir, 'origin')
    const checkout = join(dir, 'checkout')
    mkdirSync(origin)
    const git = (args: string[], cwd = origin) => {
      const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ... args], { cwd, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      return result.stdout.trim()
    }
    try {
      git(['init', '-b', 'main'])
      git(['config', 'user.name', 'Deployment fixture'])
      git(['config', 'user.email', 'fixture@localhost'])
      writeFileSync(join(origin, 'runtime.js'), 'export default 1\n')
      writeFileSync(join(origin, 'README.md'), 'initial\n')
      git(['add', '.'])
      git(['commit', '-m', 'test(deploy): seed source fixture'])
      const source = git(['rev-parse', 'HEAD'])
      git(['clone', '--no-local', '--depth=1', origin, checkout], dir)
      writeFileSync(join(origin, 'README.md'), 'documentation update\n')
      mkdirSync(join(origin, 'docs'))
      writeFileSync(join(origin, 'docs', 'notes.txt'), 'notes\n')
      git(['add', '.'])
      git(['commit', '-m', 'docs(deploy): update fixture notes'])
      const script = workflow_steps.find(step => step.name === 'Reject superseded release sources')!.run!
      const probe = () => spawnSync(shell!, ['-c', script], { cwd: checkout, encoding: 'utf8', env: { ... process.env, RELEASE_SHA: source } })
      const same_runtime = probe()
      expect(same_runtime.status, same_runtime.stderr).toBe(0)
      writeFileSync(join(origin, 'runtime.js'), 'export default 2\n')
      git(['add', '.'])
      git(['commit', '-m', 'fix(deploy): replace fixture runtime'])
      expect(probe().status).not.toBe(0)
    }
    finally {
      expect(dirname(dir)).toBe(tmpdir())
      expect(basename(dir).startsWith('deploy-source-')).toBe(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20000)

  it.skipIf(! shell)('parses every ordinary and maintenance shell step', () => {
    const maintenance = parse(readFileSync(join(repo_root, '.github/workflows/maintenance-deploy.yml'), 'utf8')).jobs.maintenance.steps as typeof workflow_steps
    for (const step of [... workflow_steps, ... maintenance].filter(step => step.run)) {
      const result = spawnSync(shell!, ['-n'], { input: step.run, encoding: 'utf8' })
      expect(result.status, `${step.name}: ${result.stderr}`).toBe(0)
    }
  })

  it('builds and publishes the dedicated MQTT target alongside the application', () => {
    const build = workflow_steps.find(step => step.name === 'Build and push image')!
    expect(build.run).toContain('docker build --target mqtt -t "$IMAGE:mqtt" -t "$IMAGE:mqtt-$RELEASE_SHA" .')
    expect(build.run).toContain('docker push "$IMAGE:mqtt"')
    expect(build.run).toContain('docker push "$IMAGE:mqtt-$RELEASE_SHA"')
    expect(build.run).toContain('docker image inspect "$IMAGE:$RELEASE_SHA"')
    expect(build.run).toContain('APP_IMAGE=%s')
    expect(build.run).toContain('"draft_protocol":"cloud-v1"')
    expect(build.run).toContain('CONTENT_DRAFT_PROTOCOL=cloud-v1')
  })

  it('uses the same Registry secrets for CI and the host and checks them before building', () => {
    const check = workflow_steps.find(step => step.name === 'Check registry credentials')!
    const build = workflow_steps.find(step => step.name === 'Build and push image')!
    const deploy = workflow_steps.find(step => step.name === 'Deploy to server')!
    expect(workflow_steps.indexOf(check)).toBeGreaterThanOrEqual(0)
    expect(workflow_steps.indexOf(check)).toBeLessThan(workflow_steps.indexOf(build))
    expect(workflow_steps.indexOf(check)).toBeLessThan(workflow_steps.indexOf(deploy))
    expect(build.env).toMatchObject({ ACR_USERNAME: '$' + '{{ secrets.ACR_USERNAME }}', ACR_PASSWORD: '$' + '{{ secrets.ACR_PASSWORD }}' })
    expect(build.env!.RELEASE_SHA).toBe('$' + '{{ github.event.workflow_run.head_sha }}')
    expect(build.env).toMatchObject(check.env!)
    expect(deploy.env).toMatchObject(check.env!)
    expect(deploy.env).not.toHaveProperty('ACR_PULL_USERNAME')
    expect(deploy.env).not.toHaveProperty('ACR_PULL_PASSWORD')
    expect(deploy.run).not.toMatch(/secrets\.ACR_(?:USERNAME|PASSWORD)/)
    expect(deploy.run).toContain('cat scripts/deploy/remote.sh')
    expect(deploy.run).toContain('} | ssh')
  })
})

needs_shell('registry credential transport', () => {
  const shell_environment = {
    PATH: [shell?.replace(/[/\\][^/\\]+$/, '') ?? '', process.env.PATH ?? ''].join(process.platform === 'win32' ? ';' : ':'),
    SystemRoot: process.env.SystemRoot,
  }
  const credentials = { ACR_USERNAME: 'registry-user', ACR_PASSWORD: 'registry-password' }
  const check_script = workflow_steps.find(step => step.name === 'Check registry credentials')!.run!

  it('accepts one complete Registry identity without separate pull credentials', () => {
    const result = spawnSync(shell!, ['-c', check_script], { env: { ... shell_environment, ... credentials }, encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it.each(Object.keys(credentials))('rejects an empty %s before deployment', (key) => {
    const result = spawnSync(shell!, ['-c', check_script], { env: { ... shell_environment, ... credentials, [key]: '' }, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`Missing ${key}`)
    expect(result.stdout).toBe('')
  })

  it('preserves quotes, spaces and shell metacharacters through the actual SSH stdin prefix', () => {
    const run = workflow_steps.find(step => step.name === 'Deploy to server')!.run!
    const stream = run.match(/^\{\n[\s\S]*?^\} \| ssh/m)?.[0]
    expect(stream).toBeDefined()
    const password = 'pull \' " $HOME $(printf injected) `printf injected` \\ !'
    // Replace only script output/SSH with a receiver probe; execute the workflow's
    // actual encoding and shell assignment, without touching a host or Docker.
    const probe = 'printf %s "$ACR_USERNAME" | base64 -w0; printf "\\n"; printf %s "$ACR_PASSWORD" | base64 -w0; printf "\\n"'
    const command = `cat() { printf '%s' "$REMOTE_PROBE"; }\n${stream!.replace(/\| ssh$/, '| sh')}`
    const result = spawnSync(shell!, ['-c', command], {
      env: { ... shell_environment, ACR_USERNAME: credentials.ACR_USERNAME, ACR_PASSWORD: password, REMOTE_PROBE: probe }, encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${Buffer.from(credentials.ACR_USERNAME).toString('base64')}\n${Buffer.from(password).toString('base64')}\n`)
    expect(result.stderr).toBe('')
  })
})

needs_shell('deploy-remote.sh（用替身 docker 跑真实脚本）', () => {
  it('blocks maintenance before replacing configuration or stopping the old application', () => {
    const result = run_deploy({ statuses: [], healths: [], previous_image: 'sha256:old-app', maintenance_required: true })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('旧服务未切换')
    expect(result.files['.env.prod']).toContain('DEPLOYMENT_ENV=old')
    expect(result.files[`.release-plans/${'a'.repeat(64)}/plan.json`]).toBeDefined()
    expect(result.calls.some(call => / up | stop |--maintenance/.test(call))).toBe(false)
  })

  it('rejects a changed approved plan before stopping writers', () => {
    const result = run_deploy({ statuses: [], healths: [], previous_image: 'sha256:old-app', mode: 'maintenance', plan_drift: true })
    expect(result.status).not.toBe(0)
    expect(result.calls.some(call => call.endsWith('stop app'))).toBe(false)
    expect(result.files['.env.prod']).toContain('DEPLOYMENT_ENV=old')
  })

  it('backs up and restores in isolation before maintenance, then verifies public routes', () => {
    const result = run_deploy({ statuses: ['running'], healths: ['healthy'], previous_image: 'sha256:old-app', mode: 'maintenance' })
    expect(result.output, result.calls.join('\n')).toContain('部署完成')
    expect(result.status).toBe(0)
    const stopped = result.calls.findIndex(call => call.endsWith('stop app'))
    const dump = result.calls.findIndex(call => call.includes('mysqldump'))
    const migrated = result.calls.findIndex(call => call.includes('migrate.mjs --maintenance'))
    const started = result.calls.findIndex(call => call.endsWith('up -d'))
    expect(stopped).toBeLessThan(dump)
    expect(dump).toBeLessThan(migrated)
    expect(migrated).toBeLessThan(started)
    expect(result.calls.some(call => call.includes('DROP DATABASE'))).toBe(true)
    expect(result.calls.some(call => call.includes('verify-public'))).toBe(true)
    expect(Object.values(result.files)).toContain('all-table-restored-data=byte-identical\n')
  }, 20000)

  it('resumes the old service if backup fails before production migration starts', () => {
    const result = run_deploy({ statuses: ['running'], healths: ['healthy'], previous_image: 'sha256:old-app', mode: 'maintenance', backup_fails: true })
    expect(result.status).not.toBe(0)
    expect(result.calls.some(call => call.includes('migrate.mjs --maintenance'))).toBe(false)
    expect(result.calls.some(call => call.includes('up -d --force-recreate'))).toBe(true)
    expect(result.files['.env.prod']).toContain('DEPLOYMENT_ENV=old')
  }, 20000)

  it('retains stopped writers and recovery evidence after maintenance starts failing', () => {
    const result = run_deploy({ statuses: [], healths: [], previous_image: 'sha256:old-app', mode: 'maintenance', migration_fails: true })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('维护恢复状态')
    expect(result.calls.some(call => call.includes('up -d'))).toBe(false)
    expect(Object.keys(result.files).some(name => name.endsWith('/database.sql'))).toBe(true)
  }, 20000)

  it('rejects healthy containers when public WSS acceptance fails', () => {
    const result = run_deploy({ statuses: ['running', 'running'], healths: ['healthy', 'healthy'], previous_image: 'sha256:old-app', public_fails: true })
    expect(result.status).not.toBe(0)
    expect(result.output).not.toContain('部署完成')
    expect(result.calls.some(call => call.includes('up -d --force-recreate'))).toBe(true)
  })

  it('keeps the application stopped when schema compatibility cannot be established', () => {
    const result = run_deploy({ statuses: ['exited'], healths: ['unhealthy'], previous_image: 'sha256:old-app', rollback_unsafe: true })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('维护恢复状态')
    expect(result.calls.some(call => call.includes('up -d --force-recreate'))).toBe(false)
  })

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

  it('cleans publisher credentials from old backups after a successful deploy', () => {
    const old = 'APP_PORT=3042\nALIYUN_ESA_PUBLISH_ACCESS_KEY_ID=old-id\nALIYUN_ESA_PUBLISH_ACCESS_KEY_SECRET="old-secret"\nMYSQL_PASSWORD="keep # this"\n'
    const result = run_deploy({ statuses: ['running'], healths: ['healthy'], env_content: old, files: { '.env.legacy.bak': old } })
    expect(result.status).toBe(0)
    expect(result.files['.env.prod.bak']).toBe('APP_PORT=3042\nMYSQL_PASSWORD="keep # this"\n')
    expect(result.files['.env.legacy.bak']).toBe(result.files['.env.prod.bak'])
  }, 15_000)

  it('preserves an unsupported multiline backup and warns without breaking a healthy deployment', () => {
    const old = 'APP_PORT=3042\nOTHER="first\nsecond"\nALIYUN_ESA_PUBLISH_ACCESS_KEY_SECRET=old-secret\n'
    const result = run_deploy({ statuses: ['running'], healths: ['healthy'], env_content: old })
    expect(result.status).toBe(0)
    expect(result.files['.env.prod.bak']).toBe(old)
    expect(result.output).toContain('无法安全清理 .env.prod.bak')
  }, 15_000)

  it('keeps the exact old environment available when a deployment rolls back', () => {
    const old = 'APP_PORT=3042\nALIYUN_ESA_PUBLISH_ACCESS_KEY_SECRET=old-secret\n'
    const result = run_deploy({ statuses: ['exited', 'running'], healths: ['unhealthy', 'healthy'], previous_image: 'sha256:old', env_content: old })
    expect(result.status).not.toBe(0)
    expect(result.files['.env.prod']).toBe(old)
    expect(result.files['.env.prod.bak']).toBe(old)
  }, 15_000)

  it('stops a failed first cloud-draft cutover instead of restarting an unleased legacy writer', () => {
    const result = run_deploy({ statuses: ['exited'], healths: ['unhealthy'], previous_image: 'sha256:legacy',
      incoming_env_content: 'APP_PORT=3042\nCONTENT_DRAFT_PROTOCOL=cloud-v1\n' })
    expect(result.status).not.toBe(0)
    expect(result.calls.some(call => call.endsWith('stop app'))).toBe(true)
    expect(result.calls.some(call => call.includes('up -d --force-recreate'))).toBe(false)
    expect(result.files['.env.prod']).toContain('CONTENT_DRAFT_PROTOCOL=cloud-v1')
  }, 15_000)

  it('restores both images and checks both services when an existing managed deployment fails', () => {
    const result = run_deploy({
      statuses: ['exited', 'running'],
      healths: ['unhealthy', 'healthy'],
      previous_image: 'sha256:old-app',
      previous_mqtt_image: 'sha256:old-mqtt',
    })
    expect(result.status).not.toBe(0)
    expect(result.calls).toContain('tag sha256:old-mqtt registry.example.com/ns/app:mqtt')
    expect(result.calls).toContain('tag sha256:old-app registry.example.com/ns/app:latest')
    expect(result.calls).not.toContain('rm -f mqtt-service-id')
    expect(result.output).toContain('已完整回滚')
  })

  it('restores a compatible cloud release by digest without trying to tag a digest destination', () => {
    const pinned = `registry.example.com/ns/app@sha256:${'a'.repeat(64)}`
    const result = run_deploy({ statuses: ['exited', 'running'], healths: ['unhealthy', 'healthy'], previous_image: 'sha256:old-app',
      previous_mqtt_image: 'sha256:old-mqtt', previous_mqtt_ref: pinned,
      env_content: `APP_IMAGE=${pinned}\nMQTT_IMAGE=${pinned}\nCONTENT_DRAFT_PROTOCOL=cloud-v1\n`,
      incoming_env_content: 'APP_PORT=3042\nCONTENT_DRAFT_PROTOCOL=cloud-v1\n' })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('已完整回滚')
    expect(result.calls).not.toContain(`tag sha256:old-mqtt ${pinned}`)
    expect(result.files['.env.prod']).toContain(`MQTT_IMAGE=${pinned}`)
  })

  it('removes only the newly introduced broker container on a failed migration and retains its volume', () => {
    const result = run_deploy({
      statuses: ['exited', 'running'], healths: ['unhealthy', 'healthy'], previous_image: 'sha256:old-app',
    })
    expect(result.status).not.toBe(0)
    expect(result.calls).toContain('rm -f mqtt-service-id')
    expect(result.calls.some(call => call.startsWith('rm ') && call.includes('-v'))).toBe(false)
    expect(result.files['docker-compose.yml']).toBe('old-compose\n')
    expect(result.output).toContain('已完整回滚')
  })

  it('rejects an unhealthy broker even if the application could report healthy', () => {
    const result = run_deploy({
      statuses: ['running'], healths: ['healthy'], previous_image: 'sha256:old-app',
      previous_mqtt_image: 'sha256:old-mqtt', mqtt_healths: ['unhealthy', 'unhealthy', 'unhealthy', 'healthy'],
    })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('项目 MQTT broker 未就绪')
    expect(result.output).not.toContain('log line from the container')
    expect(result.output).toContain('容器日志保留在服务器')
    expect(Object.entries(result.files).some(([name, value]) => name.startsWith('.deploy-failure-emqx.') && value.includes('log line from the container'))).toBe(true)
    expect(result.output).toContain('已完整回滚')
    expect(result.calls.some(call => call.startsWith('image prune'))).toBe(false)
  })

  it('logs Docker in with the shared Registry identity and sends the exact password through stdin', () => {
    const password = 'pull \' " $HOME $(printf injected) `printf injected` \\ !'
    const result = run_deploy({ statuses: ['running'], healths: ['healthy'], registry_password: password })
    expect(result.status).toBe(0)
    expect(result.calls).toContain('login registry.example.com -u registry-user --password-stdin')
    expect(result.login_password).toBe(password)
    expect(result.output).not.toContain(password)
  }, 15_000)

  it.each(['registry_username', 'registry_password'] as const)('rejects missing %s before Docker/config changes', (field) => {
    const result = run_deploy({ statuses: [], healths: [], [field]: null })
    expect(result.status).not.toBe(0)
    expect(result.calls).toEqual([])
    expect(result.login_password).toBeNull()
    expect(result.files['.env.prod']).toContain('DEPLOYMENT_ENV=old')
    expect(result.files['docker-compose.yml']).toBe('old-compose\n')
  })

  it('migrates an existing legacy .env deployment only after the new release is healthy', () => {
    const old = 'APP_PORT=3042\nDEPLOYMENT_ENV=legacy\n'
    const result = run_deploy({
      statuses: ['running'], healths: ['healthy'], previous_image: 'sha256:old',
      env_content: null, files: { '.env': old },
    })
    expect(result.status).toBe(0)
    expect(result.calls).toContain('compose --env-file .env ps -q app')
    expect(result.calls).toContain('compose --env-file .env.prod up -d')
    expect(result.files['.env']).toBeUndefined()
    expect(result.files['.env.legacy.bak']).toBe(old)
    expect(result.files['.env.prod.bak']).toBe(old)
    expect(result.files['.env.prod']).toContain('DEPLOYMENT_ENV=new')
  }, 15_000)

  it('restores a legacy .env and its old compose on failed migration to the new filename', () => {
    const old = 'APP_PORT=3042\nDEPLOYMENT_ENV=legacy\n'
    const result = run_deploy({
      statuses: ['exited', 'running'], healths: ['unhealthy', 'healthy'], previous_image: 'sha256:old',
      env_content: null, files: { '.env': old },
    })
    expect(result.status).not.toBe(0)
    expect(result.files['.env']).toBe(old)
    expect(result.files['.env.prod']).toBeUndefined()
    expect(result.files['docker-compose.yml']).toBe('old-compose\n')
    expect(result.calls).toContain('compose --env-file .env up -d --force-recreate')
    expect(result.output).toContain('已完整回滚')
  }, 15_000)

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
    expect(result.files['.env.prod']).toContain('DEPLOYMENT_ENV=new')
    expect(result.files['.env.prod.bak']).toContain('DEPLOYMENT_ENV=old')
    expect(result.files['docker-compose.yml']).toBe('new-compose\n')
    expect(result.files['docker-compose.yml.bak']).toBe('old-compose\n')
    expect(result.files['.env.prod.incoming']).toBeUndefined()
    expect(result.files['docker-compose.yml.incoming']).toBeUndefined()
    // 容器是问 compose 要的，不是写死名字找的（服务器上叫 stupig-tv-app-1）
    expect(result.calls).toContain('compose --env-file .env.prod ps -q app')
    expect(result.output).toContain('a1b2c3d4e5f6')
  }, 15_000)

  it('.env.prod.incoming 缺失：中止部署，不碰运行中的容器', () => {
    const result = run_deploy({
      statuses: ['running'],
      healths: ['healthy'],
      previous_image: 'sha256:old',
      incoming_env_content: null,
    })

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('.env.prod.incoming')
    // 在 up 之前中止：容器与镜像标签都不动，也就不需要回滚
    expect(result.calls.some(call => call.startsWith('compose up'))).toBe(false)
    expect(result.calls.some(call => call.startsWith('tag '))).toBe(false)
  })

  it('.env.prod 还有 <required> 占位符：同样中止部署', () => {
    const result = run_deploy({
      statuses: ['running'],
      healths: ['healthy'],
      previous_image: 'sha256:old',
      incoming_env_content: 'APP_PORT=3042\nACR_IMAGE=<required>\n',
    })

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('<required> 占位符未填')
    expect(result.calls.some(call => call.startsWith('compose up'))).toBe(false)
    expect(result.calls.some(call => call.startsWith('tag '))).toBe(false)
  })

  it('镜像拉取失败：保留旧配置与运行容器', () => {
    const result = run_deploy({
      statuses: ['running'],
      healths: ['healthy'],
      previous_image: 'sha256:old',
      compose_pull_fails: true,
    })

    expect(result.status).not.toBe(0)
    expect(result.files['.env.prod']).toContain('DEPLOYMENT_ENV=old')
    expect(result.files['docker-compose.yml']).toBe('old-compose\n')
    expect(result.calls.some(call => call.startsWith('tag '))).toBe(false)
    expect(result.calls.some(call => call.startsWith('compose up'))).toBe(false)
    expect(result.files['.env.prod.incoming']).toContain('DEPLOYMENT_ENV=new')
    expect(result.files['docker-compose.yml.incoming']).toBe('new-compose\n')
  })

  it('compose 里找不到容器：当作确定的坏消息，而不是干等超时', () => {
    const result = run_deploy({
      statuses: [],
      healths: [],
      container_id: '',
    })

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('没找到 app 服务的容器')
    // 找不到容器时等满窗口毫无意义：应当立刻判失败
    expect(result.output).not.toContain('等待')
    expect(result.output).toContain('没有旧镜像可恢复')
  })

  it('容器退出：旧镜像、.env.prod 和 compose 一起回滚', () => {
    const result = run_deploy({
      // 第一轮（新镜像）：running/starting → exited；第二轮（回滚后）：running/healthy
      statuses: ['running', 'exited', 'running'],
      healths: ['starting', 'starting', 'healthy'],
      previous_image: 'sha256:old',
    })

    expect(result.status).not.toBe(0)
    expect(result.calls).toContain('tag sha256:old registry.example.com/ns/app:latest')
    expect(result.calls).toContain('compose --env-file .env.prod up -d --force-recreate')
    expect(result.output).toContain('已完整回滚')
    expect(result.files['.env.prod']).toContain('DEPLOYMENT_ENV=old')
    expect(result.files['.env.prod.bak']).toBe('APP_PORT=3042\nDEPLOYMENT_ENV=old\n')
    expect(result.files['docker-compose.yml']).toBe('old-compose\n')
    expect(result.files['docker-compose.yml.bak']).toBe('old-compose\n')
    expect(result.output).not.toContain('log line from the container')
    expect(result.output).toContain('容器日志保留在服务器')
    expect(Object.entries(result.files).some(([name, value]) => name.startsWith('.deploy-failure-app.') && value.includes('log line from the container'))).toBe(true)
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
    expect(result.output).toContain('自动回滚未能完全完成，需要人工检查部署目录与容器')
    expect(result.output).not.toContain('已完整回滚')
    expect(result.files['.env.prod']).toContain('DEPLOYMENT_ENV=old')
    expect(result.files['docker-compose.yml']).toBe('old-compose\n')
  })

  it('容器陷入重启循环：同样判定为坏消息并回滚', () => {
    const result = run_deploy({
      statuses: ['restarting', 'running'],
      healths: ['starting', 'healthy'],
      previous_image: 'sha256:old',
    })

    expect(result.status).not.toBe(0)
    expect(result.calls).toContain('tag sha256:old registry.example.com/ns/app:latest')
    expect(result.output).toContain('已完整回滚')
  })

  it('首次部署失败：恢复配置文件并说明没有旧镜像可恢复', () => {
    const result = run_deploy({
      statuses: ['exited'],
      healths: ['starting'],
      previous_image: '',
      env_content: null,
      files: { 'docker-compose.yml': 'old-compose\n' },
    })

    expect(result.status).not.toBe(0)
    expect(result.calls.some(call => call.startsWith('tag '))).toBe(false)
    expect(result.output).toContain('没有旧镜像可恢复')
    expect(result.files['.env.prod']).toBeUndefined()
    expect(result.files['docker-compose.yml']).toBe('old-compose\n')
  })

  it('超时未就绪仍会恢复旧镜像、.env.prod 与 compose', () => {
    const result = run_deploy({
      statuses: ['running', 'running', 'running', 'running'],
      healths: ['starting', 'starting', 'starting', 'healthy'],
      previous_image: 'sha256:old',
    })

    expect(result.status).not.toBe(0)
    expect(result.calls).toContain('tag sha256:old registry.example.com/ns/app:latest')
    expect(result.calls).toContain('compose --env-file .env.prod up -d --force-recreate')
    expect(result.output).toContain('已完整回滚')
    expect(result.files['.env.prod']).toContain('DEPLOYMENT_ENV=old')
    expect(result.files['docker-compose.yml']).toBe('old-compose\n')
  }, 15_000)

  it('送来的 compose 换到位，服务器上那份留成备份', () => {
    const result = run_deploy({
      statuses: ['running'],
      healths: ['healthy'],
      previous_image: 'sha256:old',
      files: {
        'docker-compose.yml': 'old-compose\n',
        'docker-compose.yml.incoming': 'new-compose\n',
      },
    })

    expect(result.status).toBe(0)
    expect(result.files['docker-compose.yml']).toBe('new-compose\n')
    expect(result.files['docker-compose.yml.bak']).toBe('old-compose\n')
    expect(result.files['docker-compose.yml.incoming']).toBeUndefined()
    // 换文件前要先校验：坏文件会把下次部署也一起弄坏
    expect(result.output).toContain('候选 .env.prod 与 compose 已切换')
  })

  it('送来的 compose 校验不过：保留服务器上那份，且不去动容器', () => {
    const result = run_deploy({
      statuses: ['running'],
      healths: ['healthy'],
      previous_image: 'sha256:old',
      compose_config_fails: true,
      files: {
        'docker-compose.yml': 'old-compose\n',
        'docker-compose.yml.incoming': 'broken: [\n',
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.files['.env.prod']).toBe('APP_PORT=3042\nDEPLOYMENT_ENV=old\n')
    expect(result.files['.env.prod.bak']).toBeUndefined()
    expect(result.files['docker-compose.yml']).toBe('old-compose\n')
    expect(result.files['docker-compose.yml.bak']).toBeUndefined()
    expect(result.output).toContain('校验失败')
    // 连镜像都不该拉：这一步失败就已经决定这次部署不成立
    expect(result.calls.some(call => call.startsWith('compose pull'))).toBe(false)
  })
})
