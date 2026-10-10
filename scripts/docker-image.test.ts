import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// These checks guard packaging contracts that cannot be reached through a module entry point.
const root = resolve(import.meta.dirname, '..')

function read(relative: string) {
  return readFileSync(resolve(root, relative), 'utf-8')
}

describe('镜像自带的运行期配置注入', () => {
  it('入口脚本直接透传命令，不再派生配置别名', () => {
    const script = read('docker-entrypoint.sh')

    expect(script).not.toMatch(/export |MQTT_WEB_URL/)
    // 作为入口执行时必须透传 CMD，否则迁移与服务都跑不起来
    expect(script).toMatch(/exec "\$@"/)
  })

  it('dockerfile 把运行时 YAML 与入口脚本装进镜像', () => {
    const dockerfile = read('Dockerfile')

    expect(dockerfile).toMatch(/^COPY config \.\/config$/m)
    expect(dockerfile).toMatch(/^COPY docker-entrypoint\.sh /m)
    // Windows 工作区检出的是 CRLF，#!/bin/sh\r 会让容器直接起不来，必须在镜像里剥掉；
    // 同理要补可执行位（Windows 检出没有）
    expect(dockerfile).toMatch(/^RUN sed -i 's\/\\r\$\/\/' .*docker-entrypoint\.sh && chmod \+x .*docker-entrypoint\.sh$/m)
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/usr\/local\/bin\/docker-entrypoint\.sh"\]$/m)
  })

  it('compose 不再重复承担注入，避免与镜像两处走岔', () => {
    // 注释里提到变量名是为了说明"不需要在这里映射"，所以只钉映射行本身
    expect(read('docker-compose.yml')).not.toMatch(/^\s+MQTT_WEB_URL:/m)
    expect(read('docker-compose.dev.yml')).not.toMatch(/^\s+MQTT_WEB_URL:/m)
  })
})

// 2026-10-09 事故的教训：镜像里一个字节的改动（连注释都算）可以让容器启动即失败，
// 而 CD 只报"部署成功"、站点静默 502 了很久。下面这些不变量只能读源码断言 ——
// 它们要么横跨镜像与服务器两份文件（compose 由 CD 送到服务器，本地看仓库这份永远是对的，
// 送不对或换不到位只在线上暴露），要么是"健康门必须真的接在某处"的接线。真实的判定行为由
// scripts/deploy-remote.test.ts 用替身 docker 跑真实脚本覆盖。
describe('部署的健康检查与自愈接线', () => {
  it('镜像自带探 /healthz 的 HEALTHCHECK，且运行时读 PORT', () => {
    const dockerfile = read('Dockerfile')

    expect(dockerfile).toMatch(/^HEALTHCHECK /m)
    expect(dockerfile).toMatch(/127\.0\.0\.1:'\+\(process\.env\.PORT\|\|3042\)\+'\/healthz'/)
    // 写死端口的话，用 APP_PORT 换端口部署的机器会永远 unhealthy
    expect(dockerfile).not.toMatch(/HEALTHCHECK[^\n]*3042\/healthz/)
    // 启动前要跑迁移，start-period 太短会把慢启动误判成不健康
    expect(dockerfile).toMatch(/HEALTHCHECK[^\n]*--start-period=/)
  })

  it('compose 探 /healthz（不是 /），并保留自愈所需的 restart 策略', () => {
    const app = parse(read('docker-compose.yml')).services.app

    // `/` 的 200 说明不了数据库可用：SSR 渲染外壳成功也会是 200
    expect(app.healthcheck.test).toEqual(['CMD', 'node', '-e', expect.stringMatching(/^fetch\("http:\/\/127\.0\.0\.1:\$\{APP_PORT\}\/healthz"\)/)])
    expect(app.healthcheck.test[3]).not.toMatch(/fetch\("http:\/\/127\.0\.0\.1:\$\{APP_PORT\}\/"\)/)
    // 容器崩了要能自己起来；没有这一行，"自愈"只剩健康门那半
    expect(app.restart).toBe('unless-stopped')
  })

  it('部署把远端序列交给 scripts/deploy-remote.sh 执行', () => {
    // 内联在 workflow 里的 SSH 命令谁也测不了；脚本可以在本地跑（见其同名测试）
    expect(read('.github/workflows/deploy.yml')).toMatch(/< scripts\/deploy-remote\.sh/)
  })

  it('只有 Check 成功后才部署，并部署同一个 commit', () => {
    const workflow = parse(read('.github/workflows/deploy.yml'))

    expect(workflow.on.workflow_run).toEqual({ workflows: ['Check'], types: ['completed'], branches: ['main'] })
    expect(workflow.jobs['build-and-deploy'].if).toBe('github.event.workflow_run.conclusion == \'success\'')
    expect(workflow.jobs['build-and-deploy'].steps[0].with.ref).toBe('$' + '{{ github.event.workflow_run.head_sha }}')
  })

  it('.env 由 CD 解密推送，服务器上不构建它', () => {
    const workflow = parse(read('.github/workflows/deploy.yml'))
    const deploy_step = workflow.jobs['build-and-deploy'].steps.find((step: { name?: string }) => step.name === 'Deploy to server')

    expect(deploy_step.env.ENV_PASSPHRASE).toBe('$' + '{{ secrets.ENV_PASSPHRASE }}')
    expect(deploy_step.run).toContain('gpg --batch --yes --pinentry-mode loopback --passphrase "$ENV_PASSPHRASE" --decrypt')
    expect(deploy_step.run).toContain('--output .env.prod .env.prod.gpg')
    expect(deploy_step.run).toContain('.env.incoming')
    // 服务器端只剩闸门，不再跑 build-env
    expect(read('scripts/deploy-remote.sh')).not.toMatch(/build-env/)
  })

  it('远端脚本按 compose 的服务名解析容器，不写死容器名', () => {
    const script = read('scripts/deploy-remote.sh')

    // 服务器上的 compose 会被 CD 覆盖成仓库这份，但容器名仍由 compose 里有没有
    // container_name 决定。写死名字 → docker inspect 报 No such container → 健康门
    // 永远看不到容器、回滚锚点也是空的：2026-10-09 第一次上线就踩了这个。
    expect(script).toMatch(/docker compose ps -q "\$SERVICE"/)
    expect(script).not.toMatch(/^CONTAINER=/m)
  })

  it('仓库的 compose 送到服务器，旧的那份留成备份', () => {
    const workflow = read('.github/workflows/deploy.yml')
    const script = read('scripts/deploy-remote.sh')

    // 这份文件以前只存在于服务器上，于是悄悄漂移（探针探 /、缺 container_name），
    // 而仓库里那份看着是好的 —— 现在仓库这份必须是唯一来源。
    expect(workflow).toMatch(/scp[^\n]*docker-compose\.yml/)
    expect(workflow).toMatch(/docker-compose\.yml\.incoming/)
    // 两份候选配置换入后联合校验；失败时恢复旧文件
    expect(script).toMatch(/docker compose config -q/)
    expect(script).toMatch(/cp -p \.env \.env\.bak/)
    expect(script).toMatch(/cp -p docker-compose\.yml docker-compose\.yml\.bak/)
  })
})
