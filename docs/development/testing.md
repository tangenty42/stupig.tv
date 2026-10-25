# 测试与验证

测试优先证明用户可观察的行为和数据合同。按风险选择验证；文案、格式和简单接线无需为了数量增加单测。已有源码断言应在行为覆盖建立后删除，而不是继续约束变量名、标签写法或文件排布。

## 命令与环境

| 命令 | 环境与范围 |
| --- | --- |
| `pnpm test:unit` | Node；app 与 server 分组，客户端标志仅用于 app 测试 |
| `pnpm test:tools` | Node；迁移、打包和 CLI 测试串行运行，避免抢占构建及子进程资源 |
| `pnpm test:component` | Nuxt + happy-dom；真实挂载 Vue 组件及依赖组件生命周期的 composable |
| `pnpm test` | 依次执行以上三组 |
| `pnpm test:e2e` | Playwright Chromium；实际 Nuxt、API、MySQL 和同步传输 |
| `pnpm test:all` | 执行单元、工具、组件和浏览器测试 |
| `pnpm lint` | 代码、测试和文档规范 |
| `pnpm exec nuxt typecheck` | 应用类型 |
| `pnpm exec tsc --project scripts/tsconfig.json --noEmit` | 工具类型 |
| `pnpm exec tsc --project tests/tsconfig.json --noEmit` | 浏览器测试与测试边界类型 |

纯逻辑和服务测试继续与模块同目录，命名 `*.test.ts`。挂载测试使用 `*.nuxt.test.ts`，由独立组件配置运行；不把 Nuxt runtime 加进每个纯单测。浏览器工作流放在 `tests/e2e/*.spec.ts`。共享基础夹具可以复用，场景中的身份、版本、失败条件应在测试中清楚可见。

## 应该断言什么

- 单元测试检查返回值、状态转换、错误、事务写入和外部操作；模拟数据库、网络、时钟等基础设施边界。
- 组件测试通过真实 SFC 编译和挂载，检查 DOM、模型事件、输入、点击与生命周期。替换浏览器不支持的 Canvas 边界时，明确剩余验证范围。
- 浏览器测试操作真实页面，按条件等待而不是固定 sleep；失败保留 trace 和截图。
- 迁移 digest、部署入口和产物依赖确实以源码或文件为合同，可以保留相应断言。一般 UI 不应依赖源码切片、VM 执行、私有变量名或模板字符串。
- 安全、并发和数据丢失回归需要证明能检出原先的错误；不要求每个普通 guard 都进行临时破坏操作。
- 不因测试失败而弱化业务约束。替换旧测试时保留有价值的场景，合并重复的内部实现断言。

## 浏览器测试的隔离

首次执行 `pnpm exec playwright install chromium`。运行前需要本地开发 MySQL、Redis、支持 TCP 发布及 WebSocket 订阅的 MQTT broker，以及 `MYSQL_DEV_ROOT_PASSWORD`。CI 在独立服务中提供它们，不需要真实云端密钥。

测试启动器创建随机命名的 `stupig_e2e_*` 数据库，执行完整迁移并创建开发测试账号；复制应用源码到临时目录，构建后在 3142 端口启动独立 Nuxt。已有端口被占用时拒绝运行，不接管未知服务。结束时停止自己的进程树、删除本轮数据库并清理临时运行凭据。

OSS 和 CAPTCHA 在测试专用 Nuxt 配置中替换边界。浏览器保留真实 HTTPS 上传授权校验，测试将分片请求转发到本地字节接收器；真实 API、事务、发布和取消确认照常执行。密码登录和会话验证使用真实服务实现，不调用短信供应商。该流程不证明真实 OSS、ESA 缓存交付、短信或原生文件权限正常。MQTT 主题按本轮标识隔离。日志和 Playwright 产物位于被 Git 忽略的 `.dev/`；CI 只上传服务器日志、trace、截图和报告，不上传临时运行配置。

当前五个浏览器场景覆盖密码登录及刷新、档案创建和编辑持久化、普通附件上传、在途上传取消并收到服务端确认、两个隔离浏览器上下文间的正文同步（排除 BroadcastChannel 旁路）。夹具只面向 Chromium，禁用 legacy 构建；服务器复用已安装的 SDK，不验证独立部署镜像依赖收集。真实云端与操作系统行为继续按下面矩阵验收。

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

CI 的 [Check 工作流](../../.github/workflows/check.yml) 包含 lint、生成检查、应用／工具／浏览器测试类型检查、三组 Vitest、MySQL 8.4 空库完整链和隔离演练，以及独立的 Chromium 工作流测试。Content 云存储边界为内存，不会自动验证真实 OSS、ESA 或短信。

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
