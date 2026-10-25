# 测试与验证

测试应证明可观察的业务合同，尤其是权限、数据提交、重试、取消及同步边界。布局、Canvas、触摸和浏览器文件权限必须通过真实浏览器验证，不能仅凭 Node 测试宣布通过。

## 检查层次

| 层次 | 入口 | 能证明什么 |
| --- | --- | --- |
| 配置生成 | `pnpm settings:check` | 提交的共享 settings 与 YAML 一致 |
| 风格 | `pnpm lint` | 源码、测试和文档符合仓库 ESLint 规则 |
| 类型 | `pnpm exec nuxt typecheck` | Nuxt、Vue、服务端与共享类型契约 |
| 工具类型 | `pnpm exec tsc --project scripts/tsconfig.json --noEmit` | 维护工具和 TS 迁移类型 |
| 单元／服务测试 | `pnpm test` | 领域状态、校验、对象操作与持久化调用合同 |
| 数据库与生产产物 | `scripts/verify/` | 真实 MySQL、执行恢复、原生图片编码和打包入口 |
| 浏览器及云端 | 真实页面与开发资源 | 交互、授权、上传、缓存交付和外部回执 |

按改动选择必要检查。纯文档编辑通常只需要文档 lint、链接和命令核对；不会为了文档重排重跑云端迁移或应用构建。

## Vitest 约定

[vitest.config.ts](../../vitest.config.ts) 使用 Node 环境，没有 jsdom、happy-dom、共享 setupFiles 或通用浏览器夹具。`~`、`@config`、`@server`、`@shared` 别名由该文件配置。`import.meta.client` 固定为 true、`import.meta.server` 为 false；SSR 独有路径要明确构造对应入口，不能把客户端替换环境当成真实 SSR。

- 测试与模块同目录，命名 `<module>.test.ts`；只在确有多个调用者时提取测试辅助逻辑。
- `describe` 围绕被测功能，`it` 说明触发条件和可观察结果；延续文件已有语言，不为统一语言批量改写。回归测试应能看出原先哪里会出错。
- 夹具保留与场景有关的关键差异，公共准备只提取稳定重复部分。避免用过长的通用工厂、隐式默认值或层层 helper 隐藏权限、版本、时序和失败条件；有意反常的数据旁说明原因。
- 优先断言返回值、错误状态／文案、事务内写入、对象影响和同步资源。涉及接线风险时通过真实调用入口断言，不只测试被调用的 helper。
- 用 `vi.hoisted` 定义边界 mocks，再 `vi.mock`，随后 `await import()` 被测模块；`vi.mock` 会提升，普通顶层变量可能尚未初始化。边界形状必须符合实现，例如 `db.execute` 和事务连接各自的 `execute`。
- Mock 数据库、对象存储、时钟、网络等边界，不 mock 被测服务来证明它自己正确。
- 新增守卫测试要临时破坏对应行为，确认测试会变红，再恢复实现；不要留下故意破坏的源码。
- 失败先判断合同还是实现错误，不使用 `.skip`、空断言或放宽期望掩盖问题。
- 源码读取型测试仅适合源码本身就是合同的情况，例如打包图标清单、入口命令、部署脚本约束；注释说明原因，断言真实的最小覆盖范围，防止空集合也通过。优先使用可达到同等覆盖的运行时断言。

可用 `pnpm exec vitest run <测试文件>` 定向执行。类型、import 或共享协议变更还应执行完整类型检查；跨域修改再扩大到全量测试。

测试文件同样接受 lint 检查。修复测试代码自身的错误，不掏空断言；确实无法适用的规则才使用说明原因的局部豁免。测试中的配置、时钟和边界数据必须明确，避免依赖当前机器的时间、时区或云端状态。

测试注释用于解释反例、时序及回归背景，不逐句复述断言。既有的个人吐槽、POV 和排障故事按[作者表达保留规则](../../.github/copilot-instructions.md#workflow-and-runtime)维护，不因测试整理而删除。

## SSR、身份与时间

- 数据库使用 UTC；展示通过项目日期工具接收明确时区。跨 Nuxt payload 的时间保存为 ISO 字符串等可序列化值，不存 Dayjs 对象。
- `useDisplayTimeContext` 的 `now_ms` 与 timezone 是同一份序列化显示上下文。SSR 从 cookie 读取时区，hydration 期间保持服务器快照；浏览器时区切换及共享时钟在 `app:suspense:resolve` 后开始。
- `useSyncedState` 的 payload 数据在 hydration 时不能被先完成的客户端请求提前改写；测试数据／loading／回调的提交时机，fetcher 不应顺手修改共享渲染状态。
- 触发型 `immediate: false` 代理尚无已获取的数据。默认立即获取的订阅者应加入在途请求并等待，不能把空代理当 SSR 初值。
- 登录切换时不能用客户端旧 user ref 跳过请求；增量数据比较应使用服务端 viewer key。跨标签会话与权限变化要用浏览器补验。

涉及这些边界时，同时检查源码的约束测试和真实 SSR 首屏／hydration；单独挂载客户端组件不能替代首屏一致性验证。

## 迁移演练

以下命令创建、使用并清理随机命名的隔离 QA 数据库，需要开发 MySQL root 凭据。它们不对业务数据库执行迁移，但会在开发数据库服务器上创建资源。

```powershell
$env:NODE_ENV = 'development'
pnpm exec tsx --tsconfig scripts/tsconfig.json scripts/verify/migration-runtime.ts
pnpm exec tsx --tsconfig scripts/tsconfig.json scripts/verify/content-migration.ts
```

- `migration-runtime.ts` 覆盖维护门禁、事务检查点、失去连接、双执行者、部分 SQL 恢复、单账本升级、完整链重放和生产打包入口。
- `content-migration.ts` 默认使用真实 MySQL 与 Sharp，远程对象边界在内存中模拟。`--oss` 使用真实开发 OSS；`--legacy` 进一步验证旧开发 S3，均会创建测试对象并执行精确清理。
- 云端参数只在需要真实存储演练时使用。不要把这些脚本指向生产；程序也要求 development 和开发目标桶。
- 生产数据副本演练与生产维护切换另见 [Content 切换](../operations/content-cutover.md)。空库或合成数据成功不代替真实数据兼容验收。

CI 的 [Check 工作流](../../.github/workflows/check.yml) 包含 lint、生成检查、两套类型检查、单测、MySQL 8.4 空库完整链和隔离演练。当前 CI 的 Content 存储边界为内存，不会自动验证真实 OSS、ESA、短信或浏览器操作。

## 浏览器验收矩阵

每次只使用本轮明确创建或获准操作的数据，记录入口、身份、动作和结果。删除测试对象前核对其精确 key／版本，避免把清理变成前缀擦除。

| 领域 | 关键场景 |
| --- | --- |
| 编辑器 | 全屏／非全屏、窄屏、输入与预览稳定性、诊断、粘贴／拖入 |
| 上传 | 多选与目录、`.good` 继承、重名 resolve、暂停继续、取消、替换与 row 交接 |
| 文件权限 | 原生句柄撤权后重选、刷新恢复、过期／失效会话；需要系统交互的步骤由操作者完成 |
| 图片 | 静态转换、GIF/SVG 原样、加载遮罩、损坏占位、覆盖／另存为／删减版、触摸与滚轮 |
| 授权 | 无登录、普通用户、机密权限用户；普通下载与删减版下载分别验证 |
| 云端读取 | 合法 GET/HEAD/Range、完整下载大小与 SHA-256、缺失／篡改 grant、缓存 HIT 后撤权 |
| 实时同步 | 两个标签页、另一个浏览器、登录退出、网络恢复、通知最终一致性 |
| 生命周期 | 发布后预热、替换／删除后对象退役与 ESA 刷新、runner 停止和恢复 |

开发隧道的空请求 403 仅证明通道拒绝路径。一次 `HEAD` 成功、服务进程 running 或缓存 HIT，都不能代替完整下载和读取撤销测试。

## 验收记录写法

长期文档描述如何验证以及已知边界；一次性测试文件数、临时对象名、进程 PID 和逐分钟排障记录不进入功能手册。提交或任务报告记录本次实际执行的检查，并区分已执行、未执行和仍需人工协作的部分。
