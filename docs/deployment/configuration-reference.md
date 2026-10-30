# 配置项与覆盖规则参考

首次配置先按[填写清单](configuration.md)操作；本页按字段查阅。事实源：[loader](../../config/lib/loader.ts)、[schema](../../config/lib/schema.ts)、[环境选择器](../../config/lib/environment.mjs)、[shared](../../config/shared.yaml)、[dev](../../config/dev.yaml)、[prod](../../config/prod.yaml)。

## 配置来源与覆盖

| 类型 | 来源 | 去向 |
| --- | --- | --- |
| 浏览器共享业务参数 | app-settings.yaml + schema | 生成 settings.generated.ts；运行 `pnpm settings:generate` / `pnpm settings:check` |
| 部署参数 | shared.yaml → dev.yaml 或 prod.yaml | 服务端验证，只公开白名单子集 |
| 密钥与部署变量 | shared/dev/prod env layer → .env.dev 或 .env.prod | YAML 只插值显式 `${VAR}` |

开发可追加未入库的 local.yaml，生产不加载它。映射递归合并；数组、标量、null 整体覆盖。用 null 禁用可空子树会移除其凭据要求，但相关功能可能不可用。

`${VAR}` 缺失会报错；`${VAR:-fallback}` 在缺失或空值时用默认值。不存在任意 env 自动覆盖任意 YAML 字段的规则。`runtime_config()` 缓存进程快照，修改后重启应用/worker。迁移只验证其需要的 DB/OSS/图片子树，不要求无关 JWT/短信参数。

共享草稿的稳定时序位于 `app.content.draft`：`saveThrottleMs=1000`、`keepaliveIntervalMs=10000`、`requestTimeoutMs=5000`、`leaseMarginMs=3000`，服务端租约按 M+2T+S 推导为 23 秒；`notificationCredentialSeconds=30` 控制 MQTT 票期。schema 要求 N<M 并限制正整数上界，私有通知前缀不能被公开前缀覆盖。旧 localStorage schema／prefix／autosave 配置已退出，正文不再本地持久化。

## 环境文件选择

运行时 NODE_ENV 必须为 development 或 production，对应 .env.dev / .env.prod，不读取旧 .env，也不跨环境兜底。本地工具按 `--env=dev|prod` → NODE_ENV → development 选择；消费后移除 --env，保留其他参数如 --environment。

进程已注入的同名变量优先于文件，Docker/CI 可不带文件。文件内 NODE_ENV 若存在，必须与选择一致。CLI 预载器在业务模块导入前注入所选文件；配置加载器自身不写回进程变量。

Nuxt dev/build/preview 显式指定 --dotenv。Compose 插值单独通过 `--env-file .env.prod` 选择；服务中的 env_file 不会替 Compose 选择插值文件。两条 ESA 发布命令已固定环境，不再另传 --env。

## 连接与凭据

| 配置 / 消费方 | 变量 | 含义 |
| --- | --- | --- |
| Node / Compose | NODE_ENV、APP_PORT | Compose 将 APP_PORT 映射为 Node PORT |
| db | MYSQL_HOST/PORT/USER/PASSWORD/DATABASE | 应用可达的数据库 |
| redis | REDIS_HOST/PORT/PASSWORD | 密码允许空，开发为空 |
| mqtt | MQTT_HOST/TCP_PORT/USERNAME/PASSWORD | 服务端可信内网 TCP 与发布身份 |
| mqtt.web.wsUrl | MQTT_WEB_URL；开发 MQTT_WS_PORT | 浏览器 WS/WSS 完整 URL，含 /mqtt |
| mqtt.web.draftWsUrl | MQTT_DRAFT_WEB_URL；开发 MQTT_DRAFT_WS_PORT | 草稿授权 WS URL；省略时由公开 URL 推导同源 /mqtt-drafts，生产反代须接到专用 8086 listener |
| oss.buckets.public/private | ALIYUN_OSS_* | public 与 aliyun.oss 指向同一新桶，提供静态 URL；private 默认 null，仅历史恢复时显式配置 |
| aliyun.oss | ALIYUN_OSS_ACCESS_KEY_ID/SECRET | 新 Content OSS 应用身份 |
| aliyun.esa.authKey | ALIYUN_ESA_AUTH_KEY | URL 签名/回调证明，32–128 个无空格可打印 ASCII 字符 |
| aliyun.esaPurge | ALIYUN_ESA_ACCESS_KEY_ID/SECRET、ALIYUN_ESA_SITE_ID | 维护凭据成对，启用时须提供 SiteId |
| esaFunction | ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID/SECRET、ALIYUN_ESA_SITE_ID | 仅发布工具，不进入应用运行配置 |
| aliyun.dypns | ALIYUN_DYPNS_ACCESS_KEY_ID/SECRET | PNVS 短信身份 |
| aliyun.captcha.appKey | ALIYUN_DYPNS_CAPTCHA_APP_KEY | 图形验证产品密钥，非 RAM key |
| app.auth.jwt.secret | JWT_SECRET | 至少 32 字符，轮换影响既有令牌 |
| app.otp / captcha | NUXT_OTP_DEBUG、NUXT_CAPTCHA_DEBUG | 开发默认 true；生产必须 false，loader 会拒绝生产 debug |
| Compose | ACR_IMAGE、EXTERNAL_DOCKER_NETWORK | 镜像地址不带 tag；外部网络须存在 |
| Compose / 发布回执 | APP_IMAGE、MQTT_IMAGE、CONTENT_DRAFT_PROTOCOL | Deploy 推送提交 SHA tag 并固定到实际 RepoDigest；cloud-v1 阻止跨回旧正文协议的自动恢复 |
| 开发依赖 | MYSQL_DEV_ROOT_PASSWORD、PHPMYADMIN_DEV_PORT、EMQX_DEV_DASHBOARD_PORT | 本地容器和诊断 |
| devAuthTunnel | DEV_FRP_TOKEN | 仅开发 launcher，不下发浏览器 |
| 本地 / CI 工具 | ENV_PASSPHRASE | env 密文口令，不是生产应用参数 |

变量后缀 `ID/SECRET` 表示分开的 `ACCESS_KEY_ID` 和 `ACCESS_KEY_SECRET`。具体身份与 JSON 对照只在 [RAM 清单](ram.md)维护。环境文件选择正确不证明云端授权成功。

## 环境 YAML

- site.url / indexable：主站地址与收录，开发关闭收录。
- oss.buckets.public：endpoint、region、bucket、publicBaseUrl，均指向本环境阿里云桶。历史 private 源默认 null；显式启用时不能与 public 指向同一桶。
- aliyun.oss：官方 OSS HTTPS endpoint、地域、桶及 Content 域名；SDK endpoint 不能填 ESA host。
- aliyun.esa.baseUrl：仅 HTTPS origin，无路径/query/用户信息，与 Content 交付域名一致。
- esaFunction.name / callbackUrl：两个不同函数、不同环境回调。开发隧道也共用此回调；只有发布命令才同步到云端。
- aliyun.oss.uploadRoleArn：保留字段，dev/prod 均为 null；当前上传不调用 STS，不需要配置上传角色策略。
- aliyun.dypns / sms / captcha：endpoint/region、签名/模板/方案、appId；迁账号时整体核对。
- aliyun.esaPurge：region 与 endpoint 成对，使用目标 ESA 接入地域。

## 超时、后台与容量

| 分组 | shared 默认值与含义 |
| --- | --- |
| oss.buckets.* | 连接 30000 ms，请求 120000 ms，复制分片 64 MiB，forcePathStyle false |
| aliyun.oss | 请求 120000 ms，复制分片 64 MiB |
| aliyun.esa | URL TTL 300 s，与函数 TTL_SECONDS 相同，不是缓存 TTL |
| aliyun.esaPurge | 管理请求 15000 ms |
| app.backgroundRunner | app 模式，退出 30000 ms；image/oss/esa/notification 每进程槽为 1/2/1/1 |
| app.contentSync | 扫描 1 s，每批 50，租约 30 s，发布 10000 ms，重试 5–300 s |
| app.contentUploads | 扫描 5 s，每批 20 |
| app.contentRetirement | 扫描 5 s，每批 20，租约 300 s，重试 30–3600 s，查询 5 s，任务 600 s |
| app.contentImages | 扫描 5 s，并发 1，每批 20，租约 120 s，心跳 20 s，profileVersion 1 |
| app.contentImages.profile | 输入 50 MiB / 2400 万像素；AVIF 65/effort 4；JPEG 85 白底；LQIP 最长边 24/质量 40；超时 60 s |
| app.contentPreload | shared/prod 关闭且未验收，dev 开启；每日 500、保留云额度 1000、单对象 20 MiB |
| app.contentPreload 调度 | 扫描 30 s，每批 5，租约 300 s，重试 300–3600 s，查询 30 s，任务 3600 s，时钟容差 60 s，最多提交 3 次含首次 |
| app.contentMigration.partSizeMb | 维护迁移分片 8 MiB |
| app.storageAudit | 默认开启；扫描 30 s，每批 25，单批预算 15000 ms；完整周期 86400 s，租约 300 s，失败重试 300 s；孤立候选宽限 604800 s |
| app.storageAudit.orphanCleanup | 默认关闭；至少 604800 s 未修改、连续至少 2 个完整周期确认的已知 Content 孤立 key，复查后交给原退役通道；头像/静态/未知路径不自动清理 |

schema 校验心跳/租约、发布时限、重试上下限等约束。调大资源槽不等于提高集群或云端配额。后台工作及预热对账详见[后台任务](../modules/background-jobs.md)、[对象生命周期](../modules/content/object-lifecycle.md)。

## 浏览器公开边界

public_config_schema 仅公开站点、旧公开静态资源基地址、浏览器 MQTT URL、CAPTCHA appId/debug。OSS/RAM/JWT、数据库、ESA 管理及隧道凭据留在服务端；发布身份和 ENV_PASSPHRASE 属工具配置。稳定业务参数导入生成模块，不复制进 runtimeConfig.public，也不手改生成文件。
