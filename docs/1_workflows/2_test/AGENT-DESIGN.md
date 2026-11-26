# AGENT-DESIGN：测试编写与专项验证

- 本文档状态：DONE
- 覆盖范围：测试边界、浏览器隔离、专项演练、CI 汇总与验收记录
- 上位文档：[SID#1.2.DESIGN](DESIGN.md)、[SID#0.1.DESIGN](../../0_overall/1_architecture/DESIGN.md)
- 核对基线与未验证范围：[SID#1.2.AGENT](AGENT.md)

日常检查选择、命令表和文件命名见 `SID#1.2.DESIGN`。本文补充怎样写测试、定位失败及运行专项验证；生产发布按 [SID#1.3.DESIGN](../3_deliver/DESIGN.md) 执行。

## 编写与定向运行

按变更行为和风险选择检查。缺陷修复及实质行为变更补有意义的回归覆盖，文档、格式和简单接线按实际风险验证。共享夹具和 setup 用来减少重复基础设施，同时让场景本身可读。测试命名及目录以 DESIGN 为准。

Service 测试覆盖输入校验、异常状态与提示，以及数据库、对象和通知副作用。事务连接使用自己的 `execute` mock。基础设施边界可替换，被测 service 保留真实实现。安全、并发与数据丢失问题在可行时确认测试能检出原错误，保留业务断言及相关检查，修复测试或类型失败后再收尾。

有行为影响时运行对应测试，变更后运行 `pnpm lint`。类型或导入重构后运行 `pnpm exec nuxt typecheck`，影响 scripts 时也执行其 TypeScript 检查。纯文档检查 lint、本地链接、命令入口及源码一致性。格式规则见 [全项目工程约定](../../0_overall/AGENT-DESIGN.md#格式与代码复用)。

测试断言返回值、DOM、状态变化、事务结果和外部操作。替换数据库、网络、时钟等边界，保留被测模块的真实实现；连接入口或打包产物本身是合同的测试，应通过真实入口验证。迁移摘要和产物文件的断言继续保留，一般页面测试不绑定私有变量名或模板字符串。

| 测试环境 | 项目约定 |
| --- | --- |
| [Vitest 单元与工具](../../../vitest.config.ts) | app、server、tools 分组；仅 app 的 `import.meta.client=true`，server 相反；tools 按文件串行，避免打包与子进程互抢资源 |
| 单元测试别名 | `~` 指向 `app/`，另有 `@config`、`@server`、`@shared`；H3 使用 Nuxt 已安装的版本，真实适配器测试不再引入第二份 |
| [组件挂载](../../../vitest.component.config.ts) | Nuxt 测试环境、happy-dom，独立构建目录 `.nuxt/component-tests`；不自动加载应用插件，挂载所需边界由测试准备 |
| 组件替身 | 使用 `mountSuspended` 挂载真实 SFC；自动导入边界可用 `mockNuxtImport`，模块边界用 `vi.mock`；结束后卸载并清理 DOM。示例见 [Markdown 预览测试](../../../app/components/MyContent/Markdown/Preview.nuxt.test.ts) |

定向运行选择对应分组；`pnpm test` 是三个脚本的串联，不用于统一传递文件过滤参数：

```sh
pnpm test:tools scripts/testing/e2e-target.test.ts
pnpm test:component app/components/MyContent/Markdown/Preview.nuxt.test.ts
pnpm test:e2e tests/e2e/content-cloud-draft.spec.ts
```

浏览器测试按条件等待，保留失败 trace 和截图。安全、并发和数据丢失回归应能检出原错误，不为通过测试而削弱业务约束。Canvas、文件句柄和布局等浏览器边界被替换时，记录还需真实浏览器补验的部分。

纯工具、composable、store 和渲染器用对应单元或组件测试验证。Canvas、指针、布局和原生权限涉及真实浏览器行为时，使用浏览器入口。源码或文件本身是合同的产物检查继续保留，UI 和运行逻辑通过真实可达的行为入口验证。

涉及 SSR、身份或时间的改动，按 `SID#0.1.DESIGN` 核对服务器快照、hydration 提交时机及登录切换；客户端挂载通过后，仍需相应的真实 SSR／跨标签用例。运行时的数据归属和同步规则保留在架构或领域文档中。

## E2E 隔离与失败排查

满足 DESIGN 的共同前提后，[启动器](../../../scripts/testing/browser.ts) 会核对 MySQL 为 `localhost` 或 `127.0.0.1`，使用 `MYSQL_DEV_ROOT_PASSWORD` 创建随机 `stupig_e2e_*` 数据库，执行基线及后续迁移，再创建测试账号。它复制源码到 `.dev/e2e/<run>/`，构建并启动本轮应用，不复用日常开发服务。

应用默认端口为 3142；[分片规则](../../../scripts/testing/e2e-target.ts) 令 `--shard=i/n` 使用 `3142 + i - 1`，最多 20 片。端口被占用时拒绝启动，不接管未知服务。CI 使用三片，本机可分别执行 `pnpm test:e2e --shard=1/3`、`2/3`、`3/3`；每片各有数据库、主题和产物目录，一个场景一个文件才能均衡分配。

运行配置中的 MQTT 会被替换为本轮[临时 EMQX](../../../scripts/testing/cloud-draft-broker.ts)：随机回环端口、随机发布凭据，提供公开与私有 WebSocket listener，资源限制为 2 CPU／768 MiB。它验证真实传输和应用授权回调；公网 WSS 与服务器反代另行验收。

OSS、短信、CAPTCHA 仅替换供应商边界。上传仍经过真实 API、签名校验、事务与发布确认，分片请求转到本地字节接收器；短信夹具验证码为 `123456`，发送冷却和配额仍由真实服务及数据库执行，不发送真实短信。测试配置也关闭日常云端扫描任务，不连接生产桶。

编写场景时复用 [e2e-browser.ts](../../../tests/support/e2e-browser.ts)：

- `page` 夹具记录未捕获异常和同源 5xx。`ready()` 核对 hydration 和主动关闭遮罩均早于 15 秒兜底时刻，并在浏览器内观察遮罩节点，确认检查开始后 2 秒内已移除。
- `login()` 等登录弹窗入场结束，再正常输入，检查失焦后字段值和认证响应；不绕过真实登录。
- `content_query()` 只为 GET 的连接重置重试一次，HTTP 错误仍失败；mutation 不自动网络重试。
- 跨浏览器使用独立 context；headless 标签页的 focus 不代表 hidden，用现有 visibility 边界模拟隐藏。网络失败用实际请求阻断或提交后丢包验证。

收尾时依次停止本轮 broker 和应用进程树、保存服务日志、删除 `runtime.json`、删除本轮创建的随机库、关闭数据库管理连接。某一步失败后仍尝试后续步骤，最后一起报告启动及清理过程中遇到的错误。若清理报错或进程被强制结束，先按日志核对本轮容器、进程、库名，再处理残留；不按通用前缀批量清理。

| 产物 | 位置与用途 |
| --- | --- |
| 应用构建、启动日志 | `.dev/e2e/<run>/server.log`；先查构建失败、端口冲突和应用就绪失败 |
| 默认 E2E | `.dev/playwright/results[-shard-i]/`；CI 的 HTML 报告在 `report[-shard-i]/` |
| 生产 CSS | `.dev/css-production/`；实际构建目标和资产清单另在 `.dev/e2e/<run>/css-build.json` |
| 临时运行配置 | `runtime.json` 含本轮连接与密钥，正常结束会删除；不上传、不粘贴到报告 |

CI 失败时只上传明确列出的日志、trace、截图及报告。默认 E2E 禁用 legacy 构建，并复用本机依赖；通过不代表生产镜像依赖、云服务或原生文件权限已验收。

## CSS 与历史浏览器

以下 profile 按各自用途选择，不把结果相互替代：

| 配置 | 覆盖范围 | 产物目录 |
| --- | --- | --- |
| [css-production.config.ts](../../../tests/css-production.config.ts) | 现代 Chromium 中的生产编译、SSR 与 hydration、延迟 CSS、浮层、编辑布局和媒体；独立应用及测试库 | `.dev/css-production/` |
| [css.config.ts](../../../tests/css.config.ts) | 真实 PrimeVue／CodeMirror 的 CSS API、Teleport、主题及压缩对照；无需应用和数据库 | `.dev/css-official-apis/` |
| [css-legacy.config.ts](../../../tests/css-legacy.config.ts) | Chromium 80、Firefox 78 的原生页面操作，以及同一生产构建的现代 Chromium 对照 | `.dev/css-legacy/` |
| [css-legacy-utilities.config.ts](../../../tests/css-legacy-utilities.config.ts) | 两个历史引擎的暗色工具类及压缩结果；无需应用和数据库 | `.dev/css-legacy-utilities/` |
| [cloud-drafts-production.config.ts](../../../tests/cloud-drafts-production.config.ts) | 增加生产编译下的草稿、引用和 SSR 场景，并复用历史引擎场景 | `.dev/cloud-drafts-production/` |

最后一项用 `pnpm exec playwright test --config tests/cloud-drafts-production.config.ts`。生产编译只改变构建子进程的 `NODE_ENV`，`BROWSERSLIST_ENV=production`；运行配置、数据库和供应商替身仍是开发隔离环境。启动器从 Vite 实际解析结果记录目标、压缩、分块和插件，并检查生成的 CSS 与 legacy JS。

默认 E2E 不收集 CSS 用例及三个生产布局文件；生产 CSS 与独立 CSS 分别由其配置收集，[profile 选择测试](../../../scripts/testing/browser-profiles.test.ts) 保护这三组的分工。完整草稿流程仍由业务 E2E 负责，额外生产 profile 按专项需要运行。

历史 profile 需要预先准备 Windows 二进制，不在运行时自动安装，放在 `.dev/tools/legacy-browsers/` 下：

| 引擎／驱动 | 官方来源 | 本机路径 |
| --- | --- | --- |
| Chromium 80.0.3987.0（revision 722234） | [Chromium snapshot](https://storage.googleapis.com/chromium-browser-snapshots/Win_x64/722234/chrome-win.zip) | `chromium/chrome-win/chrome.exe` |
| ChromeDriver 80.0.3987.106 | [ChromeDriver archive](https://chromedriver.storage.googleapis.com/80.0.3987.106/chromedriver_win32.zip) | `chromedriver/chromedriver.exe` |
| Firefox 78.0 ESR | [Mozilla release archive](https://archive.mozilla.org/pub/firefox/releases/78.0esr/win64/en-US/) | `firefox/core/firefox.exe` |
| geckodriver 0.30.0 | [GitHub release](https://github.com/mozilla/geckodriver/releases/tag/v0.30.0) | `geckodriver/geckodriver.exe` |

Chromium zip 的 MD5 应与 Google 存储响应的 `x-goog-hash` 一致（`a1019dc80d35107b7bf4337c55718775`）；Firefox 安装包按 [SHA512SUMS](https://archive.mozilla.org/pub/firefox/releases/78.0esr/SHA512SUMS) 核对。Chromium snapshot 是真实的历史引擎，但不是正式 Chrome／Edge 80 发行包。2026-10-29 的逐轮结果原文在 git tag `docs-legacy-final` 的 `docs-legacy/reviews/css-legacy-engines-2026-10-29.md`。

[历史 HTTPS 代理](../../../tests/support/legacy-https.ts) 只监听回环，临时证书驻留内存，信任例外只属于 WebDriver 会话，不修改产品 Secure cookie 或安装系统证书。[驱动辅助](../../../tests/support/legacy-webdriver.ts) 对表单及 CodeMirror 逐字符发送原生输入，提交前核对真实字段；不因旧引擎失败而缩短正文、强制编辑或提高现代首屏时限。

Segmenter 与 `/v` 正则兼容由真实诊断入口和构建产物回归保护，见 [browser-regexp.test.ts](../../../scripts/verify/browser-regexp.test.ts)。CSS API 探针可运行 `pnpm exec tsx scripts/verify/css-cascade-feasibility.ts`；它只诊断依赖的样式接口，不代表完整页面或旧引擎验收。

## 专项数据库与迁移演练

这些脚本在本机开发 MySQL 创建、写入并删除随机 QA 库，需要开发 MySQL root 凭据。它们检查 development 与回环地址。在仓库根目录执行，进程环境变量优先于 `.env.dev`。

```powershell
$env:NODE_ENV = 'development'
pnpm exec tsx --tsconfig scripts/tsconfig.json scripts/verify/migration-runtime.ts
```

其他脚本使用相同的 `pnpm exec tsx --tsconfig scripts/tsconfig.json scripts/verify/<文件>` 形式，按改动选择：

| 文件 | 验证内容与额外影响 |
| --- | --- |
| [migration-runtime.ts](../../../scripts/verify/migration-runtime.ts) | 维护门禁、检查点、连接丢失、双执行者、部分 SQL 恢复、空库 WebP 结构、基线后失败续跑和独立生产包。会构建临时验证产物 |
| [deployment.ts](../../../scripts/verify/deployment.ts) | 用当前基线及模拟的历史回执和数据搭建升级夹具，验证回执门禁、基线登记、权限转换、既有正文和草稿保留、维护准入、过期审批与回退条件。只接受 `127.0.0.1`，会重建 `.output/server/maintenance/` 工具 |
| [cloud-drafts.ts](../../../scripts/verify/cloud-drafts.ts) | 草稿协议、并发与引用；`--mqtt` 增加临时 broker，`--capacity` 增加有界负载测量 |

一次性 Content／WebP 转换的独立验证脚本（`content-migration.ts`、`webp-migration.ts`、`reference-history.ts`）已随基线退役。存量引用批次转换、WebP 对象转换及其中断恢复仍用保留这些脚本的历史版本验证。入口与证据在 git tag `docs-legacy-final` 的 `docs-legacy/operations/migrations.md`。

草稿专项可执行 `pnpm exec tsx --tsconfig scripts/tsconfig.json scripts/verify/cloud-drafts.ts --mqtt --capacity`。其负载夹具测数据库与任务并行，云端处理采用可注入边界，不能当真实 OSS 转换耗时；单独运行，避免构建争用污染结果。合成数据演练也不代替生产副本的兼容性验证。

## MQTT 镜像与 CI 汇总

生产 MQTT 镜像验证由 [emqx.integration.test.ts](../../../scripts/deploy/emqx.integration.test.ts) 提供，检查凭据初始化、未授权流量拒绝和重启后用户保留。未设置 `STUPIG_EMQX_IMAGE` 时会跳过，普通 tools 测试通过不说明已验证镜像。

在 PowerShell 构建验证镜像并运行：

```powershell
docker build --target mqtt -t stupig-mqtt-ci:local .
$env:STUPIG_EMQX_IMAGE = 'stupig-mqtt-ci:local'
pnpm exec vitest run --project tools scripts/deploy/emqx.integration.test.ts
```

测试创建独立 Compose 项目、随机回环端口和卷，结束时清理本项目容器及卷。它不验生产公网反代和 WSS。

[Check](../../../.github/workflows/check.yml) 的 `unit` 运行 `pnpm check`，另有 MQTT、三片业务浏览器、独立 CSS 和迁移 job。`check` 始终汇总，拒绝失败、取消及代码检查的意外跳过；纯文档分类成功或符合条件的 main 复用可以跳过重型检查。

复用要求成功 PR 的完整检查及 Git tree 与 main 一致；证明记录为 `check` 内的 `verified-tree-<tree>` 步骤，不是另一个 job。记录不全、代码树不同、验证规则变化或查询失败时完整重跑，具体见 [reuse-pr-checks.mjs](../../../scripts/ci/reuse-pr-checks.mjs)。CI 的迁移 job 使用自己的数据库；其中 `migrate:prod` 表示生产配置模式，不连接现网生产库。

PR 的跳过条件放在 job 上；给 `on.pull_request` 加路径过滤会使被跳过的必需检查停在 Pending。GitHub 的路径过滤只检查前 3,000 个变更文件，超大推送应拆分，避免漏掉范围之外的代码文件，见 [GitHub 工作流触发说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#git-diff-comparisons)。

## 真实云端与系统验收

在对应功能、配置或供应商边界改变时补验相关场景。先确定本次允许操作的环境、账号和数据；新建的数据记录精确身份，清理时核对 key／version，不按公共前缀擦除。

| 范围 | 需要实际确认的结果 |
| --- | --- |
| 编辑器与文件 | 全屏、窄屏、输入与预览、粘贴拖入；原生句柄撤权后重选、刷新恢复，系统权限弹窗由操作者处理 |
| 上传与图片 | 多选目录、权限继承、重名处理、暂停继续、取消替换；静态转换、GIF/SVG、加载失败、覆盖／另存及删减版 |
| 账号与授权 | 受控号码短信、正确／错误／过期验证码、图形验证；匿名、普通用户和机密权限用户分别验证，测试账号不发送真实短信 |
| OSS／ESA 读取 | 合法 GET/HEAD/Range、完整大小与 SHA-256；缺失／篡改 grant、冷回源与 HIT 后撤权、回调故障拒绝交付 |
| 实时同步 | 两个标签页、独立浏览器、登录退出、断网恢复、公开／私有 WSS 的订阅与发布权限、通知最终一致性 |
| 后台生命周期 | 发布后预热、替换／删除后对象退役及 ESA 刷新、runner 停止与恢复 |
| 真实发布产物 | 镜像实际 SSR、CSS/JS、懒加载和缓存；与本次代码、构建及配置身份对应 |

隧道空请求 403、单次 HEAD、进程 running 或缓存 HIT 各只覆盖局部路径。生产入口与配置准备见 [SID#1.0.AGENT-DESIGN](../0_setup/AGENT-DESIGN.md)，部署和维护操作各按所属流程；历史暂停或接受的范围见 [AGENT](AGENT.md#已知边界与既有决定)。

## 验收记录

PR 的 `Verification` 或任务报告写明代码／构建身份、环境与浏览器、具体命令、结果、真实服务或替身范围、失败及未执行部分、清理结果。需要证据时保存脱敏日志、trace、截图和产物摘要；不提交临时密钥、完整签名 URL 或测试运行配置。

测试通过数不跨不同构建、不同 profile 或定向补跑相加。一轮结果不自动变成长期能力声明；长期边界和后续事项记入所属 AGENT，领域运行规则继续由其 DESIGN／AGENT-DESIGN 维护。
