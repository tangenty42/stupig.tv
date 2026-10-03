#!/bin/sh
# 浏览器侧要用的 MQTT 地址（runtimeConfig.public.mqtt_web_url）在构建期烘焙不了：构建机
# 没有 .env（.dockerignore 排除），插值出来只能是空串，只能在容器启动时注入。
# 派生逻辑放在镜像里而不是 docker-compose.yml：CI 只 docker push 镜像，compose 文件是
# 服务器上单独维护的，靠它传递会悄悄走岔（漏注入时页面照常打开，只有浏览器连不上 broker）。
# 显式给出的 NUXT_PUBLIC_MQTT_WEB_URL 优先，这里只做兜底派生。
# 派生结果是否对得上，由 server/plugins/public-config-guard.ts 在启动时断言。
set -eu

if [ -z "${NUXT_PUBLIC_MQTT_WEB_URL:-}" ] && [ -n "${MQTT_WEB_URL:-}" ]; then
  export NUXT_PUBLIC_MQTT_WEB_URL="$MQTT_WEB_URL"
fi

exec "$@"
