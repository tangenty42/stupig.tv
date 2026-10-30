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
| `pnpm exec playwright test --config tests/css-production.config.ts` | 完整 production 前端构建；保留 legacy、CSS 目标、压缩和分块，复用隔离业务配置 |
| `pnpm test:all` | 执行单元、工具、组件和浏览器测试 |
| `pnpm lint` | 代码、测试和文档规范 |
| `pnpm exec nuxt typecheck` | 应用类型 |
| `pnpm exec tsc --project scripts/tsconfig.json --noEmit` | 工具类型 |
| `pnpm exec tsc --project tests/tsconfig.json --noEmit` | 浏览器测试与测试边界类型 |

纯逻辑和服务测试继续与模块同目录，命名 `*.test.ts`。挂载测试使用 `*.nuxt.test.ts`，由独立组件配置运行；不把 Nuxt runtime 加进每个纯单测。浏览器工作流放在 `tests/e2e/*.spec.ts`，一个场景一个文件——Playwright 的分片以文件为单位分配，把多个场景塞进同一个文件会让 `--shard` 失衡甚至空转。共享基础夹具可以复用，场景中的身份、版本、失败条件应在测试中清楚可见。

## 应该断言什么

- 单元测试检查返回值、状态转换、错误、事务写入和外部操作；模拟数据库、网络、时钟等基础设施边界。
- 组件测试通过真实 SFC 编译和挂载，检查 DOM、模型事件、输入、点击与生命周期。替换浏览器不支持的 Canvas 边界时，明确剩余验证范围。
- 浏览器测试操作真实页面，按条件等待而不是固定 sleep；失败保留 trace 和截图。
- 迁移 digest、部署入口和产物依赖确实以源码或文件为合同，可以保留相应断言。一般 UI 不应依赖源码切片、VM 执行、私有变量名或模板字符串。
- 安全、并发和数据丢失回归需要证明能检出原先的错误；不要求每个普通 guard 都进行临时破坏操作。
- 不因测试失败而弱化业务约束。替换旧测试时保留有价值的场景，合并重复的内部实现断言。

## 浏览器测试的隔离

首次执行 `pnpm exec playwright install chromium`。运行前需要本地开发 MySQL、Redis、支持 TCP 发布及 WebSocket 订阅的 MQTT broker，以及 `MYSQL_DEV_ROOT_PASSWORD`。CI 在独立服务中提供它们，不需要真实云端密钥；浏览器用例按 `--shard` 拆成三个 job 并行，Playwright 浏览器包按版本进 Actions 缓存。只改 `docs/**` 或 Markdown 的 PR 由 `changes` job 识别并跳过应用测试——PR 的门槛只能放在 job 条件上，加在 `on.pull_request.paths` 会让必需检查永远停在 Pending。纯文档提交推送到 `main` 时，push 路径过滤不启动 Check，也不触发依赖它的 Deploy；与代码混合的提交仍执行正常检查流程。

非纯文档提交在 `main` 上仍启动 Check，以便部署等待同一提交的验证结果。若合并 PR 的完整检查和三个浏览器分片均成功，且 PR 实际测试的 Git tree 与合并结果一致，则复用全部结果，跳过 `check`、`migrations`、浏览器和 MQTT 的重复运行；找不到完整成功记录、代码树不同、验证规则自身变更或 GitHub 查询失败时，`main` 会完整重跑。GitHub 的路径过滤只检查变更列表中的前 3,000 个文件；超大推送应拆分，避免代码文件落在过滤范围之外，详见 [GitHub 工作流触发说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。

测试启动器创建随机命名的 `stupig_e2e_*` 数据库，执行完整迁移并创建开发测试账号；复制应用源码到临时目录，构建后在本分片的端口启动独立 Nuxt（未分片为 3142，`--shard=i/n` 使用 `3142 + i - 1`，规则见 `scripts/testing/e2e-target.ts`）。已有端口被占用时拒绝运行，不接管未知服务。结束时停止自己的进程树、删除本轮数据库并清理临时运行凭据。

OSS、CAPTCHA 和短信在测试专用 Nuxt 配置中替换供应商边界。浏览器保留真实 HTTPS 上传授权校验，测试将分片请求转发到本地字节接收器；真实 API、事务、发布和取消确认照常执行。短信夹具只在隔离开发环境运行，固定测试码为 `123456`，模拟发送后校验、错误码和过期拒绝；发送冷却及配额仍由真实服务和数据库执行，不发送真实短信。头像通过实际选图、Canvas 裁剪、上传和资料保存，本地交付路由返回内存 OSS 中实际保存的字节。

浏览器用例覆盖：

- 页面巡检：管理员硬导航打开所有当前应用页面，包括已有档案与新建编辑页；共享页面夹具检查未捕获异常和同源 5xx，等待真实 hydration，并确认应用主动关闭首屏遮罩，不依赖 15 秒兜底。
- 账号生命周期：一次性用户发送验证码、错误码拒绝、注册、刷新保留会话、修改生日、裁剪上传及删除头像、修改密码时拒绝错误旧密码、退出后拒绝原密码并接受新密码；另测手机验证码登录和服务端发送冷却。资料通过刷新回读，头像检查真实图片解码。
- 权限：匿名和普通用户访问控制台、新建及编辑页被重定向，不能看到他人资料编辑控件；直接请求管理接口和越权资料修改分别返回 401 或 403。
- 档案：创建和编辑持久化、普通附件上传、在途上传取消并收到服务端确认、两个隔离浏览器上下文间的正文同步（排除 BroadcastChannel 旁路）。

该流程不证明真实 OSS、ESA 缓存交付、短信供应商、CAPTCHA 供应商或原生文件权限正常。默认夹具只面向 Chromium，禁用 legacy 构建；服务器复用已安装的 SDK，不验证独立部署镜像依赖收集。MQTT 主题按本轮标识隔离；浏览器连接使用已验证的本地 broker 主机地址，需确保其 WebSocket 端口可达。日志和 Playwright 产物位于被 Git 忽略的 `.dev/`；CI 只上传服务器日志、trace、截图和报告，不上传临时运行配置。真实云端与操作系统行为继续按下面矩阵验收。

生产 CSS 验收使用独立的 `tests/css-production.config.ts`。它复用同一个隔离启动器，但仅在构建子进程设置 `NODE_ENV=production`，保留 legacy；业务配置、测试服务及数据库仍使用开发隔离边界。`BROWSERSLIST_ENV=production` 显式传递，JS legacy 与 CSS 引擎目标由 package.json 的 production Browserslist 经 `config/browser-targets.ts` 接线，CSS minifier 和 code splitting 在 Nuxt 中显式配置。

Markdown 诊断入口先加载 FormatJS 的标准 `Intl.Segmenter` polyfill，再求值 markdownlint 依赖。生产构建通过 `config/browser-transforms.ts` 的官方 Rollup Babel 插件，在 Oxc 之前编译静态 `/v` 正则的 Unicode 集合语义；Oxc 单独降为 `RegExp(..., 'v')` 不能补齐旧引擎能力。`scripts/verify/browser-regexp.test.ts` 构建真实 modern / legacy 双产物，在拒绝 `v` flag 的构造器边界检查 emoji 与组合字符；`lint-legacy.test.ts` 在缺少 Segmenter 时加载真实诊断入口。这些回归不能替代历史浏览器中的完整编辑验收。

启动器从实际 Vite `configResolved` 记录目标、minifier、分块及插件，检查最终 CSS 和 legacy JS 资产；报告保存在本轮 `.dev/e2e/<run>/css-build.json`。该 profile 运行 SSR（禁用页面 JS）与 hydration、分页器、延迟路由 / 懒加载组件 CSS、Dialog / ConfirmPopup 动画、六级吸顶标题与全屏编辑滚动，以及媒体渐变中间帧、加载 / 失败、权限表示、深浅色、窄容器和重渲染恢复。测试专用页面仅属于 E2E Nuxt layer，额外 utility class 仅加入夹具构建的 Tailwind content，不写入产品配置。CI 的 browser 第一分片在常规 E2E 后执行此 profile，并在失败时保留 `.dev/css-production/`。它验证现代 Chromium 上的生产产物，不代替最低版本引擎或发布缓存验收。

CSS 官方 API 的独立浏览器夹具可用 `pnpm exec playwright test --config tests/css.config.ts` 运行，不启动应用或数据库。它挂载真实 PrimeVue / CodeMirror，并对 Tailwind selector 策略、Teleport、行内尺寸、主题更新及静态 CSS 压缩结果做对照；同一回归文件也会被普通 E2E 配置发现。该入口不验证 Nuxt SSR/hydration、完整生产构建或真实旧引擎，具体结果与边界见[验证记录](../reviews/css-official-apis-validation-2026-10-29.md)。

历史工具类的独立回归使用 `pnpm exec playwright test --config tests/css-legacy-utilities.config.ts`，同样不启动应用或数据库。它在真实 Chromium 80 / Firefox 78 中检查实际应用配置的普通及局部 `!` 暗色背景类，覆盖 PostCSS 原始和 Lightning CSS 压缩后的四种引擎 / 输出组合。实际配置关闭全局 important，保留普通 dark variant；组件覆盖由 preset、PT 和局部 `!` 验证。原 `application-local` 候选已合入正式 `application` 夹具，不再维护重复实验模式。

Windows 上已安装的历史引擎使用 `pnpm exec playwright test --config tests/css-legacy.config.ts` 复验，保留相同隔离生产构建，使用 Chromium 80 / Firefox 78 及匹配 WebDriver，并在同一构建运行现代 Chromium 生产对照。历史场景通过原生点击和输入覆盖确认浮层、真实登录 / Markdown 编辑 / 全屏预览 / 主题与用户菜单，并复用与现代浏览器相同的媒体观测。确认浮层验收页复用应用 `useMyConfirm()` 和公开 PT state / transition DOM 补偿，原生点击后检查实际锚点坐标。二进制位于 `.dev/tools/legacy-browsers/`，不属于仓库依赖；普通 E2E 会跳过旧引擎专用场景。安装来源、实际结果与未覆盖平台见[旧引擎记录](../reviews/css-legacy-engines-2026-10-29.md)。

历史 profile 通过仅回环 HTTPS 代理访问隔离应用，避免旧引擎拒收 HTTP localhost 的 Secure cookie。Windows 证书仅驻留内存，信任例外只属于临时 WebDriver 会话，不安装系统证书、不降低应用 cookie 安全属性。现代 production profile 保持原有入口；该测试代理不进入产品构建。

历史驱动对响应式表单和 CodeMirror 逐字符发送原生按键；提交前检查实际字段值，正文保留原有长文档。旧引擎专用项目使用独立的用例 / 等待时间预算，现代首屏遮罩时限仍保留。窄屏验收检查真实文档 scrollWidth；缺少 Web Locks 而只读的编辑页必须判失败，不能强制开启编辑或删除该断言。

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

长期文档描述如何验证以及已知边界；一次性测试文件数、临时对象名、进程 PID 和逐分钟排障记录不进入功能手册。PR 的 `Verification` 或任务报告记录本次实际执行的检查，并区分已执行、未执行和仍需人工协作的部分。
