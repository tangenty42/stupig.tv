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
