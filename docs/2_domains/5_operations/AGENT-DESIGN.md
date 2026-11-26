# AGENT-DESIGN：运行与维护设施的实现

- 本文档状态：PENDING（初稿，待人类审阅）
- 覆盖范围：变更通知的送达与资源清单、后台 runner 的扫描清单与状态、存储审计、健康检查、sitemap 与 robots、请求标识、对外错误输出、外部回调入口
- 上位依据：[SID#0.1.LAW](../../0_overall/1_architecture/LAW.md)、[SID#0.1.DESIGN](../../0_overall/1_architecture/DESIGN.md)
- 核对基线、偏差与待办：[SID#2.5.AGENT](AGENT.md)

本板块按人类 2026-11-15 的答复不设 LAW：它承诺的都是对其他板块和对运维的行为，用户看不到。本文约束具体实现，改动其中的规则和数值先经人类同意。

通知的发出路径、Query 何时失效、runner 的概念（扫描、待办、资源名额、租约、唤醒）和三种运行方式已在 `SID#0.1.DESIGN` 的『数据更新』『后台任务』写清，这里不重述。迁移执行、部署、备份、OSS 专项盘点、故障排查归 `SID#1`；后台状态和存储审计在控制台里怎么展示、谁能看归 [SID#2.3](../3_admin/AGENT-DESIGN.md)。设备身份 cookie 虽由全站中间件发放，按人类 2026-11-15 的答复归 [SID#2.1](../1_accounts/AGENT-DESIGN.md)。

## 入口

| 位置 | 内容 |
| --- | --- |
| [sync.ts](../../../server/lib/sync.ts) | `publish_refresh()`：一般业务的直接发布 |
| [sync-channel.ts](../../../server/lib/sync-channel.ts) | 敏感资源键换成 HMAC 频道名 |
| [mqtt.ts](../../../server/lib/mqtt.ts) | 服务端 MQTT 客户端、主题前缀、断线队列、带确认的发布 |
| [shared/types/sync.ts](../../../server/shared/types/sync.ts) | 资源类型清单、`sync_resource()`、通知载荷类型 |
| [background/runner.ts](../../../server/services/background/runner.ts) | runner 本体 |
| [background/wakeup.ts](../../../server/services/background/wakeup.ts) | 进程内唤醒 |
| [background/status.service.ts](../../../server/services/background/status.service.ts) | 后台状态的固定查询 |
| [content/background.service.ts](../../../server/services/content/background.service.ts) | 扫描清单、app 模式下的登记与关闭 |
| [server/plugins/](../../../server/plugins) | `content-*.ts`、`storage-audit.ts` 各登记一种扫描；`public-config-guard.ts`；`error-handler.ts` |
| [scripts/background/](../../../scripts/background) | 独立 worker、`background:status` 命令 |
| [storage-audit/](../../../server/services/storage-audit) | 存储审计扫描、结果读取、孤儿对象清理 |
| [hooks/healthz.get.ts](../../../server/api/hooks/healthz.get.ts) | 健康检查 |
| [hooks/sitemap/urls.get.ts](../../../server/api/hooks/sitemap/urls.get.ts) | sitemap 数据源 |
| [hooks/emqx/](../../../server/api/hooks/emqx)、[hooks/esa/](../../../server/api/hooks/esa) | 外部回调；只做传输，业务交给 `content/draft-sync.service`、`content/edge-read.service` |
| [request-id.ts](../../../server/middleware/request-id.ts) | 请求标识 |
| [error-handler.ts](../../../server/error-handler.ts)、[errors/](../../../server/errors) | 对外错误输出 |

## 数据库结构

### `content_sync_outbox`

归 `4_content`，见 [SID#2.AGENT-DESIGN](../AGENT-DESIGN.md#数据表归属)。投递规则写在下面『状态与规则』。

### `storage_audit_targets`

一行是一个存储目标（桶加 endpoint）的审计进度。来自 [存储审计迁移](../../../migrations/20261025160000_storage_audit.sql) 和 [清理迁移](../../../migrations/20261025170000_storage_audit_cleanup.sql)。

| 列 | 说明 |
| --- | --- |
| `destination_id` | 主键，由桶名和 endpoint 算出 |
| `storage_bucket`、`storage_endpoint` | 明文的目标 |
| `cycle_id`、`previous_cycle_id` | 本轮和上一轮的标识；孤儿清理要求连续两轮都看到 |
| `phase` | `attachments` → `avatars` → `static` → `objects` → `findings` → `completed` |
| `row_cursor`、`role_cursor`、`object_cursor` | 各阶段的续扫位置 |
| `references_checked`、`objects_checked` | 本轮已查的引用和对象数 |
| `cycle_started_at`、`last_completed_at`、`next_run_at` | 本轮开始、上轮完成、下轮开始的时间 |
| `lease_token`、`lease_until` | 租约 |
| `last_error_code` | 只取固定代码，见 `audit_error_code()` |

### `storage_audit_findings`

| 列 | 说明 |
| --- | --- |
| `id` | 自增主键 |
| `destination_id` | 所属目标 |
| `finding_hash` | 唯一键；同一对象同一类问题只有一行 |
| `object_key` | 对象键 |
| `kind` | 见下表 |
| `expected_size`、`observed_size` | 引用记录的大小和实际大小 |
| `observations`、`last_seen_cycle` | 被看到的次数和最近一轮 |
| `first_seen_at`、`last_seen_at`、`resolved_at` | `resolved_at` 非空表示问题已消失 |
| `object_modified_at` | 对象的修改时间，孤儿清理据此判断年龄 |

| `kind` | 含义 |
| --- | --- |
| `missing_object` | 有引用，对象不在 |
| `size_mismatch` | 大小与引用记录不符 |
| `public_object` | 对象 ACL 是公开读或公开读写 |
| `invalid_reference` | 引用的键不在允许的前缀下，或含非法字符、`.`/`..` 段、超过 1024 字节 |
| `orphan_candidate` | 对象没有任何引用，且超过宽限期 |
| `unregistered_static` | `imgs/` 下不在 `staticKeys` 清单里的对象 |
| `unmanaged_object` | 不在任何受管前缀下的对象 |
| `retired_object_present` | 已登记退役但仍在存储里的对象 |

### `migration_runs`

迁移执行器的账本，每个迁移文件一行（主键 `filename`），记录 `checksum`、`status`（`running`/`failed`/`completed`）、`phase`（`apply`/`verify`）、`checkpoint`、`attempts`、`last_error_code` 和时间。执行器怎么读写它见 [SID#1.4](../../1_workflows/4_maintain/AGENT-DESIGN.md#迁移查询与失败恢复)；本板块只有健康检查读它。

## 状态与规则

### 通知送达

| 路径 | 投递 | 丢失时 |
| --- | --- | --- |
| `publish_refresh()` | 已连上则立即以配置的 QoS 发出；断线时进内存队列，连上后一次发完 | 队列满了丢最早的一条并记 `mqtt-publish-dropped`；进程退出时队列丢失 |
| 档案 outbox | 每轮最多领 `scanLimit` 条，一次领一条、领到就发；收到 broker 的 QoS 1 确认后删行 | 未确认则释放租约，按 `retrySeconds × 2^attempts` 退避（上限 `maxRetrySeconds`），记 `delivery_unconfirmed`，并结束本轮，避免 broker 断线时一轮耗光重试 |

- 草稿类资源（`content_draft*`）走 `privateTopicPrefix`，其他走 `topicPrefix`。
- `otp_cooldown`、`otp_cooldown_by_identity`、`content_draft`、`content_drafts` 四类资源的 id 换成 `v1.<HMAC 前 22 字符>`（[sync-channel.ts](../../../server/lib/sync-channel.ts)）。主题名和载荷对只能订阅的 broker 连接可见，手机号空间很小，不带密钥的摘要可以离线穷举还原，所以必须带密钥。密钥由 JWT 密钥派生，轮换 JWT 密钥即轮换所有频道，没有新旧密钥并存的过渡期。浏览器只用接口返回的频道名，冷却查询每次都重新返回，下次查询就跟上新频道。
- 载荷只有事件 id、类型、资源键和时间戳。
- 草稿的私有连接凭据由 [draft_sync_credentials](../../../server/services/content/draft-sync.service.ts) 签发，有效期为 `app.content.draft.notificationCredentialSeconds`（现为 30 秒），broker 以此作为连接的到期时间。签发时和 broker 回调认证连接时都重查草稿身份，只放行订阅私有主题前缀。

前端在 [useDataSync.ts](../../../app/composables/useDataSync.ts)，公开和私有各一条连接：

- 页面隐藏时断开，恢复可见时先让所有订阅重新读取，再重连。
- 收到订阅确认（SUBACK）后再读一次数据，补上首次读取和订阅之间漏掉的通知。
- 连接断开、连接失败或订阅失败后，从 `reconnectDelayMs` 起逐次加倍，到 `reconnectMaxDelayMs` 封顶。每次实际等待为该档间隔的 80% 至 100%。订阅获确认后重置间隔，若没有订阅，连上即重置。
- 公开和私有连接的重连状态合并判断，持续中断达到 `reconnectNoticeDelayMs` 时显示一次『实时更新已中断，正在重连……』。恢复、后台主动断开或结束重连时取消待显示的提示。各 Query 正常按其取数和失败重试规则运行。
- 每次重连换一代连接，旧连接迟到的事件一律忽略。
- 私有连接只在本页或其他标签页有草稿订阅时才建立，没人需要时关闭。

### 资源清单

资源类型的唯一来源是 [SyncResourceType](../../../server/shared/types/sync.ts)。每类资源在哪发布、何时发布，写在所属业务目录；这里只列归属。

| 资源类型 | 发布方式 | 归属 |
| --- | --- | --- |
| `profile`、`profile_sessions`、`auth_user`、`user_login_sessions`、`otp_cooldown`、`otp_cooldown_by_identity` | `publish_refresh()` | `1_accounts`；控制台操作也发其中几类 |
| `content_stories`、`content_story`、`content_titles` | outbox | `4_content/0_stories`、`3_references` |
| `content_attachments`、`content_upload_session`、`content_uploads` | outbox | `4_content/4_attachments` |
| `content_draft`、`content_drafts` | outbox，私有主题 | `4_content/1_drafts` |

### 扫描清单

清单只在 [content_background_adapters()](../../../server/services/content/background.service.ts) 定义一次，app 模式的插件和独立 worker 共用。周期取自各自配置的 `sweepIntervalSeconds`。

| 扫描 | 资源名额 | 周期 | 处理什么 | 归属 |
| --- | --- | --- | --- | --- |
| `images` | `image` 1、`oss` 1 | 5 s | 图片处理任务 | `4_content/5_images` |
| `uploads` | `oss` 1 | 5 s | 过期上传会话的清理 | `4_content/4_attachments` |
| `retirement` | `oss` 1、`esa` 1 | 5 s | 对象删除与缓存清除 | `4_content/7_storage` |
| `preload` | `esa` 1 | 30 s | 缓存预热 | `4_content/7_storage` |
| `sync` | `notification` 1 | 1 s | 档案 outbox 投递 | 本板块（机制）、`4_content`（表） |
| `receipts` | 无 | 60 s | 过期命令回执的压缩 | `4_content/4_attachments` |
| `storage_audit` | `oss` 1 | 30 s | 存储审计 | 本板块（怎么查）、`4_content/7_storage`（对档案意味着什么） |

进程总名额为 `image` 1、`oss` 2、`esa` 1、`notification` 1。

- [runner](../../../server/services/background/runner.ts) 按先来后到排队。排在前面的扫描名额不够时，它要的几类资源对后面的扫描也暂时封住，免得后来者一直插队；不用这些资源的扫描照常开始，一类资源堵住不会拖住无关的扫描。
- `wake_background()` 只唤醒本进程的 runner，是提示不是保证，周期扫描仍兜底。唤醒会合并：扫描已在队列里时不再加；正在跑时记一笔，跑完后排到队尾再跑一次，因为正在跑的这一轮可能已经读完了候选。唤醒也要排队等名额，不会和自己重叠。
- 上传封口（`seal`）和重试（`resume`）提交后，读回的图片状态是 `queued` 或 `ready` 时才唤醒 `images`，失败的封口和重试不唤醒（[upload-api.service.ts](../../../server/services/content/upload-api.service.ts)）。`images` 扫描在图片采用成功后唤醒 `sync`，不等 outbox 的下一周期（[upload-image.service.ts](../../../server/services/content/upload-image.service.ts)）。
- 每个扫描都包在 `with_upload_context()` 里，以便上传观测能归到具体会话。
- 扫描抛错时 runner 记 `sweep_failed` 并写日志，下一周期照常再跑；关闭时没在 `shutdownTimeoutMs` 内结束的记 `shutdown_timeout`。独立 worker 遇到关闭超时以退出码 1 结束，且不断开数据库和 MQTT。
- app 模式下，每个 Nitro 应用只建一个 runner，由第一个登记的插件创建，`close` 钩子负责关闭。

### 存储审计

存储审计通过 `content_migration_pins`、`content_migration_objects` 和 `content_migration_scopes` 识别迁移仍在使用的对象。五张迁移明细表的用途和退出条件见[迁移明细归档与退役](../../1_workflows/4_maintain/AGENT-DESIGN.md#迁移明细归档与退役)。

只读、只报告：扫描不改动存储，发现只写进 `storage_audit_findings`。

1. 每个目标按 `phase` 顺序推进：先逐条核对附件、头像、静态资源三类引用（HEAD 看大小，再查 ACL），再分页列出存储里的全部对象找没有引用的，最后逐条复查未解决的旧发现，问题已不存在的才标为已解决。分页列举会漏看翻页期间的变化，所以不按“本轮没看到”批量解决。
2. 每批最多 `batchSize` 项、`batchBudgetMs` 毫秒，期间续租；到时存下游标，`sweepIntervalSeconds` 后接着做。
3. 一轮完成后 `next_run_at` 设为 `cycleIntervalSeconds` 之后；出错则 `retrySeconds` 之后重试。租约过期后迟到的 HEAD 结果被丢弃，游标不动。
4. 核对完一个引用后会再读一次引用；引用在核对期间被替换或删除时丢弃这次结果。
5. 修改时间在 `orphanGraceSeconds` 内的对象不报孤儿。

孤儿清理是唯一会导致删除的环节，默认关闭（`orphanCleanup.enabled: false`）。开启后，只有满足以下全部条件的 `orphan_candidate` 才会登记进对象退役队列，由 `retirement` 扫描真正删除：

- 目标的最近一轮已完成且没有错误；
- 本轮仍看到它，累计看到不少于 `minObservations` 次；
- 对象修改时间早于 `minAgeSeconds`；
- 键匹配 [cleanup_key_pattern](../../../server/services/storage-audit/cleanup.ts)，即当前档案写入方生成的不可变键；
- 尚未登记退役。

### 后台状态

`get_background_status()` 返回运行方式、本进程 runner 快照、各待办表的分组计数、存储审计进度与未解决发现的分类计数、上传观测。

- 只执行写死的 SQL，按 `phase` 和错误代码分组计数；不返回载荷、密钥、签名 URL 或云服务的错误原文。
- 错误代码只放行匹配 `^[\w-]{1,80}$` 的值，其余换成 `null`。
- 本进程快照只反映当前进程；worker 模式下应用进程的快照为 `null`，此时以数据库计数为准。
- 上传观测来自 [upload-observation.ts](../../../server/lib/upload-observation.ts)，按固定的阶段名分别累计次数、失败数、并发峰值、总耗时、最长耗时和最近 128 次的 p50、p95。阶段里有 `db_acquire`，即从连接池取连接的等待，由 [database-observation.ts](../../../server/lib/database-observation.ts) 挂在连接池上统计，也计入外层阶段的日志。会话 id、任务 id 只进日志，不进状态。
- `resources` 是当前进程的运行时长、内存（RSS、堆、external）和累计 CPU 时间，不是整台机器。

### 健康检查

`GET /api/hooks/healthz` 查询 `migration_runs` 中 `completed` 的行数。成功返回 200 和 `{ status: 'ok', migrations: <数> }`；数据库不可用或表不存在返回 503 和 `{ status: 'unavailable' }`，并写日志。容器健康检查和部署准入都用它。

### sitemap 与 robots

- sitemap 列出全部档案（`/content/<id>`，带 `lastmod`，优先级 0.8）和全部未封禁用户的主页（`/u/<id>`，优先级 0.3），频率都是 weekly。
- sitemap 排除、robots 禁止 `/admin`、`/content/new`、`/content/*/edit`，见 [nuxt.config.ts](../../../nuxt.config.ts)。

### 请求标识

每个请求带 `request_id`：请求头 `x-request-id` 不超过 64 字符且不含换行时沿用，否则生成 UUID；同时写回响应头。服务端错误日志和 SSR 错误日志都带上它。

### 对外错误输出

| 错误 | 状态码 | 对外消息 |
| --- | --- | --- |
| `ApiError` | 自带的状态码 | 自带的消息 |
| Zod 校验失败 | 400 | 第一条 `custom` 类问题的消息；否则一句通用的“参数不合法” |
| 其他 | 原状态码或 500 | 生产环境一律用 `INTERNAL_ERROR_MESSAGE`；开发环境给原消息 |

`/api` 下返回 JSON `{ message }`，其他路径返回纯文本。Nitro 的 `error` 钩子负责记录一次日志，响应处理器设置相同的状态码并等待正文写完。tRPC 错误的业务字段（`applicationError`）由 `server/shared/api-error.ts` 过滤后返回，只含公开的错误代码和详情。

### 公开配置

`public-config-guard` 插件在启动时按 schema 解析出公开配置，每个请求把它的深拷贝写进该请求的 `runtimeConfig.public`，防止某个请求改动的公开配置影响其他请求。

## 接口

| 入口 | 访问要求 | 说明 |
| --- | --- | --- |
| `GET /api/hooks/healthz` | 公开 | 健康检查 |
| sitemap 数据源 `/api/hooks/sitemap/urls` | 公开 | 由 `@nuxtjs/sitemap` 调用 |
| `POST /api/hooks/emqx/authenticate` | EMQX 调用；凭据在请求体里 | 草稿私有连接的认证，`no-store` |
| `POST /api/hooks/esa/authorize` | ESA 边缘函数调用；请求体限 8 KiB | 附件读取授权，成功 204 并带授权头，其余 403；内部错误 503 且不带细节 |
| `admin.getBackgroundStatus`、存储审计结果的读取 | 见 `SID#2.3` | 控制台的「运行状态」 |
| `pnpm background:status:*` | 部署机上的命令 | 打印后台状态；`--storage-findings` 另打印前 100 条发现 |

## 配置

| 配置项 | 当前值 | 作用 |
| --- | --- | --- |
| `app.backgroundRunner.mode` | `app` | `app` / `worker` / `disabled` |
| `app.backgroundRunner.shutdownTimeoutMs` | 30000 | 关闭时最长等待，上限 300000 |
| `app.backgroundRunner.resources` | 见上 | 每进程资源名额 |
| `app.contentSync` | 周期 1 s、每轮 50 条、租约 30 s、确认超时 10 s、退避 5 s 起至 300 s | outbox 投递 |
| `app.storageAudit` | 周期 30 s、一轮间隔 86400 s、出错重试 300 s、租约 300 s、每批 25 项 15 s、孤儿宽限 604800 s | 存储审计 |
| `app.storageAudit.orphanCleanup` | 关闭；最少 2 次、最短 604800 s | 孤儿清理 |
| `app.storageAudit.staticKeys` | 11 个 `imgs/` 下的文件 | 登记过的静态资源 |
| `integrations.mqtt` | QoS 1、`stupig/sync`、`stupig/draft-sync`、断线队列 100 条 | 通知 |

各扫描自己的周期和批量见所属业务目录。上述数值以 [shared.yaml](../../../config/shared.yaml) 为准。

## 向其他板块提供的能力

| 入口 | 用途 |
| --- | --- |
| `publish_refresh()`、`sync_resource()` | 一般业务发通知 |
| `enqueue_content_refresh()` | 档案业务在事务内写 outbox（实现在 `4_content`，投递在这里） |
| `wire_resource()`、`otp_cooldown_channels()` | 下发敏感资源的频道名 |
| `BackgroundAdapter`、扫描清单 | 新增一种扫描：实现 `sweep(signal)`，加进清单，再加一个 Nitro 插件登记 |
| `wake_background(id)` | 让本进程某类扫描提前跑 |
| `event.context.request_id` | 日志关联 |
| `ApiError` | 带状态码和公开消息的业务错误 |

## 验收标准

| 条目 | 测试 |
| --- | --- |
| runner 遵守资源名额，同类扫描不重叠，唤醒在扫描中到来时补跑一次，关闭时等待并报告超时 | [runner.test.ts](../../../server/services/background/runner.test.ts) |
| 独立 worker 只在 `worker` 模式启动，关闭超时以非零退出 | [worker.test.ts](../../../scripts/background/worker.test.ts) |
| 每个插件登记对应扫描 | `server/plugins/*.test.ts` |
| outbox 收到确认才删行，未确认时退避并结束本轮 | [sync-outbox.service.test.ts](../../../server/services/content/sync-outbox.service.test.ts) |
| 断线时进队列，满了丢最早的；带确认的发布在断线或拒绝时报错 | [mqtt.test.ts](../../../server/lib/mqtt.test.ts) |
| 敏感资源换成 HMAC 频道名，其他原样 | [sync-channel.test.ts](../../../server/lib/sync-channel.test.ts) |
| 后台状态只含固定字段，非法错误代码被过滤 | [status.service.test.ts](../../../server/services/background/status.service.test.ts) |
| 存储审计按阶段推进、可续扫、核对期间引用变化时丢弃结果、不改动存储 | [service.test.ts](../../../server/services/storage-audit/service.test.ts) |
| 孤儿清理只登记满足全部条件的对象 | [cleanup.test.ts](../../../server/services/storage-audit/cleanup.test.ts) |
| 健康检查成功 200，数据库失败 503 且不带细节 | [healthz.get.test.ts](../../../server/api/hooks/healthz.get.test.ts) |
| 请求标识沿用合法值，超长或含换行时重新生成 | [request-id.test.ts](../../../server/middleware/request-id.test.ts) |
| 生产环境对外不暴露内部错误消息 | [public-message.test.ts](../../../server/errors/public-message.test.ts) |
| 公开配置按请求隔离 | [public-config-guard.test.ts](../../../server/plugins/public-config-guard.test.ts) |
| sitemap 列出全部档案与未封禁用户的主页，包括没有填写资料的账号 | [数据源测试](../../../server/api/hooks/sitemap/urls.get.test.ts)、[账号筛选测试](../../../server/services/profile.service.test.ts) |
| Nuxt 注册 sitemap 数据源，sitemap 和 robots 都排除控制台、新建档案和编辑页 | [Nuxt 配置测试](../../../scripts/verify/nuxt-config.test.ts) |
| 全站请求首次取得设备身份 cookie，后续请求复用同一身份 | [identity.test.ts](../../../server/middleware/identity.test.ts)，规则见 [账号的身份数据](../1_accounts/AGENT-DESIGN.md#身份数据) |
| 请求错误只记一条日志，状态码与响应一致，API 返回 JSON、其余路径返回纯文本 | [error-handler.test.ts](../../../server/error-handler.test.ts) |
