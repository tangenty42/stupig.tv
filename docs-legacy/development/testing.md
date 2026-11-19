# 测试与验证

> 当前操作见 [SID#1.2.DESIGN](../../docs/1_workflows/2_test/DESIGN.md)及其[操作补充](../../docs/1_workflows/2_test/AGENT-DESIGN.md)。本文保留领域验证细节、SSR／身份合同、历史参考及旧章节锚点；既有验证边界与决定见 [SID#1.2.AGENT](../../docs/1_workflows/2_test/AGENT.md)。

## 命令与环境

命令选择与测试文件命名见[测试工作流](../../docs/1_workflows/2_test/DESIGN.md)；各分组环境、别名和定向运行见[编写与定向运行](../../docs/1_workflows/2_test/AGENT-DESIGN.md#编写与定向运行)。

## 应该断言什么

断言、替身和真实入口的选择见[编写与定向运行](../../docs/1_workflows/2_test/AGENT-DESIGN.md#编写与定向运行)；登录等待、只读请求重试及失败注入见[E2E 隔离与失败排查](../../docs/1_workflows/2_test/AGENT-DESIGN.md#e2e-隔离与失败排查)。

## 浏览器测试的隔离

资源隔离、分片、供应商替身、清理与产物位置见[E2E 隔离与失败排查](../../docs/1_workflows/2_test/AGENT-DESIGN.md#e2e-隔离与失败排查)；CI 门槛和 main 结果复用见[MQTT 镜像与 CI 汇总](../../docs/1_workflows/2_test/AGENT-DESIGN.md#mqtt-镜像与-ci-汇总)。

下列领域场景细节保留作原测试说明；本轮文档迁移没有重新执行这些场景。

浏览器用例覆盖：

- 页面巡检：管理员硬导航打开所有当前应用页面，包括已有档案与新建编辑页；共享页面夹具检查未捕获异常和同源 5xx，等待真实 hydration，并确认应用主动关闭首屏遮罩，不依赖 15 秒兜底。
- 账号生命周期：一次性用户发送验证码、错误码拒绝、注册、刷新保留会话、修改生日、裁剪上传及删除头像、修改密码时拒绝错误旧密码、退出后拒绝原密码并接受新密码；另测手机验证码登录和服务端发送冷却。资料通过刷新回读，头像检查真实图片解码。
- 权限：匿名和普通用户访问控制台、新建及编辑页被重定向，不能看到他人资料编辑控件；直接请求管理接口和越权资料修改分别返回 401 或 403。
- 档案：创建和编辑持久化、普通附件上传、在途上传取消并收到服务端确认、两个隔离浏览器上下文间的正文同步（排除 BroadcastChannel 旁路）。
- 引用：独立浏览器上下文中的标题和附件目录改名、main 与草稿重放、新建草稿、删除影响确认及悬空 warning、同名重建，以及附件／全局标题各自的 200 批次窗口。窗口测试在随机测试库用历史仓库准备批次，再经实际 API 或编辑器触发变更、裁剪和保存；验证 floor 边界与 250 行批次完整保留。

CSS／历史浏览器的 profile、运行前提和隔离边界见[CSS 与历史浏览器](../../docs/1_workflows/2_test/AGENT-DESIGN.md#css-与历史浏览器)。以下保留兼容实现与领域断言细节：

Markdown 诊断入口先加载 FormatJS 的标准 `Intl.Segmenter` polyfill，再求值 markdownlint 依赖。生产构建通过 `config/browser-transforms.ts` 的官方 Rollup Babel 插件，在 Oxc 之前编译静态 `/v` 正则的 Unicode 集合语义；Oxc 单独降为 `RegExp(..., 'v')` 不能补齐旧引擎能力。`scripts/verify/browser-regexp.test.ts` 构建真实 modern / legacy 双产物，在拒绝 `v` flag 的构造器边界检查 emoji 与组合字符；`lint-legacy.test.ts` 在缺少 Segmenter 时加载真实诊断入口。这些回归不能替代历史浏览器中的完整编辑验收。

生产 CSS profile 运行 SSR（禁用页面 JS）与 hydration、分页器、延迟路由 / 懒加载组件 CSS、Dialog / ConfirmPopup 动画、六级吸顶标题与全屏编辑滚动，以及媒体渐变中间帧、加载 / 失败、权限表示、深浅色、窄容器和重渲染恢复。测试专用页面仅属于 E2E Nuxt layer，额外 utility class 仅加入夹具构建的 Tailwind content，不写入产品配置。

历史工具类的原 `application-local` 候选已合入正式 `application` 夹具，不再维护重复实验模式。CSS API 的原始验证结果见[验证记录](../reviews/css-official-apis-validation-2026-10-29.md)。

确认浮层验收页复用应用 `useMyConfirm()` 和公开 PT state / transition DOM 补偿，原生点击后检查实际锚点坐标。

窄屏验收检查真实文档 scrollWidth；缺少 Web Locks 而只读的编辑页必须判失败，不能强制开启编辑或删除该断言。

历史浏览器安装来源、实际结果与未覆盖平台仍见[旧引擎记录](../reviews/css-legacy-engines-2026-10-29.md)。

## SSR、身份与时间

- 数据库使用 UTC；展示通过项目日期工具接收明确时区。跨 Nuxt payload 的时间保存为 ISO 字符串等可序列化值，不存 Dayjs 对象。
- `useDisplayTimeContext` 的 `now_ms` 与 timezone 是同一份序列化显示上下文。SSR 从 cookie 读取时区，hydration 期间保持服务器快照；浏览器时区切换及共享时钟在 `app:suspense:resolve` 后开始。
- `useSyncedState` 的 payload 数据在 hydration 时不能被先完成的客户端请求提前改写；测试数据／loading／回调的提交时机，fetcher 不应顺手修改共享渲染状态。
- 触发型 `immediate: false` 代理尚无已获取的数据。默认立即获取的订阅者应加入在途请求并等待，不能把空代理当 SSR 初值。
- 登录切换时不能用客户端旧 user ref 跳过请求；增量数据比较应使用服务端 viewer key。跨标签会话与权限变化要用浏览器补验。

涉及这些边界时，同时检查源码的约束测试和真实 SSR 首屏／hydration；单独挂载客户端组件不能替代首屏一致性验证。

## 迁移演练

命令、各脚本覆盖范围、QA 库与真实对象写入边界见[专项数据库与迁移演练](../../docs/1_workflows/2_test/AGENT-DESIGN.md#专项数据库与迁移演练)。生产副本预演与旧数据维护切换仍见 [Content 切换](../operations/content-cutover.md)；空库或合成数据成功不代替真实数据兼容验收。

## 浏览器验收矩阵

当前真实浏览器、云端与系统验收清单见[真实云端与系统验收](../../docs/1_workflows/2_test/AGENT-DESIGN.md#真实云端与系统验收)；草稿生产 profile 与有界负载入口分别见[CSS 与历史浏览器](../../docs/1_workflows/2_test/AGENT-DESIGN.md#css-与历史浏览器)、[专项数据库与迁移演练](../../docs/1_workflows/2_test/AGENT-DESIGN.md#专项数据库与迁移演练)。

草稿负载夹具的具体测量边界保留如下：

`--capacity` 记录深目录快照、两个写者／四个后台 SQL 占位和全局标题引用更新的延迟；其中两张图片走真实任务账本和可注入云端边界，成品夹具在计时前生成，处理回执固定延迟 5ms，禁止应用下载整图。该夹具验证数据库与任务并行，不测真实 OSS 转换速度或本地编码性能。

`content-cloud-draft`、`content-draft-history`、`content-draft-tabs`、`content-draft-lost-response`、`content-draft-expiry` 浏览器场景分别验证云端自动保存／main 不变、快照核对、隐藏交接、真实提交后响应丢失、释放不可达时到期接管。跨浏览器使用独立 context；同浏览器 headless 标签页通常均保持 visible，测试明确驱动 document visibility 边界，不能把 focus 当作租约释放。网络失败用实际 route 阻断或提交后丢包，不用本地 offline 事件代替。

## 验收记录写法

记录要求见[验收记录](../../docs/1_workflows/2_test/AGENT-DESIGN.md#验收记录)。一次性测试文件数、临时对象名、进程 PID 和逐分钟排障记录不进入功能手册。
