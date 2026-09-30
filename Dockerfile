# syntax=docker/dockerfile:1

FROM node:24-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: postinstall 的 nuxt prepare / git hooks 需要完整源码与 .git，构建阶段跳过
RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts
COPY . .
# 构建期的 public 配置由 load_public_config 读取，不校验密钥，所以无需 .env。
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
# 先迁移再起服务：迁移失败就让容器起不来（restart 策略下会重试），
# 带上病结构继续跑只会更糟。exec 让 node 接管 PID 1，信号能正常送达。
CMD ["sh", "-c", "node .output/server/maintenance/migrate.mjs && exec node .output/server/index.mjs"]
