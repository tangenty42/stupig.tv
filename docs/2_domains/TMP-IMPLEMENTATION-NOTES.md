# TMP：各领域实现调查材料

- 本文档状态：PENDING（供人类编写、核对领域 DESIGN）
- 覆盖范围：公共框架、账号与权限、蠢猪档案、运行与维护设施等领域的实现细节
- 原调查基线：2026-11-03；提交 `67f8dad0a15c76acdb079c1334b143fcc146b935` 加当时工作区
- 前端编辑入口增量核对：2026-11-05 14:06:11 +08:00；同一提交及当前工作区
- 权威依据：[SID#README](../README.md)、[SID#0.0.LAW](../0_overall/0_background/LAW.md)、[SID#0.1.LAW](../0_overall/1_architecture/LAW.md)、[SID#0.1.DESIGN](../0_overall/1_architecture/DESIGN.md)
- 配套材料：[领域业务调查](TMP-DOMAIN-NOTES.md)、[工程流程调查](../1_workflows/TMP-ENGINEERING-NOTES.md)

本文由原 [SID#0.1.TMP-DESIGN](../0_overall/1_architecture/TMP-DESIGN.md) 的详细调查整理而来，属于非权威材料，供后续各领域 DESIGN 选用。正文中的“当前”指原调查基线，不代表本轮重新验证了全部实现；原调查未访问生产数据库、云控制台或实际部署环境，也未运行业务验收。

源码位置与业务归属分别说明：例如登录／注册弹窗虽在应用公共入口中挂载，其界面、业务逻辑与状态管理仍按现行 `SID#0.1.LAW` 归账号与权限。下文的实现调查与候选建议均不替代权威规定。

## 源码定位参考

| 位置 | 当前主要职责 | 关键边界 |
| --- | --- | --- |
| `app/app.vue`、`app/pages/` | 公共外壳、登录／注册弹窗、路由页面 | 编排页面，不定义另一套服务端权限事实 |
| `app/components/` | 通用 `My` 组件和 Content 等业务组件 | UI 组件与文档业务模块不要求一一对应 |
| `app/composables/` | API 门面、身份状态、资源查询与同步等全站通用能力 | 页面通过 `useApi()` 使用业务能力；传输层有独立职责 |
| `app/features/` | 按业务组织客户端状态、操作与业务协作 | content 的草稿、附件、上传和编辑会话已迁入所属 feature；业务内部实现显式导入 |
| `app/stores/` | 草稿页面内存状态、上传协调状态 | 持久业务状态来自服务端；不把正文草稿保存到浏览器存储 |
| `app/utils/` | Markdown 渲染、引用、编辑器扩展、工作区与上传辅助等 | 通用逻辑接收必要参数，不隐式读取私有服务端配置 |
| `server/api/`、`server/routes/` | tRPC 适配、附件跳转、授权回调、通知凭证及健康探针 | HTTP 协议入口和业务服务分别承担职责 |
| `server/trpc/` | `auth`、`profile`、`admin`、`content`、`presence`、`system` 路由，输入校验及鉴权中间件 | 将业务交给 services；保留可识别的状态与中文错误消息 |
| `server/services/` | 账号、权限、事务、Content 状态变化、跨对象协调 | 业务数据库访问与发布条件由服务持有 |
| `server/lib/` | 数据库、存储、消息、云 SDK、签名、日志等底层接入 | 接入能力不承担页面编排 |
| `server/shared/` | 前后端共用类型、校验与规则、权限定义、业务参数 | 可用于浏览器；不能夹带服务端密钥或配置加载 |
| `server/plugins/` | 启动接线、公共配置注入、后台扫描注册 | 各插件注册到共用 runner，领域账本仍由各领域负责 |
| `config/` | 配置 schema、加载与生成、主题、浏览器目标、ESA 函数及 RAM 策略 | 配置来源与发布边界明确分开 |
| `migrations/`、`scripts/migration/` | 数据库版本链、冻结历史实现、迁移执行与维护打包 | 历史迁移闭包不能跟随运行时代码一起随意重构 |
| `scripts/`、`.github/workflows/`、`tests/` | 开发、部署、维护、验证及自动化入口 | 工具具备能力不等于对应线上操作已经完成 |

建议沿用的主要调用方向为：页面／组件 → composables／API 门面 → 传输与路由 → 业务服务 → 数据库及外部设施；`server/shared` 为两端提供公共契约。源码实际存在的个别兼容入口应单独注明，不能仅凭这张表假定每个文件均已完成分层核查。

## 数据与状态归属

| 状态 | 持久位置／拥有者 | 客户端或其他设施的角色 |
| --- | --- | --- |
| 用户、权限、登录会话和 token generation | MySQL；账号与会话服务 | Cookie 携带凭据或展示信息；服务端仍复核会话与账号状态 |
| 正式正文、摘要、共享草稿和编辑租约 | MySQL；Content 服务 | 编辑器保存内存输入，云端确认决定是否已保存 |
| 附件节点、目录、版本、上传会话及预约 | MySQL；工作区与上传服务 | Pinia 协调交互、进度和本地 `File`；不能凭任务卡片消失认定取消成功 |
| 文件字节、图片原图及派生版本 | OSS；数据库记录对象身份和当前采用关系 | 浏览器按临时授权上传，按允许的表示读取；文件路径不等于 OSS key |
| 引用历史、命令回执、outbox、图片和回收任务 | MySQL；各自领域账本 | runner 调度，MQTT 提醒重新取数，都不替代账本 |
| 编辑界面偏好与上传文件句柄 | 浏览器 localStorage／IndexedDB 中的各自记录 | 偏好不含正文和租约；上传句柄用于尝试恢复本地文件访问，不代表云端任务已完成 |

正文开头的元数据和 Markdown 是档案内容来源，列表使用从中提取的摘要列。正文版本、草稿版本、附件名称空间版本、全局标题版本和对象读取版本分别解决不同问题，不能直接合并为一个 `updated_at` 判断。

数据库版本链与冻结历史的调查材料见[工程流程调查](../1_workflows/TMP-ENGINEERING-NOTES.md#迁移与历史实现)。

## 公共框架与前端状态

### 前端状态与 SSR

- [useApi](../../app/composables/useApi.ts) 提供领域方法，[useTrpcClient](../../app/composables/useTrpcClient.ts) 负责传输与认证失败处理。
- [useSyncedData](../../app/composables/useSyncedData.ts) 与查询工具管理取数、请求共享、失效和可见页面轮询；SSR 查询状态按 Nuxt 应用实例隔离，不能把用户数据放进跨请求共享的可变缓存。
- [useSyncedState](../../app/composables/useSyncedState.ts) 和 [useDisplayTimeContext](../../app/composables/useDisplayTimeContext.ts) 处理首屏状态及时间显示一致性。服务端时间以 UTC 保存，界面按显示时区转换。
- [content 草稿 store](../../app/features/content/draft.store.ts) 保存页面内存文本、确认快照、租约和待核对命令；不持久化正文到 localStorage、sessionStorage 或 IndexedDB。[编辑界面偏好](../../app/components/MyContent/Markdown/internal/view-state.ts) 与 [上传句柄](../../app/features/content/uploads/upload-file-handle.ts) 另有各自的本地保存机制。
- 返回数据中的访问者标识和版本用于防止旧身份、旧页面或旧请求的结果覆盖当前状态；不能将客户端 Cookie 的展示信息当作权限事实。

## 账号与权限

浏览器提交登录／注册操作 → tRPC 校验输入 → 账号服务验证密码、验证码或 CAPTCHA → 建立数据库登录会话与 token generation → 返回 Cookie 和用户展示状态。

后续受保护请求校验凭据，并核对数据库中的封禁、退出、有效期和权限。管理代操作通过统一的目标解析与权限判断；账号变更通过现有通知机制影响相关页面。

当前 [has_permission](../../server/shared/permissions.ts) 对 `is_admin` 放行全部权限，[管理员授予入口](../../server/services/admin.service.ts) 没有现实成员身份校验。`SID#0.0.LAW` 的成员专属授权要求仍需由人类授权流程及后续账号设计落实；本次没有核对生产账号，不能据源码推断线上授权是否违规。

## 蠢猪档案

### 内部职责与源码入口

| 协作模块 | 主要源码入口 | 负责的事实 |
| --- | --- | --- |
| 正式正文 | [story.service.ts](../../server/services/content/story.service.ts) | 正文、摘要、正文版本及对当前访问者的投影 |
| 草稿与编辑权 | [draft.service.ts](../../server/services/content/draft.service.ts)、[draft-auth.service.ts](../../server/services/content/draft-auth.service.ts) | 草稿、编辑租约、命令顺序和结果回执 |
| 工作区与引用 | [workspace-command.service.ts](../../server/services/content/workspace-command.service.ts)、[reference-history.service.ts](../../server/services/content/reference-history.service.ts) | 节点、名称空间、引用变化、事务与冲突 |
| 上传与发布 | [upload-api.service.ts](../../server/services/content/upload-api.service.ts)、[upload-session.service.ts](../../server/services/content/upload-session.service.ts)、[upload-publication.service.ts](../../server/services/content/upload-publication.service.ts) | 受理、预约、分片、取消、对象就绪与业务发布 |
| 图片 | [image-job.service.ts](../../server/services/content/image-job.service.ts)、[oss-image-processing.ts](../../server/lib/oss-image-processing.ts) | 原图、展示与删减版本的处理和采用 |
| 读取授权 | [attachment-access.service.ts](../../server/services/content/attachment-access.service.ts)、[edge-read.service.ts](../../server/services/content/edge-read.service.ts) | 当前可读对象、读取版本及边缘请求授权 |
| 后续处理 | [background.service.ts](../../server/services/content/background.service.ts)、[storage-audit/service.ts](../../server/services/storage-audit/service.ts) | 通知、回收、预热、回执压缩、存储核对等 |

`server/services/content.service.ts` 当前主要提供重导出；不能仅根据这个旧入口判断 Content 的实际规模。

### 正文编辑与发布

编辑页 → `useStoryEditing` → `useStoryEditSession`／content draft store／附件入口 → 草稿与附件 API → MySQL 草稿、租约、命令回执及附件工作区。

当前实现使用服务端独占租约及有序命令。断线、租约失效或响应丢失时先转只读并核对原命令；自动同步更新草稿，发布命令调用正文服务更新 main。引用、相关草稿和 outbox 在对应业务事务中协调提交。

草稿持久记录在 `content_story_drafts`；新草稿初始不绑定 story，首次发布建立绑定。附件工作区依赖已发布 story，附件变化不等待正文发布。旧 `createStory/updateStory/deleteStory` tRPC 入口返回升级提示，不能把它们当作仍可绕开草稿协议的写入口。

### 附件上传与图片处理

批量预检及目标预约 → 持久化上传会话 → 浏览器获取分片签名并直传 OSS → 服务端核验对象，必要时处理图片 → 在事务中采用对象、更新附件与引用、记录回执和 outbox。

长时间传输及图片处理与短数据库事务分开。暂停是停止本地传输，取消还需要服务端处理会话和后续对象；结果未知时核对原会话／请求，不能盲目再创建一次操作。

当前图片主链路由 OSS 原生处理生成 WebP 展示版、JPEG 回退版和小尺寸预览，并独立保存原图；应用中的 Sharp 参与小图检查及保留的历史／迁移实现。实际角色格式见 [content-image-format.ts](../../server/shared/content-image-format.ts)。旧资料中的 AVIF 描述不应直接抄成当前主链路。

替换发布新对象并退役旧对象，逻辑附件身份可保留；另存为是新的独立附件。正常版本、原图和删减版分别授权，普通下载不会悄悄换成删减下载。

### 文件读取与在线授权

同源附件入口按附件身份、版本和访问者选择表示 → 返回签名读取地址 → ESA 函数验证签名并回调 `/api/content/authorize` → 应用按当前数据库事实判断 → ESA 原生缓存／OSS 交付。

[ESA 函数](../../config/esa/content-auth.mjs) 不代理文件字节，也不缓存成功授权结果；回调失败时拒绝放行。缓存命中不能绕过授权。已经下载的副本和已经开始的传输有各自边界，不能把撤权描述为远程抹除客户端文件。

`/api/content/private-attachments/:id` 是返回 410 的旧入口。头像和站点静态资源按公开交付规则处理，不复用 Content 的全部私密附件模型。

## 运行与维护设施

### 变化通知与后台工作

Content 在业务事务同连接写入 [outbox](../../server/services/content/sync-outbox.repository.ts)；[dispatcher](../../server/services/content/sync-outbox.service.ts) 获得 MQTT 投递确认后移除事件，失败则保留重试。账号等其他领域目前使用 `server/lib/sync.ts` 直接发布通知，不能描述为全站已经统一使用 outbox。

[useDataSync](../../app/composables/useDataSync.ts) 连接 EMQX，并用 BroadcastChannel 协调浏览器标签页。普通通知与草稿通知采用不同连接；草稿连接取得短期凭证，由应用认证。通知只携带重新读取所需的信息，不下发正文或租约秘密。在线状态等由时间推导的数据以及断线补偿仍需要相应轮询。

共用 runner 提供有界扫描、进程内资源槽和协作停止；各任务继续拥有自己的数据库租约、重试与回执。当前注册七类任务：图片、上传生命周期、对象退役、预热、Content 通知、命令回执压缩、存储核对。注册并不等于启用，是否执行还取决于相应配置。

### 配置来源

| 配置类别 | 来源与读取方式 |
| --- | --- |
| 可公开的稳定业务参数 | `config/app-settings.yaml` 经 schema 校验与生成器生成 `server/shared/settings.generated.ts`，消费者通过 `@shared/settings` 使用 |
| 部署差异 | `config/shared.yaml` → `dev.yaml` 或 `prod.yaml` → 可选、仅开发使用的 `local.yaml`；由 `@config/loader` 加载 |
| 秘密与环境变量 | 本地环境文件或部署环境注入；跟踪的 `.env.*.layer` 描述变量及安全默认值，具体秘密不写入文档 |
| 浏览器可见的部署参数 | 服务端以公共 schema 筛选后注入 `runtimeConfig.public`，不能直接暴露完整配置 |

[配置加载器](../../config/lib/loader.ts) 对映射递归合并、对数组整体替换；环境插值仅处理显式声明。数据库维护工具可只加载需要的配置子树。生成文件由 [generate.ts](../../config/lib/generate.ts) 管理。

## 依赖定位参考

这里记录职责和当前选择，不复刻完整依赖清单。准确解析版本以 [pnpm-lock.yaml](../../pnpm-lock.yaml) 为准，声明范围见 [package.json](../../package.json)。

| 依赖 | 当前用途／边界 |
| --- | --- |
| Node、pnpm、TypeScript | 应用及工具运行、依赖锁定、类型检查；Dockerfile／CI 当前使用 Node 24，pnpm 版本由 CI 明确指定 |
| Nuxt、Vue、Nitro | 页面路由、SSR、浏览器交互及同一应用内的服务端入口 |
| PrimeVue、Tailwind、Pinia | UI 组件、样式、客户端共享生命周期；公共主题与覆盖由现有配置和样式文件持有 |
| tRPC、Zod | 类型化业务 API、输入和配置校验；HTTP 文件与回调入口仍按协议需要独立存在 |
| CodeMirror、markdown-it 及扩展 | 正文编辑、诊断、业务 Markdown 语法与预览；共享解析规则避免两端各自解释 |
| CropperJS、ViewerJS、Sharp、OSS 图片处理 | 浏览器图片操作、展示，以及服务端原生处理接入和小图／历史处理 |
| MySQL、mysql2 | 事务、业务事实、后台账本与迁移回执 |
| EMQX、mqtt | 变化通知的传输；不是正文存储或通用业务任务队列 |
| 阿里云 OSS、ESA 及 SDK／CLI | 文件存储、授权交付、图片处理、刷新／预热和设施发布 |
| 短信与 CAPTCHA 服务 | 注册、认证及敏感操作需要的外部验证能力；开发调试模式与生产分开 |
| Redis、ioredis | 保留设施与客户端，目前未发现业务读写；是否继续保留待决定 |
| AWS S3 SDK、旧存储与加密工具 | 历史存储兼容、迁移及开发维护残留；不代表当前 Content 采用双存储发布 |
| Vitest、Playwright、ESLint、vue-tsc、esbuild | 单元／组件／浏览器验证、风格、类型检查和维护工具打包 |

生产浏览器目标由 package.json 的 Browserslist 及 `config/browser-targets.ts` 管理。声明能编译到某浏览器，不等于文件句柄等每项原生能力都可用；相应功能需要回退与实际浏览器验证。

## 待核对与可讨论事项

<!-- TODO: 人类在对应领域或流程文档中核对业务与设计选择；逐项处理下表，再编写所属 DESIGN。本表不授权移除设施或修改生产配置。 -->

| 事项 | 调查结论 | 后续需要决定或验证的内容 |
| --- | --- | --- |
| 架构与业务选择的对应 | 单写者草稿、引用重放、上传预约、对象回收等增加了实现复杂度 | 先在对应领域确认[业务调查材料中的待确认事项](TMP-DOMAIN-NOTES.md#待人类确认)；业务保留时，需要说明这些机制各自保护什么 |
| Redis | 有配置／开发容器／惰性客户端，未发现业务读写 | 是否退役；若退役，核对环境校验、工具退出接线和运维依赖 |
| 独立 worker | 有源码启动入口；当前生产镜像／Compose 未交付独立 worker 服务 | 保持应用内执行，还是另立明确的生产交付方案 |
| 预热与自动清理 | 跟踪配置中生产继承 shared 的预热关闭状态；dev 开启预热。存储核对启用，但孤立对象自动清理默认关闭 | 核对实际部署配置、费用与验收证据；不能把“有代码”写成“已在生产启用” |
| 历史兼容和重复名称 | 存在旧存储工具、冻结迁移实现、410 文件入口、409 旧正文写入口和草稿页面跳转 | 分别决定保留期限；历史重放材料与可退役运行时兼容入口分开处理 |
| 外部交付链路 | 源码定义了 ESA 在线授权、EMQX 草稿认证及对应部署配置 | 本轮未核对生产反代、云端规则、凭据与备份恢复；进入生产流程时另行验证 |
| 权限与测试边界 | 当前代码按角色／权限判断；现实成员认定不由代码自动完成 | 人类明确授权流程、管理员授予规则和开发测试夹具范围，落实 `SID#0.0.LAW` |

当前架构调查可以支持后续人类编写，但不能据此批准新增微服务、替换依赖或大规模重构。具体变更应先说明对应业务目标、迁移影响和验证方式。
