# syntax=docker/dockerfile:1

FROM node:24-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: postinstall 的 nuxt prepare / git hooks 需要完整源码与 .git，构建阶段跳过
RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts
COPY . .
# nuxt.config.ts 会 import config 生成 public 配置白名单，schema 要求密钥齐备，而
# 构建上下文里没有 .env（已 .dockerignore）。用占位值喂饱校验即可：产物只内联白名单
# 里的 public 字段（不含任何密钥），服务端 bundle 在启动时才读 process.env。
RUN printf '%s\n' \
    'DB_PASSWORD=build-time-placeholder' \
    'JWT_SECRET=build-time-placeholder-build-time-placeholder' \
    'ALIYUN_ACCESS_KEY_ID=build-time-placeholder' \
    'ALIYUN_ACCESS_KEY_SECRET=build-time-placeholder' \
    'OSS_ACCESS_KEY_ID=build-time-placeholder' \
    'OSS_ACCESS_KEY_SECRET=build-time-placeholder' \
    > .env
# 固定 production 覆盖层，免得构建机的 NODE_ENV 影响 config/*.yaml 合并结果
ENV NODE_ENV=production
RUN pnpm build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3042
COPY --from=build /app/.output ./.output
# 运行时从 cwd 读取 config/*.yaml（server/shared/config.ts），.env 由 compose env_file 注入
COPY config ./config
EXPOSE 3042
CMD ["node", ".output/server/index.mjs"]
