#!/bin/sh
# 浏览器侧要用的 MQTT 地址（runtimeConfig.public.mqtt_web_url）在构建期烘焙不了：构建机
# 没有 .env（.dockerignore 排除），插值出来只能是空串，只能在容器启动时注入。
# 派生逻辑放在镜像里而不是 docker-compose.yml：镜像可以脱离 compose 单独运行
# （`docker run` 也要能起来），而且镜像里的东西跟着镜像一起被验证，不依赖部署那一步
# 是否把 compose 送到位。显式给出的 NUXT_PUBLIC_MQTT_WEB_URL 优先，这里只做兜底派生。
# 派生结果是否对得上，由 server/plugins/public-config-guard.ts 在启动时断言。
set -eu

if [ -z "${NUXT_PUBLIC_MQTT_WEB_URL:-}" ] && [ -n "${MQTT_WEB_URL:-}" ]; then
  export NUXT_PUBLIC_MQTT_WEB_URL="$MQTT_WEB_URL"
fi

exec "$@"
