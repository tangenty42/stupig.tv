# syntax=docker/dockerfile:1

FROM node:24-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: postinstall 的 nuxt prepare / git hooks 需要完整源码与 .git，构建阶段跳过
RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts
COPY . .
# 构建期的 public 配置由 load_public_config 读取：不校验密钥与连接信息（插值字段
# 允许为空），所以无需 .env。客户端唯一需要的插值字段在容器启动时注入（compose）。
# 固定 production 覆盖层，免得构建机的 NODE_ENV 影响 config/*.yaml 合并结果。
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
# 运行时从 cwd 读取 config/*.yaml（server/shared/config.ts），.env 由 compose env_file 注入
COPY config ./config
# 迁移以挂载/复制的文件为准（不进 .output），启动时自动应用
COPY migrations ./migrations
EXPOSE 3042
# 浏览器侧的 MQTT 地址只能运行期注入，派生逻辑必须随镜像发布（见 docker-entrypoint.sh：
# compose 文件是服务器上单独维护的，CI 只推镜像，放在那里会走岔）。
# sed 是必需的：Windows 工作区里这个脚本可能是 CRLF，而 #!/bin/sh\r 会让 exec 直接
# 报 "no such file or directory" —— 容器起不来，且只有真跑起来才看得见。chmod 同理，
# Windows 检出没有可执行位。
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh
# 先迁移再起服务：迁移失败就让容器起不来（restart 策略下会重试），
# 带上病结构继续跑只会更糟。exec 让 node 接管 PID 1，信号能正常送达。
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["sh", "-c", "node .output/server/maintenance/migrate.mjs && exec node .output/server/index.mjs"]
