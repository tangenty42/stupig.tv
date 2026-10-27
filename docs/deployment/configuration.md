# 填写开发与生产配置

日常只需 `.env.dev` / `.env.prod` 和 `config/dev.yaml` / `config/prod.yaml`。覆盖优先级、全部字段和默认值按需查[配置项参考](configuration-reference.md)，不用先通读。

## 1. 生成文件

```powershell
pnpm env:build:dev
pnpm env:build:prod
```

打开生成文件填值。现有值会保留，修改模板不会自动覆盖旧凭据；明文 env 不提交。

## 2. 按表填写

| 项目 | 填写位置 / 去哪里拿 |
| --- | --- |
| MySQL / Redis | env 中 `MYSQL_*` / `REDIS_*`；填应用容器可达的地址，见 [MySQL/Redis](mysql-redis.md) |
| MQTT | env 中 `MQTT_*`；生产浏览器用 WSS，账号/ACL 见 [EMQX](mqtt.md) |
| Content OSS、ESA、短信身份 | 按 [RAM 创建清单](ram.md)逐行绑定策略，再填写对应 AccessKey |
| ESA SiteId / 读取密钥 | `ALIYUN_ESA_SITE_ID=181553031729356`；`ALIYUN_ESA_AUTH_KEY` 自行生成，每环境不同，32–128 个无空格可打印 ASCII 字符 |
| 图形验证 | `ALIYUN_DYPNS_CAPTCHA_APP_KEY` 来自产品控制台，见 [短信/CAPTCHA](sms-captcha.md) |
| 静态资源与头像 | 与 Content 共用 `ALIYUN_OSS_*` 和新桶；静态 URL 来自 `oss.buckets.public.publicBaseUrl`，见 [OSS](oss.md) |
| 登录与 debug | `JWT_SECRET` 至少 32 字符；生产 OTP/CAPTCHA debug 都为 false |
| 部署 | `ACR_IMAGE` 不带 tag，`EXTERNAL_DOCKER_NETWORK` 必须已存在，见 [服务器](server.md) |
| 开发隧道 | `.env.dev` 的 `DEV_FRP_TOKEN`，见[隧道](../development/auth-tunnel.md) |

域名、桶、函数名、回调 URL 改环境 YAML；共同默认值在 shared。开发可用未入库的 local.yaml 覆盖，生产不读取它。浏览器共享的业务限额另改 app-settings.yaml，并运行 `pnpm settings:generate`。

## 3. 核对并交付

```powershell
pnpm esa:deploy:dev --plan
pnpm esa:deploy:prod --plan
pnpm esa:deploy:prod --check
pnpm env:encrypt
pnpm env:check
```

plan 只显示脱敏目标；check 使用生产发布身份做云端只读检查，不发布。提交 YAML、必要模板和 `.env.prod.gpg`；GitHub `ENV_PASSPHRASE` 与本机加密口令一致。本机口令优先从进程环境读取，其次取 `.env.dev`，不放进生产应用配置。

## 运行时选哪个文件

`pnpm dev` 使用 `.env.dev`；build/preview 与生产容器使用 `.env.prod`。工具可以传 `--env=dev|prod`；已有进程变量优先。Compose 手动操作要显式指定 `--env-file .env.prod`。`pnpm dev` 和 env:build 不会发布函数，正式发布按 [ESA](esa-functions.md)及[部署顺序](README.md)执行。
