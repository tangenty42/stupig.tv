# AGENT-DESIGN：共用模块实现补充

- 本文档状态：DONE
- 覆盖范围：共用模块、前后端实现约定、领域交界处的接线与数据约束
- 上位依据：[SID#0.1.DESIGN](DESIGN.md)
- 静态核对：2026-11-11 11:53:57 +08:00（Asia/Shanghai），提交 `722c1cd3392cb4cdb5c8b051f3354c8e3905e355` 及未提交工作区；未重新执行业务或云端验收
- 工程规则迁移：2026-11-11 20:55:43 +08:00（Asia/Shanghai），同一提交及本轮工作区
- 整理与实施记录：[SID#0.1.AGENT](AGENT.md)

目录职责、依赖方向、状态归属、查询更新、SSR 与后台调度见 [DESIGN](DESIGN.md)。本文承接原前后端工程指令中未被 DESIGN 覆盖的实现约定。全项目格式与协作规则见 [SID#0.AGENT-DESIGN](../AGENT-DESIGN.md)。

## 前端组件与样式

- Vue SFC 使用 `<script setup lang="ts">`，props 和 emits 使用类型声明，有运行时默认值时用 `withDefaults`。使用 Nuxt 自动导入，无需显式引入 `#imports`。自定义组件用 `My` 前缀，图标用 `<MyIcon name="lucide:..." />`。
- 增加输入、弹窗、确认、附件行或 Markdown 正文组件前，先看现有组件及其调用方式。表单使用 `@primevue/forms` 和 Zod resolver，复用共享 schema 与默认值，完整接口输入仍在服务端组装。
- 互斥切换且需要保留状态的模式，将带 key 的组件根节点直接放在 `<KeepAlive>` 内。中间的普通 DOM 包装会挡住缓存。
- 同页内切换视图且在顶层等待首次取数时，用 `<Suspense suspensible>` 直接包住切换的组件。切换时保留旧视图，待新视图就绪再显示。首次进入页面仍由页面级边界等待。水合时，有服务端结果的视图沿用首屏快照；只在浏览器取数的视图跳过等待，先按服务端骨架完成水合。周边的标题、计数跟随 `@resolve` 时实际显示的视图，切换控件立即反映选择。例子见 [admin/index.vue](../../../app/pages/admin/index.vue)、[content/index.vue](../../../app/pages/content/index.vue)。
- 使用 Tailwind 3 和 PrimeVue。全局样式分别由 [global.css](../../../app/assets/css/global.css) 与 [primevue-overrides.css](../../../app/assets/css/primevue-overrides.css) 维护，局部样式按需用 scoped `@apply`。语义色沿用现有色板及 `theme('colors.primary')`。
- PrimeVue 全局组件按页面需要加载。Nuxt 生成客户端清单时，对入口直接动态导入、且能对应到已注册 PrimeVue 组件的脚本关闭 `prefetch`，让首屏带宽优先用于当前页面。[预取规则](../../../config/primevue-prefetch.ts)
- 保持 Tailwind 的全局 `important` 关闭。祖先选择器策略会把复杂 variant 包进 `:is()`，影响 Chromium 80。`important: true` 会覆盖内联几何样式。优先用设计 token、`dt` 和 `pt`，只在有意覆盖冲突时使用局部 `!` utility。[ui-style.ts](../../../config/ui-style.ts) 维护稳定的 body ID。
- 共用 PrimeVue token 改在 [primevue-preset.ts](../../../config/primevue-preset.ts)。实例局部值和内部节点用 `dt`／`pt`。迁入 token 后检查明暗两套主题，再移除对应 CSS 变量覆盖。组件生命周期或动画相关补丁留在所属 CSS。
- 生产浏览器目标看 [package.json](../../../package.json) 的 production Browserslist，[browser-targets.ts](../../../config/browser-targets.ts) 将其用于旧浏览器 JS 与 Vite CSS 目标。涉及 CSS 兼容的变更使用 [生产样式验证](../../1_workflows/2_test/AGENT-DESIGN.md#css-与历史浏览器)，默认 E2E 不包含旧浏览器配置。

### 界面惯例

不针对某个组件的界面写法。某个公共组件的用法写在 [SID#2.0.AGENT-DESIGN](../../2_domains/0_framework/AGENT-DESIGN.md#公共组件)，只在某个页面成立的写在该领域的 AGENT-DESIGN。

- 按钮、标题、标签和意思完整的短句可以直接收尾。按语气选 `？`、`！`、`？！` 或 `~`，表示停顿或等待时用 `……`。长说明确实需要断开多句话时再用 `。`
- 中文叙述用全角标点，引号用『』。语气符号 `~` 按项目写法保留半角。需要照抄或有固定语法的内容保留原样，例如 URL、文件名和路径、版本号 `v1.2.0`、数值 `3.5 GB`、快捷键 `Ctrl+S`、Markdown、SQL 和代码。用户输入、外文原文、浏览器及第三方控件的原文也按原样引用
- 并列信息优先换行、用逗号或括号。界面里的 `·` 按用途列给人类审核。引用 LAW 写明的正式权限名称时沿用原名，更名由人类裁定
- 尽量用短句和常用词。提示先说哪个操作发生了什么，再给用户确实能做的下一步。按钮、确认和结果提示使用同一个动作名。业务术语第一次出现时，必要的话用白话解释含义
- 删除、公开或改变权限等操作，写清会影响谁或什么，以及是否能撤回。轻松语气可以保留，先让用户看懂后果和操作方式
- 弹窗的主要操作按钮同时显示动作名称和对应图标。用 PrimeVue `Button` 的 `label` 写动作，在 `#icon` 插槽放 `MyIcon`；例如附件弹窗的『重新选择』配打开文件夹图标。『取消』沿用次要文字按钮
- 链接不使用浏览器原生的文字下划线，也不加 `underline`／`hover:underline`，可通过颜色或箭头动画提供交互反馈。“控制台”“我的主页”等使用的项目自定义 `.link` 效果除外：保留 [global.css](../../../app/assets/css/global.css) 中由底部边框与阴影实现的下划线及动画
- 可滚动的输入框或区域带圆角或边框时，用外层 wrapper 承担边框、圆角和 `overflow-hidden`，内层去掉自己的边框、圆角和阴影。否则滚动条会画在圆角外面。
- 文字旁的图标与文字放在同一个行内框中，图标默认继承周围文字的字号，沿用 [global.css](../../../app/assets/css/global.css) 中 `.iconify` 的 `vertical-align: -0.125em`。图标直接作为 flex／grid item 时，这条基线规则会失效；`items-center` 只居中元素盒子，图标相对中文字形仍可能偏上。外层需要 flex／grid 布局时，用普通 `span`、`p` 或标题元素包住整组图标和文字，不将这组内容再设为 `inline-flex`，也不靠 `translate-y`、`top` 或固定像素偏移补偿。
- 独立图标按钮、带底框的装饰图标等没有相邻文字需要对齐，可以继续用 flex／grid 按几何中心居中。检查图文对齐时看图形与中文字形的位置，并核对换行后的表现。

图文组合示例：外层排列标题和数量，标题内部保留行内排版。

```vue
<div class="flex items-baseline justify-between gap-3">
  <span class="text-sm">
    <MyIcon name="lucide:book-open" class="mr-1.5" />
    已发布正文
  </span>
  <span class="text-xs text-slate-500">2 篇</span>
</div>
```

## 前端状态与接线

- 业务入口的初始化、Vue/Nuxt 上下文和 `ready` 用法见 [前端状态](DESIGN.md#前端状态)。业务组件的渲染、视口、焦点、滚动等配套逻辑归所属 feature，以显式导入接入。全站通用能力按 [前端分区职责](DESIGN.md#分区职责)放置。
- `useApi()` 在 setup 中同步取得。新增业务操作时同步扩充其命名方法及服务端路由，复用 `@shared/types/*` 的契约。[前后端协作](DESIGN.md#前后端协作)规定浏览器原生链接、传输层和底层退出请求的例外。
- [data-sync.client.ts](../../../app/plugins/data-sync.client.ts) 通过 `transport.start()` 给同步层传入私有 MQTT 凭据取得函数。`useDataSync()` 不依赖 `useApi()` 或 `useTrpcClient()`，以免与依赖同步层的 `useAuth()` 形成循环。
- `useMyToast()` 和 `useAuth()` 需要 Vue 注入上下文。在 setup 中取得后续要用的操作，异步取数、MQTT 或 BroadcastChannel 回调可复用这些操作，或使用适合该回调的底层 Nuxt API。传输层按应用实例合并并发 401，`useSyncedData()` 不重复弹出此类错误，调用方也沿用统一处理。
- Pinia store 负责所属 feature 的共享业务状态。查询生命周期、订阅以及 SSR cookie 身份沿用现有的同步与身份入口。`app/utils/` 的配置与环境依赖由调用方显式传入，不调用 composable 或隐式读取配置。稳定业务参数用 `@shared/settings`，部署信息只使用经过校验的 `runtimeConfig.public`。

## 查询与水合细节

- 使用 [DESIGN 的查询选项](DESIGN.md#usesynceddata)。即时订阅遇到正在读取的共享 Query 时，等待已有请求。`immediate: false` 适用于只在后续触发时读取的调用，首屏数据使用其他明确的来源。
- [useSyncedData.ts](../../../app/composables/useSyncedData.ts) 按 Nuxt 应用实例持有 QueryClient。传入 `useSyncedState()` 标记的 data，或省略 data 时，浏览器在水合期间暂存结果、loading、错误和 `on_data`。显式传入普通 ref 时不走这条暂存路径。首屏数据须由 payload 承载，或确保两端首轮结果一致。取数函数的状态写入边界见 DESIGN。
- `useSyncedData()` 的 `retry_on_error` 缺省为 `true`。同一个 Query 只用一份调度。活跃订阅中指定了 `polling_interval` 或显式关闭失败重试时，停用失败退避。普通轮询继续取活跃订阅里最短的正间隔。
- 失败退避覆盖网络传输错误、超时、HTTP 408 和 5xx。连续失败后分别等待 5、10、20 秒，每档加减 20% 的随机偏移，最多重试三次。浏览器标签页可见且没有在途请求时才发出重试。成功或遇到不可恢复错误即结束本轮重试。
- 退避等待和后台重试期间保留当前界面状态。同一轮的可恢复错误只报告首次失败，随后遇到不可恢复错误时仍按原规则处理。手动刷新和同步通知继续使用原触发规则。控制台异常明细显式设置 `retry_on_error: false`。
- [时区插件](../../../app/plugins/timezone.ts) 在 `app:suspense:resolve` 后启用浏览器时区和共享时钟。渲染时复用 DESIGN 中的时间上下文。payload 保存 UTC 字符串等可序列化值，避免存 Dayjs 实例。展示时向 [time.ts](../../../app/utils/time.ts) 传入明确时区，计算日历单位差值前以同一时区转换两个时间值。

## 后端入口与类型

- 业务操作加到 [领域 tRPC 路由](../../../server/trpc/routers/)，由 [router.ts](../../../server/trpc/router.ts) 汇总。Nitro tRPC 路由负责传输适配。需要特定 HTTP 形态的入口按 [后端分区职责](DESIGN.md#后端)进入 `server/api/hooks/` 或 `server/api/links/`，不另设 `server/routes/`。
- 按访问条件选用 [公开、登录或权限 procedure](DESIGN.md#前后端协作)，使用 Zod 校验，交给 service 处理。预期业务错误使用 `ApiError`，保留中文提示与传输状态。业务查询、事务放在 services，底层 lib 按 DESIGN 的方向提供设施能力。
- 服务端导入使用 `@server/`。公开 API 数据及同步标识放 `@shared/types/*`，服务端认证／JWT 类型放 `server/types/`，service 私有类型就近维护。共享运行时代码遵守 DESIGN 的浏览器边界，`@config/loader` 留在服务端，专项工具只校验所需配置子树。

## 账号与档案接线

这里只留跨模块接线的概要。细节已由各领域接收：前两条见 [SID#2.1.AGENT-DESIGN](../../2_domains/1_accounts/AGENT-DESIGN.md)，第三条见 `SID#2.4`，通知与后台任务见 [SID#2.5.AGENT-DESIGN](../../2_domains/5_operations/AGENT-DESIGN.md)。

- 前端身份由 `useAuth()` 读取展示 cookie。账号 feature 在此基础上编排刷新和操作，不另建身份 store。401 和跨标签页退出沿用底层 auth 通道。身份敏感的 HTTP 读取由服务端根据当前令牌 cookie 鉴权，浏览器展示用的 user ref 不决定是否发起这些请求。
- 支持管理员代操作的接口接收 `operate_for`，统一用 [resolve_operate_target](../../../server/services/auth-guards.service.ts) 解析目标。仅当契约不同才需要另一套资料 API。用户查询复用 [资料查询与格式化](../../../server/services/profile.service.ts) 的 `select_profile_row_sql` 和 `format_profile_row()`，沿用手机号可见性。登录、最近活动与在线状态来自 `user_login_sessions`，已移除的用户活动与会话版本字段不恢复到 `users`。
- 档案草稿的可序列化文字／状态与上传 `File` 分开管理。[档案增量数据](../../../server/shared/types/content.ts) 用服务端 `viewer_key`／`base_viewer_key` 校验读取视角。业务操作及发布阶段均在服务端核对权限，路径预约、节点版本与事务约束见 [SID#2.4.4.AGENT-DESIGN](../../2_domains/4_content/4_attachments/AGENT-DESIGN.md#提交与回执)。
- 档案写入在业务事务的同一连接内通过 `enqueue_workspace_change`／`enqueue_content_refresh` 记录精确通知，其他领域使用 [publish_refresh](../../../server/lib/sync.ts)。页面复用通知与失效机制。资料、会话及管理列表仍需安静期轮询来读取随时间变化、没有对应写事件的状态。
- [后台任务](DESIGN.md#后台任务)的租约、检查点与外部操作回执由所属领域保存，runner 负责有界调度，进程资源名额不承担集群互斥。关闭时遵循协作取消并保留在途外部操作的核对依据。

## 共用确认与提示

| 入口 | 用法 |
| --- | --- |
| [useMyConfirm()](../../../app/composables/useMyConfirm.ts) | 取得 `confirm_require(event, message, accept, options?)`；使用触发事件的 `currentTarget` 定位浮层，用户确认后调用 `accept` |
| [useMyToast()](../../../app/composables/useMyToast.ts) | 用 `ok()`、`info()`、`error()` 展示消息，`clear()` 清除当前提示；错误入口通过项目的错误消息工具提取文本 |

这两个入口依赖 PrimeVue 注入；在 setup 的同步阶段取得函数，供后续点击或异步回调使用。展示组件统一挂在 [app.vue](../../../app/app.vue)；具体提示内容、确认后的业务动作及失败处理由调用方负责。一次操作由谁提示、确认或跳转，沿用 DESIGN 的前后端协作约定。

## 直接监听通知

可重新读取的共享资源按 DESIGN 使用 `useSyncedData()`。不表示共享查询结果的原始事件可直接调用 [useDataSync().subscribe(resource, listener)](../../../app/composables/useDataSync.ts)；它返回取消订阅函数，调用方在所属组件或业务作用范围结束时调用。共享 transport 按 Nuxt 应用实例存活，不会随单个订阅组件退出而自动移除该监听。

## 数据库与外部设施

[db](../../../server/lib/db.ts) 提供共用 MySQL 连接池，驱动使用 `timezone: 'Z'`，每条新建物理连接再执行 `SET time_zone = "+00:00"`。时间戳按 UTC 保存和读写，界面显示使用 DESIGN 中的时间上下文。

业务事务从连接池取得连接后，在同一连接上开始、执行、提交或回滚，最后释放连接。事务内的仓储和通知写入接收该连接，不能回到池上另发查询；可参考 [draft.service.ts](../../../server/services/content/draft.service.ts) 的事务包装及传给 outbox 的连接。

MySQL 的 `tinyint(1)` 布尔字段在组织 API 返回值时显式转换为布尔值，例如 [format_profile_row()](../../../server/services/profile.service.ts)；连接池未配置统一布尔转换，TypeScript 类型声明不会转换数据库结果。

OSS、ESA 等设施客户端返回本次设施调用的结果。业务授权、数据库状态与外部操作的衔接由所属 service 组织；数据库事务回滚不会撤销已经完成的外部操作。各领域继续维护自己的重试、对象身份和操作回执。

## 共享契约与别名

[server/shared/schemas.ts](../../../server/shared/schemas.ts) 提供可复用的字段及表单校验；[server/trpc/schemas.ts](../../../server/trpc/schemas.ts) 组合完整接口输入。API 门面和表单沿用这些契约，不各自维护同义规则。共享目录中的领域类型和规则仍归相应业务所有。

项目的 `@shared/` 指向 `server/shared/`，由 [nuxt.config.ts](../../../nuxt.config.ts) 配置；Nuxt 的 `#shared/` 指向根目录 `shared/`，两者不是同一个目录。独立脚本有自己的[路径配置](../../../scripts/tsconfig.json)，不依赖 Nuxt 生成配置来解释这些别名。

## 结构化错误与日志

除 DESIGN 规定的业务错误消息外，[ApiError](../../../server/errors/ApiError.ts) 可携带 `public_data`。构造时由[公共错误 schema](../../../server/shared/api-error.ts)筛选，[tRPC 格式化器](../../../server/trpc/init.ts)再按[跨端错误契约](../../../server/shared/content-reference-error.ts)输出 `applicationError`；未通过校验的数据不传给前端。需要机器可读的错误细节时扩展对应共享契约，避免把完整异常或 SDK 响应作为错误数据。

[log](../../../server/lib/log.ts) 的 `log_info`、`log_warn`、`log_error` 输出单行 JSON；`error_fields()` 提取原始错误名称、消息与堆栈。它们不会自动脱敏，调用方须选择可记录字段，去掉凭据、完整签名 URL 和不必要的业务内容。

[请求 ID 中间件](../../../server/middleware/request-id.ts)将 ID 放入 `event.context.request_id` 并通过 `x-request-id` 返回；需要关联请求的日志显式传入该字段，参考[全局错误处理](../../../server/plugins/error-handler.ts)。日志用于诊断，业务完成与恢复仍依据领域保存的状态和回执。

## 操作入口

配置生成、环境选择和密文处理见 [SID#1.1](../../1_workflows/1_develop/AGENT-DESIGN.md)，测试见 [SID#1.2](../../1_workflows/2_test/AGENT-DESIGN.md)，发布及回执见 [SID#1.3](../../1_workflows/3_deliver/AGENT-DESIGN.md)，生产工具、任务检查和恢复见 [SID#1.4](../../1_workflows/4_maintain/AGENT-DESIGN.md)。这些流程不在架构文档中另存一套命令。
