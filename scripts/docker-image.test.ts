import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// 这条不变量只能读源码来断言：浏览器侧的 MQTT 地址构建期烘焙不了，唯一的注入通道是
// 镜像自带的入口脚本。CI 只 push 镜像、compose 文件在服务器上单独维护，所以一旦把派生
// 逻辑挪回 docker-compose.yml（或漏掉 ENTRYPOINT），生产会以"页面正常、浏览器连不上
// broker"或"容器起不来"的形式炸掉，而本地与单测全都看不出来。脚本本身的运行行为由
// 镜像构建时的实测覆盖，这里只钉住"镜像确实带着这段派生逻辑"。
const root = resolve(import.meta.dirname, '..')

function read(relative: string) {
  return readFileSync(resolve(root, relative), 'utf-8')
}

describe('镜像自带的运行期配置注入', () => {
  it('入口脚本从 MQTT_WEB_URL 派生 NUXT_PUBLIC_MQTT_WEB_URL，且显式值优先', () => {
    const script = read('docker-entrypoint.sh')

    // 必须真的 export 出去：只赋值的话子进程看不到，注入等于没做
    expect(script).toMatch(/^ {2}export NUXT_PUBLIC_MQTT_WEB_URL="\$MQTT_WEB_URL"$/m)
    // 兜底而非覆盖：显式设置过的 NUXT_PUBLIC_MQTT_WEB_URL 必须原样保留
    expect(script).toMatch(/if \[ -z "\$\{NUXT_PUBLIC_MQTT_WEB_URL:-\}" \]/)
    // 作为入口执行时必须透传 CMD，否则迁移与服务都跑不起来
    expect(script).toMatch(/exec "\$@"/)
  })

  it('dockerfile 把入口脚本装进镜像并设为 ENTRYPOINT', () => {
    const dockerfile = read('Dockerfile')

    expect(dockerfile).toMatch(/^COPY docker-entrypoint\.sh /m)
    // Windows 工作区检出的是 CRLF，#!/bin/sh\r 会让容器直接起不来，必须在镜像里剥掉；
    // 同理要补可执行位（Windows 检出没有）
    expect(dockerfile).toMatch(/^RUN sed -i 's\/\\r\$\/\/' .*docker-entrypoint\.sh && chmod \+x .*docker-entrypoint\.sh$/m)
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/usr\/local\/bin\/docker-entrypoint\.sh"\]$/m)
  })

  it('compose 不再重复承担注入，避免与镜像两处走岔', () => {
    // 注释里提到变量名是为了说明"不需要在这里映射"，所以只钉映射行本身
    expect(read('docker-compose.yml')).not.toMatch(/^\s+NUXT_PUBLIC_MQTT_WEB_URL:/m)
    expect(read('docker-compose.dev.yml')).not.toMatch(/^\s+NUXT_PUBLIC_MQTT_WEB_URL:/m)
  })
})

// 2026-10-09 事故的教训：镜像里一个字节的改动（连注释都算）可以让容器启动即失败，
// 而 CD 只报"部署成功"、站点静默 502 了很久。下面这些不变量同样只能读源码断言 ——
// 它们要么跨镜像与服务器两份文件（compose 在服务器上单独维护，改错不会本地报错），
// 要么是"健康门必须真的接在某处"的接线。真实的判定行为由
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
    const compose = read('docker-compose.yml')

    // `/` 的 200 说明不了数据库可用：SSR 渲染外壳成功也会是 200
    expect(compose).toMatch(/test: \[CMD, node, -e, 'fetch\("http:\/\/127\.0\.0\.1:\$\{APP_PORT\}\/healthz"\)/)
    expect(compose).not.toMatch(/fetch\("http:\/\/127\.0\.0\.1:\$\{APP_PORT\}\/"\)/)
    // 容器崩了要能自己起来；没有这一行，"自愈"只剩健康门那半
    expect(compose).toMatch(/^\s+restart: unless-stopped$/m)
  })

  it('cD 把远端序列交给 scripts/deploy-remote.sh 执行', () => {
    // 内联在 workflow 里的 SSH 命令谁也测不了；脚本可以在本地跑（见其同名测试）
    expect(read('.github/workflows/deploy.yml')).toMatch(/< scripts\/deploy-remote\.sh/)
  })
})
