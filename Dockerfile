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

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3042
COPY --from=build /app/.output ./.output
# 运行时从 cwd 读取 config/*.yaml（server/shared/config.ts），.env 由 compose env_file 注入
COPY config ./config
EXPOSE 3042
CMD ["node", ".output/server/index.mjs"]
