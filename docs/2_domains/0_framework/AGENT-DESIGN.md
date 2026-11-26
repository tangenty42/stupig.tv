# AGENT-DESIGN：公共框架的实现

- 本文档状态：PENDING（初稿，待人类审阅）
- 覆盖范围：导航栏、首屏遮罩与切页转圈、明暗模式、提示与确认、时间显示、自动更新的接线、前端错误处理、公共组件
- 上位依据：[SID#2.0.LAW](LAW.md)、[SID#0.1.LAW](../../0_overall/1_architecture/LAW.md)、[SID#0.1.DESIGN](../../0_overall/1_architecture/DESIGN.md)
- 核对基线、裁定与偏差：[SID#2.0.AGENT](AGENT.md)

本文约束具体实现：LAW 没写的数值、文案和边界都以这里为准，改动先经人类同意。Query、变更通知、水合与 `useSyncedState()` 的机制见 `SID#0.1.DESIGN` 的『数据更新』『SSR 与水合』，这里只写用户看得到的效果和公共设施的用法。

## 入口

| 位置 | 内容 |
| --- | --- |
| [app.vue](../../../app/app.vue) | 导航栏、面包屑与标签页标题、全站 `Toast` 和 `ConfirmPopup`、Esc 清提示、隐藏首屏遮罩、挂载登录注册弹窗 |
| [nuxt.config.ts](../../../nuxt.config.ts) | 首屏遮罩的内联样式和脚本；`@nuxtjs/color-mode` 配置 |
| [useMyToast()](../../../app/composables/useMyToast.ts) | 提示的唯一入口 |
| [useMyConfirm()](../../../app/composables/useMyConfirm.ts)、[confirm-popup.ts](../../../app/utils/confirm-popup.ts) | 按钮旁的确认气泡及其定位 |
| [MyDialog.vue](../../../app/components/MyDialog.vue) | 对话框，含确认用的对话框 |
| [useMyColorMode()](../../../app/composables/useMyColorMode.ts) | SSR 安全的明暗模式 |
| [timezone.ts](../../../app/plugins/timezone.ts)、[useDisplayTimeContext()](../../../app/composables/useDisplayTimeContext.ts)、[useReactiveDateNow()](../../../app/composables/useReactiveDateNow.ts)、[time.ts](../../../app/utils/time.ts)、[size.ts](../../../app/utils/size.ts) | 时区、每秒走的当前时间、日期与时长格式化、文件大小格式化 |
| [data-sync.client.ts](../../../app/plugins/data-sync.client.ts) | 把通知通道、身份和 API 接起来 |
| [useDataSync()](../../../app/composables/useDataSync.ts)、[useSyncedData()](../../../app/composables/useSyncedData.ts)、[query.ts](../../../app/utils/sync/query.ts) | 自动更新，机制见 `SID#0.1.DESIGN` |
| [useTrpcClient()](../../../app/composables/useTrpcClient.ts)、[useApi()](../../../app/composables/useApi.ts) | 请求、401 处理、在线心跳 |
| [error.ts](../../../app/utils/error.ts) | 把错误换成给人看的一句话 |
| [ssr-error.server.ts](../../../app/plugins/ssr-error.server.ts) | SSR 出错时写服务端日志 |

## 导航栏

| 部分 | 实现 |
| --- | --- |
| Logo | 链到 `/`；明暗模式各一张 SVG；切页时变淡 |
| 面包屑 | `app.vue` 按路径写死，见下表；首页图标始终在最前 |
| 右侧 | 明暗切换按钮用 `aspect-square` 保持宽高一致；已登录显示 `MyProfileHoverCard`，否则显示“登录 / 注册”，打开 `MyAccountAuthDialog` |
| 收起 | 滚动 0 到 80 px 之间按比例收起 Logo、加高面包屑行。离开顶部后导航栏加毛玻璃底和下边框；达到 80 px 时隐藏 Logo 链接并移出键盘导航 |

| 路径 | 面包屑 |
| --- | --- |
| `/` | 无 |
| `/contact` | 联系我们 |
| `/admin` | 控制台 |
| `/content` | 蠢猪档案 |
| `/content/<id>`、`/content/<id>/edit` | 蠢猪档案（可点） / 详情 #id 或 编辑 #id；`new` 不带编号 |
| `/content/draft-<id>/edit` | 蠢猪档案（可点） / 编辑 |
| `/u/<id>` | 用户主页 #id |
| 其他 | 按路径段逐段显示 |

- 标签页标题默认用 ` - ` 连接面包屑各段。首页用站点默认标题。有档案或用户资料时，由对应页面给出更具体的标题。
- 旧地址 `/content/drafts` 由页面中间件重定向到 `/content?view=drafts`。
- 导航栏实际高度经 `ResizeObserver` 写进 CSS 变量 `--app-header-height`，供吸顶内容使用；测量前按公式估算。
- 面包屑行超宽时横向滚动、隐藏滚动条，右端渐隐，避免压在右侧按钮下面。

## 页面加载

- **首屏遮罩**。`nuxt.config.ts` 把样式和脚本内联进 SSR 文档，首帧就盖住整页，带呼吸动画和转圈。`app.vue` 等 Nuxt 水合完成，再让遮罩用 500 毫秒缓入缓出淡出，揭开已就绪的页面。脚本另设 15 秒兜底。系统开启减少动态效果时立即移除。
- **切页转圈**：用 Nuxt 的 `useLoadingIndicator()`，它自带节流，切得快时不出现。转圈图标占 Logo 的位置；导航栏收起后占面包屑行左侧，面包屑让出位置。
- **页面切换**。`app.vue` 的 `NuxtPage` 等下一页的异步内容就绪，旧页用 180 毫秒淡出，新页用 300 毫秒淡入。渐变作用于页面根元素。页面标识沿用 Nuxt 的规则，查询参数或锚点变化可复用原页面。系统开启减少动态效果时直接切换。

## 明暗模式

- 存在 cookie `stupig_color_mode`，回落值 `dark`。
- 服务端按 cookie 渲染；cookie 为 `system` 或没有时按回落值，避免水合闪烁。
- 切换按钮只在 `light` 和 `dark` 之间来回，不提供“跟随系统”。

## 提示和确认

### 提示

只经 `useMyToast()` 弹出，不直接调用 PrimeVue 的 `useToast()`。

| 方法 | 标题 | 样式 |
| --- | --- | --- |
| `ok(text)` | 搞定 | success |
| `info(text)` | 提示 | info |
| `error(error)` | 出错了 | warn；内容经 `error_message()` 转换 |
| `grouped_error(details)` | 出错了 | warn；每组一行，复用带描边 `MyBadge` 的结构化提示 |

- 位置在屏幕中间，3 秒后消失；`onNuxtReady` 之后才弹，水合期间产生的提示会顺延。
- Esc 键调 `clear()` 清掉全部提示。
- `dead()` 在当前 Nuxt 应用实例暂停发起 Toast，供退出登录到整页刷新之间使用。
- 页面需要提示读取或刷新失败时，用 Toast 说明失败。界面用现有数据、占位和重试入口表达状态。自动轮询连续失败时，每次中断只提示一次。

### 确认

| 方式 | 用于 | 入口 |
| --- | --- | --- |
| 按钮旁的气泡 | 一步即可确认的操作，如退出登录、下线会话 | `useMyConfirm().confirm_require(event, message, accept)` |
| 对话框 | 需要先展示检查结果的操作，如删除档案或附件 | 业务组件自己用 `MyDialog`，如 [DeleteImpact.vue](../../../app/components/MyContent/DeleteImpact.vue) |

- 气泡的确认按钮用对勾图标，消息前加警示图标；取消按钮为次要文字按钮。
- `confirm_require` 把 `require` 推迟到当前点击事件之后，否则 PrimeVue 4.5 会被同一次点击立刻关掉。
- 气泡位置由 `confirm_popup_position()` 在进入动画时自行计算，优先在按钮下方，放不下就翻到上方并夹在视口内。

## 时间

- 服务端按 cookie `stupig_timezone` 渲染，没有时按 UTC。
- 浏览器在水合结束（`app:suspense:resolve`）后取本地时区、写回 cookie，并每秒更新 `now_ms`。
- 渲染里需要“现在”时用 `useReactiveDateNow()` 或 `useDisplayTimeContext()`，不直接读 `Date.now()` 或浏览器时区。
- 格式化用 `time.ts`：`date_format` 为 `YYYY/M/D`，`time_format` 为 `HH:mm:ss`，`datetime_format` 两者相连；时长用 `duration_format`，简写只取最大的一个单位，展开最多两个；技术耗时统一按毫秒读数，用 `milliseconds_format`。
- 文件大小用 [size.ts](../../../app/utils/size.ts) 的 `format_bytes`，速率用 `format_speed`。
- 时间、时长与文件大小的显示文案一律由 `time.ts` 和 `size.ts` 构建，页面或领域代码里不再新写本地格式化函数；缺写法时在所属模块里扩展。

## 自动更新

LAW 要求页面上的数据随变更自动刷新，做不到时至少轮询；快照式数据可以例外，但必须标明是某一时刻的结果。

- 读服务端数据一律经 `useSyncedData()`，给出资源键；没有资源键的必须设 `polling_interval`。
- 一次性读取只用于标明检查时点的快照式数据。删除确认框和附件状态变更确认显示『以上为打开此框时的检查结果』。
- 退出登录时用 `$fetch` 直接请求，是唯一绕开 tRPC 客户端的请求。

当前带轮询的查询：

| 查询 | 周期 | 配置项 |
| --- | --- | --- |
| 登录身份 | 30 s | `app.auth.syncPollIntervalSeconds` |
| 个人主页、登录记录的在线状态 | 4 s | `app.online.pollIntervalSeconds` |
| 控制台用户列表 | 2 s | `app.admin.pollIntervalSeconds` |
| 控制台后台状态 | 5 s | `app.admin.statusPollIntervalSeconds` |
| 草稿列表、编辑页保活 | `app.content.draft.keepaliveIntervalMs` | 同左 |

另外，已登录且标签页可见时，若 4 秒（`app.online.pingIdleIntervalSeconds`）内没有任何请求，`useTrpcClient` 会发一次 `presence.ping`，用来维持在线状态。

## 错误处理

| 情况 | 用户看到 |
| --- | --- |
| 查询失败，调用方没传 `on_error` | 默认弹一次“出错了”；同一 Query 一次错误只弹一次 |
| 操作失败 | 由调用方决定：弹提示，或在相应位置显示并给出重试 |
| 401 | 不弹提示；自动退出登录，同一应用内并发的 401 只触发一次 |
| 别的标签页退出登录 | 清本地身份、整页刷新，不弹提示 |

`error_message()` 的转换：

- 字符串直接作为消息。H3 的 `error: true` 响应取顶层 `message`，其他错误优先取 `data.message`，其次取 `message`。取到的文字按下面两条统一处理。
- 以 `Invalid input`、`Expected`、`Received` 开头的校验原文换成“输入格式不正确”；
- “用户打断了施法”返回空串。tRPC 将明确取消的请求标成 `AbortError` 并使用这条静默文案，同步查询也跳过这类取消的失败回调。
- 取不到消息时用“不知何错误……”。tRPC 传输失败且未取得服务端业务错误时统一用“《我们仍未知道那天所发生の网络错误の名字》”，服务端返回的业务文案、HTTP 状态和结构化信息照常传给调用方。草稿请求仍有独立的断线与超时提示。

服务端对外只给公开消息，见 [SID#2.5.AGENT-DESIGN](../5_operations/AGENT-DESIGN.md#对外错误输出)。SSR 渲染出错时，`ssr-error.server.ts` 带请求标识写日志。

## 公共组件

`app/components/` 顶层的 `My*.vue` 全站通用，业务组件放各自子目录。

| 组件 | 用途 |
| --- | --- |
| `MyDialog` | 对话框；`pending` 或 `closable=false` 时禁用 X、遮罩和 Esc 关闭。父组件仍可主动更新 `visible`，例如提交成功后关窗 |
| `MyIcon` | 图标，统一用 Iconify 名称 |
| `MyFormField`、`MyFilteredInput`、`MyFileNameInput`、`MyInputOtp`、`MyOtpButton` | 表单字段和输入 |
| `MyHeightSection`、`MyHeightTransition` | 高度变化的过渡 |
| `MyImagePreview` | 图片查看器 |
| `MyAvatar`、`MyAvatarCropUpload`、`MyProfileHoverCard`、`MyBadge`、`MyPermissionBadge` | 用户相关的展示，业务规则见 `SID#2.1` |
| `MyDivider`、`MySpacedText` | 排版 |

## 配置

| 配置项 | 当前值 | 作用 |
| --- | --- | --- |
| `app.client.colorMode` | 回落 `dark`，cookie `stupig_color_mode` | 明暗模式 |
| `app.client.timezone.cookieName` | `stupig_timezone` | 时区 |
| `app.client.sync` | 合并订阅 200 ms、重连按 1 s 起步至 30 s 封顶做抖动退避、中断 5 s 提示、连接超时 30 s、事件去重 256 条 | 通知通道，见 [通知送达](../5_operations/AGENT-DESIGN.md#通知送达) |
| `app.online.pingIdleIntervalSeconds` | 4 | 在线心跳 |

轮询周期见上文。数值以 [app-settings.yaml](../../../config/app-settings.yaml) 为准。

## 向其他板块提供的能力

| 入口 | 用途 |
| --- | --- |
| `useMyToast()` | 弹提示 |
| `useMyConfirm()`、`MyDialog` | 确认 |
| `useSyncedData()`、`useSyncedState()` | 读服务端数据并自动更新 |
| `useApi()`、`is_client_error()` | 调接口；判断是否为调用方输入导致的 4xx |
| `useReactiveDateNow()`、`useDisplayTimeContext()`、`time.ts` | 时间显示 |
| `useMyColorMode()` | 读当前明暗模式 |
| `--app-header-height` | 吸顶内容的偏移 |

## LAW 没写的细节

- 切页时 Logo 和面包屑都变淡，转圈出现在 Logo 位置。
- 退出登录时先将『再见！Ciao~』入队，随后暂停发起其他 Toast 并强制整页刷新。浏览器实际呈现告别的时机随调度。其他标签页收到退出通知后直接强制刷新。
- 首次访问没有时区 cookie，先按 UTC 渲染，水合后切到本地时区，时间可能跳一次。
- 首屏遮罩在 15 秒兜底时限到达后开始退场。

前三条人类 2026-11-15 答复不进 LAW、保持现状，见 [SID#2.0.AGENT](AGENT.md#人类裁定)。

## 验收标准

| 条目 | 测试 |
| --- | --- |
| 日期、时长格式化与时区换算 | [time.test.ts](../../../app/utils/time.test.ts) |
| 水合期间保持服务端的时区，水合后切到浏览器时区 | [timezone.test.ts](../../../app/plugins/timezone.test.ts) |
| 确认气泡优先在按钮下方，靠近底部时翻到上方，不超出视口 | [useMyConfirm.test.ts](../../../app/composables/useMyConfirm.test.ts)、[confirm-popup.test.ts](../../../app/utils/confirm-popup.test.ts) |
| 确认气泡推迟到点击事件之后再弹出 | [useMyConfirm.test.ts](../../../app/composables/useMyConfirm.test.ts) |
| 自动更新的失效、刷新、共享、轮询、错误提示只弹一次 | [useSyncedData.test.ts](../../../app/composables/useSyncedData.test.ts)、[query.test.ts](../../../app/utils/sync/query.test.ts)、[useDataSync.test.ts](../../../app/composables/useDataSync.test.ts) |
| 跨页面、跨标签页的自动更新 | [account-sync.spec.ts](../../../tests/e2e/account-sync.spec.ts)、[content-sync.spec.ts](../../../tests/e2e/content-sync.spec.ts) |
| 401 只触发一次退出登录 | [useTrpcClient.test.ts](../../../app/composables/useTrpcClient.test.ts) |
| 删除确认框的结果标明为打开时的快照 | [DeleteImpact.nuxt.test.ts](../../../app/components/MyContent/DeleteImpact.nuxt.test.ts) |
| SSR 出错时带请求标识写日志 | [ssr-error.server.test.ts](../../../app/plugins/ssr-error.server.test.ts) |
| 面包屑与标签页标题 | [pages-plain.spec.ts](../../../tests/e2e/pages-plain.spec.ts) |
| 首屏遮罩的显示、移除与 15 秒兜底 | [pages-render.spec.ts](../../../tests/e2e/pages-render.spec.ts)、[first-paint-mask.spec.ts](../../../tests/e2e/first-paint-mask.spec.ts) |
| Esc 清掉全部提示 | [app.nuxt.test.ts](../../../app/app.nuxt.test.ts) |
| `error_message()` 的转换规则 | [error.test.ts](../../../app/utils/error.test.ts) |
