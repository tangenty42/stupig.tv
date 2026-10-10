# syntax=docker/dockerfile:1

FROM node:24-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: postinstall 的 nuxt prepare / git hooks 需要完整源码与 .git，构建阶段跳过
RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts
COPY . .
# 构建只声明 runtimeConfig 结构；YAML 配置与环境变量在容器启动时读取。
ENV NODE_ENV=production
RUN pnpm build
# 运维脚本（迁移、OSS 对账清理）打成自包含单文件塞进 .output：运行时镜像里没有
# 源码、没有 tsx、也不装 node_modules，靠 node 直接跑
RUN pnpm maintenance:build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3042
COPY --from=build /app/.output ./.output
# 服务端配置在运行时读取；密钥仍通过环境变量注入，不烘焙进镜像
COPY config ./config
# 迁移以挂载/复制的文件为准（不进 .output），启动时自动应用
COPY migrations ./migrations
EXPOSE 3042
# 容器级健康检查：探针跟着镜像走，所以不经 compose 的 `docker run` 也有（compose 里
# 那份同名检查会覆盖它，两边都指向 /healthz，不会走岔）。必须用 shell 形式以便运行时
# 读 PORT —— compose 会用 .env 的 APP_PORT 覆盖它，在这里写死 3042 意味着换端口部署
# 就永远 unhealthy。node 自带 fetch，基础镜像里没有 curl/wget 也不需要。
# start-period 要涵盖启动前的迁移（ENTRYPOINT 先跑 migrate 再起服务）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3042)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# sed 是必需的：Windows 工作区里这个脚本可能是 CRLF，而 #!/bin/sh\r 会让 exec 直接
# 报 "no such file or directory" —— 容器起不来，且只有真跑起来才看得见。chmod 同理，
# Windows 检出没有可执行位。
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh
# 先迁移再起服务：迁移失败就让容器起不来（restart 策略下会重试），
# 带上病结构继续跑只会更糟。exec 让 node 接管 PID 1，信号能正常送达。
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["sh", "-c", "node .output/server/maintenance/migrate.mjs && exec node .output/server/index.mjs"]
