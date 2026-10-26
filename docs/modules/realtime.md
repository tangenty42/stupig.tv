# 实时同步与页面状态

实时消息表示『某个资源需要重新读取』。客户端收到消息后通过正常 API 重新授权并获取当前数据，消息本身不承载机密正文、文件内容或凭据。

## 同步链路

```text
数据库变化 → 资源刷新事件 → MQTT → 可见页面 → useSyncedData → API
                                  └→ BroadcastChannel → 同浏览器其他页面
```

资源名与事件类型定义于 [`server/shared/types/sync.ts`](../../server/shared/types/sync.ts)。主题前缀来自共享 settings；服务端发布器和浏览器订阅器必须使用同一规则。EMQX 允许匿名连接订阅应用主题，因此手机号、设备身份这类个人标识不进入主题与事件明文：[`server/lib/sync-channel.ts`](../../server/lib/sync-channel.ts) 用密钥化 HMAC（密钥为 JWT 密钥的域分隔子密钥，`v1.` 前缀标识当前版本）把相应资源的 id 转为 channel，`publish_refresh()` 发布其 channel 形式，浏览器无法自行推导，只能通过查询接口拿到——OTP 冷却的 channel 随 `getOtpCooldown` 响应下发，`useDataSync` 原样订阅。密钥不出服务端，可避免通过原始标识直接订阅或离线字典反查；查询接口仍会向调用者返回 channel，不防主动查询/枚举，也不代替 broker 的订阅授权。发布与查询共用同一推导，保证订阅的主题与事件一致。更换 JWT 密钥会改变 channel，客户端需重新查询和订阅；当前不提供双密钥过渡。EMQX 的网络与权限配置见 [MQTT 部署](../deployment/mqtt.md)。

`useDataSync` 负责浏览器 MQTT 连接、资源订阅、跨标签消息与页面可见性变化。隐藏页面断开自己的 MQTT 连接，并通过 BroadcastChannel 与其他页面协调资源订阅；不要把它理解为数据库锁或可靠持久消息队列。连接恢复时也需要重新读取受影响的资源。

`useSyncedData` 按资源共享数据和 fetch 生命周期，页面一般使用默认的 universal 模式。调用者有不同 fetch 行为或额外副作用时，需显式选择独立实例；单纯希望手动触发刷新不能借用一个尚未获取数据的 trigger-only proxy 当作初始值。

## 两类发布方式

| 业务 | 提交与发布方式 | 保证与边界 |
| --- | --- | --- |
| 账号、资料、管理 | 变更后调用 `publish_refresh()` | 通知用于提示重读；不具备 Content outbox 的数据库事务保证 |
| Content | 业务事务内写 `content_sync_outbox` | 数据变化与通知意图一起提交，后台确认发送并重试 |

Content 通过 `enqueue_workspace_change()`／`enqueue_content_refresh()` 指定精确资源。dispatcher 认领带租约的 outbox 项，等待 MQTT 确认后再移除；失败保留记录并退避。崩溃可能带来重复事件，因此客户端必须接受重复刷新，不能把事件次数当作业务版本。

正文、附件工作区、上传会话分别订阅对应资源。上传会话数据按操作者过滤；跨用户的工作区预约只暴露占用信息，不携带上传凭据。前端以 `viewer_key` 和版本信息防止旧身份或旧快照覆盖当前状态。

## SSR 与多标签登录

- SSR 数据使用可序列化状态，经 Nuxt payload 进入客户端；服务端不能持有跨请求的共享资源 Map。
- `useSyncedState()` 标记 payload-backed 数据。hydration 期间可以开始请求，但数据、loading 和回调效果延后应用，保证首帧与服务端快照一致。
- fetcher 返回结果，不在后台请求中直接改写渲染状态。需要页面渲染的数据不能只放在 hydration 时会重置的普通 ref。
- 登录／退出通过 BroadcastChannel 通知同浏览器页面。API 身份来自 httpOnly cookie，不能用尚未同步的客户端 user ref 跳过请求。身份相关增量查询使用服务端返回的 `viewer_key`。
- 展示时区与时钟使用 `useDisplayTimeContext()`。SSR 使用 cookie 时区及同一时间快照，hydration 完成后才切换浏览器时区并启动共享时钟。

## 轮询的使用范围

用户在线状态等派生数据会随时间改变，即使没有写操作也会变化。因此用户资料、会话列表和管理员列表保留按 settings 配置的轮询补偿。它只在页面可见且一段时间没有新 fetch 后触发，不替代明确变更的 MQTT 通知。

上传客户端需要查询自己会话的完成／图片处理状态；后台 runner 需要有界扫描领域账本。这两类轮询有各自生命周期，不应混入全站页面刷新定时器。

## 源码与验证

- 客户端：[`useDataSync.ts`](../../app/composables/useDataSync.ts)、[`useSyncedData.ts`](../../app/composables/useSyncedData.ts)、[`useSyncedState.ts`](../../app/composables/useSyncedState.ts)。
- 服务端：[`sync.ts`](../../server/lib/sync.ts)、[`mqtt.ts`](../../server/lib/mqtt.ts)、[`sync-outbox.service.ts`](../../server/services/content/sync-outbox.service.ts)。
- 自动测试覆盖 hydration、身份变化、重复事件、过期快照、MQTT ACK 与 outbox 重试。浏览器验证还需覆盖两个标签、两个登录身份、离线后恢复和页面可见性切换，不能用单进程 mock 代替。
