# 配置项与覆盖规则参考

> 初配字段已迁入 [SID#1.0](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#初配字段与反代示例)，配置操作见 [SID#1.1.AGENT-DESIGN](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#配置实际从哪里来)。本文保留领域容量、时序及底层加载参考，字段与默认值以 schema、YAML 和模板核对。

首次配置先按[填写清单](configuration.md)操作；本页按字段查阅。事实源：[loader](../../config/lib/loader.ts)、[schema](../../config/lib/schema.ts)、[环境选择器](../../config/lib/environment.mjs)、[shared](../../config/shared.yaml)、[dev](../../config/dev.yaml)、[prod](../../config/prod.yaml)。

## 配置来源与覆盖

文件分层、合并、插值与配置缓存统一见 [SID#1.1 的配置来源](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#配置实际从哪里来)。浏览器共享业务参数由 app-settings.yaml + schema 生成 settings.generated.ts；生成与一致性检查分别使用 `pnpm settings:generate`、`pnpm settings:check`。

共享草稿的稳定时序位于 `app.content.draft`：`saveThrottleMs=1000`、`keepaliveIntervalMs=10000`、`requestTimeoutMs=5000`、`leaseMarginMs=3000`，服务端租约按 M+2T+S 推导为 23 秒；`notificationCredentialSeconds=30` 控制 MQTT 票期。schema 要求 N<M 并限制正整数上界，私有通知前缀不能被公开前缀覆盖。旧 localStorage schema／prefix／autosave 配置已退出，正文不再本地持久化。

## 环境文件选择

日常命令的环境后缀、env 文件和进程变量优先级见 [SID#1.1 的配置来源](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#配置实际从哪里来)。以下保留底层接线，供修改启动工具时核对。

底层环境选择器按 `--env=dev|prod` → NODE_ENV → development 选择；消费后移除 --env，保留其他参数如 --environment。CLI 预载器在业务模块导入前注入所选文件；配置加载器自身不写回进程变量。Docker/CI 可只注入进程变量，不带 env 文件。

Nuxt dev/build/preview 在 [package.json](../../package.json) 显式指定 --dotenv：dev 读取 `.env.dev`，build/preview 读取 `.env.prod`。

## 连接与凭据

连接字段与凭据用途见 [SID#1.0 的连接与凭据](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#连接与凭据)。

## 环境 YAML

环境资源、域名、函数和回调字段见 [SID#1.0 的环境 YAML](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#环境-yaml)。

## 超时、后台与容量

| 分组 | shared 默认值与含义 |
| --- | --- |
| oss.buckets.* | 连接 30000 ms，请求 120000 ms，复制分片 64 MiB，forcePathStyle false |
| aliyun.oss | 请求 120000 ms，复制分片 64 MiB |
| aliyun.esa | URL TTL 300 s，与函数 TTL_SECONDS 相同，不是缓存 TTL |
| aliyun.esaPurge | 管理请求 15000 ms |
| app.backgroundRunner | app 模式，退出 30000 ms；image/oss/esa/notification 每进程槽为 1/2/1/1 |
| app.contentSync | 扫描 1 s，每批 50，租约 30 s，发布 10000 ms，重试 5–300 s |
| app.contentReceipts | 启用，扫描 60 s，每批最多 100；仅压缩过期结果，保留去重墓碑 |
| app.contentUploads | 扫描 5 s，每批 20 |
| app.contentRetirement | 扫描 5 s，每批 20，租约 300 s，重试 30–3600 s，查询 5 s，任务 600 s |
| app.contentImages | 扫描 5 s，并发 1，每批 20，租约 120 s，心跳 20 s；运行时仅支持 OSS |
| app.contentImages.cloud | 新任务受理开关；profileVersion 3，WebP Q100、JPEG Q85 白底、24px JPEG LQIP Q40；关闭后拒绝新图片，不启用本地回退，已受理任务保留原合同 |
| app.contentImages.cloud.profile | 输入 20 MiB / 9,437,184 像素，超时 60 s；webpEffort 4 仅供冻结 WebP 维护编码读取，OSS 不使用该参数 |
| app.contentImages.profile / profileVersion | 冻结 AVIF 迁移专用，版本 1；50 MiB / 2400 万像素、AVIF Q65/effort 4，运行时图片任务不消费 |
| app.contentPreload | shared/prod 关闭且未验收，dev 开启；每日 500、保留云额度 1000、单对象 20 MiB |
| app.contentPreload 调度 | 扫描 30 s，每批 5，租约 300 s，重试 300–3600 s，查询 30 s，任务 3600 s，时钟容差 60 s，最多提交 3 次含首次 |
| app.contentMigration.partSizeMb | 维护迁移分片 8 MiB |
| app.storageAudit | 默认开启；扫描 30 s，每批 25，单批预算 15000 ms；完整周期 86400 s，租约 300 s，失败重试 300 s；孤立候选宽限 604800 s |
| app.storageAudit.orphanCleanup | 默认关闭；至少 604800 s 未修改、连续至少 2 个完整周期确认的已知 Content 孤立 key，复查后交给原退役通道；头像/静态/未知路径不自动清理 |

schema 校验心跳/租约、发布时限、重试上下限等约束。调大资源槽不等于提高集群或云端配额。后台工作及预热对账详见[后台任务](../modules/background-jobs.md)、[对象生命周期](../modules/content/object-lifecycle.md)。

## 浏览器公开边界

public_config_schema 仅公开站点、旧公开静态资源基地址、浏览器 MQTT URL、CAPTCHA appId/debug。OSS/RAM/JWT、数据库、ESA 管理及隧道凭据留在服务端；发布身份和 ENV_PASSPHRASE 属工具配置。稳定业务参数导入生成模块，不复制进 runtimeConfig.public，也不手改生成文件。
