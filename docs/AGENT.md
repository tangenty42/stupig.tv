# AGENT：Swordoc 文档迁移与编写进度

- 本文档状态：PENDING（工程入口、工作流程、总体文档和领域文档都已写完，旧资料已承接并删除；剩下的是下文待办和各目录的浏览器验收）
- 覆盖范围：`docs/` 的编写进度、旧资料归档及新旧文档的衔接
- 旧文档：`docs-legacy/` 已于 2026-11-19 删除；本文提到的旧手册、旧台账以及“留在原文”的内容，原文都在 git tag `docs-legacy-final`
- 工作流程核对基线：2026-11-11 00:15:00 +08:00（Asia/Shanghai）起；提交 `722c1cd3392cb4cdb5c8b051f3354c8e3905e355` 及本轮未提交工作区
- 工作流程文档收尾：2026-11-11 00:41:16 +08:00（Asia/Shanghai）起；仅清理已承接内容与引用，源码基线不变
- 总体架构草稿收尾：2026-11-11 11:53:57 +08:00（Asia/Shanghai）起；核对现行 LAW／DESIGN，承接补充与历史记录后清理十份 TMP，源码基线不变
- 工程指令与初配收尾：2026-11-11 20:55:43 +08:00（Asia/Shanghai）起；统一根目录入口，迁移工程规则、初配资料及旧源码导航
- 其他主题原基线：2026-11-05 14:49:53 +08:00（Asia/Shanghai）；提交 `67f8dad0a15c76acdb079c1334b143fcc146b935` 及当时工作区

工作流程核对覆盖宪章、流程文档、入口引用与对应源码；总体架构收尾核对草稿去向及必要的补充实现。两轮均未连接生产设施。历史实现与测试结论保留各自基线，前端重构及后续目录整理的分批记录见 [SID#0.1.AGENT](0_overall/1_architecture/AGENT.md)。

归档完整性沿用 2026-11-03 的记录，未重新执行完整的业务实现调查或生产验收。基线时间表示相应范围的核对时间，不是原归档时间或历史业务调查时间。

## 引经据典

- [SID#README](README.md)：人类编写的 Swordoc 机制与传统，定义目录、权威边界和五种文档类型；权威文档引用非权威文档时，双方文档头须注明。
- [SID#0.0.LAW](0_overall/0_background/LAW.md)：项目背景与成员权限边界，状态 DONE；2026-11-19 人类补上了 `SID#2.4.LAW` 的引用。
- [SID#0.1.LAW](0_overall/1_architecture/LAW.md)：六个功能板块、功能关系图与板块交界，状态 DONE；2026-11-19 人类在板块表填入 `SID#2.0` 至 `SID#2.5`。
- [SID#0.1.DESIGN](0_overall/1_architecture/DESIGN.md)：状态 DONE；已覆盖基础设施、配置、依赖、代码结构、前端状态、前后端协作、数据更新、SSR 与水合、后台任务。2026-11-19 人类删除了注释中的“用户身份”草稿（内容已由 `SID#2.1.AGENT-DESIGN` 承接），前端状态表的用户身份改指 `SID#2.1`。
- 人类先前要求归档旧资料，随后明确将总体架构与领域业务细节分开，并继续将运行与维护设施合并为一个板块。
- 人类要求将总体 DESIGN 草案中的领域实现与工程流程细节下放，随后将授权回调的环境差异独立成图，采用简洁的 flowchart 表达。
- [SID#1.DESIGN](1_workflows/DESIGN.md)：工作流程总览及五个阶段的 DESIGN 均已标为 DONE，各阶段的 AGENT-DESIGN 保存操作，AGENT 保存记录及旧章节去向。
- `SID#README` 定义带 `SID#` 前缀的标识和固定文档头；正文按主题组织。本文件继续记录精确到秒、带时区的核对基线。

## 目前实现

| 引经据典 | 实现产物 | 现状 |
| --- | --- | --- |
| `SID#README` 的三个固定顶层分区 | `0_overall/`、`1_workflows/`、`2_domains/` | overall 已有背景和架构权威文档，架构补充与历史记录已收拢；domains 各目录已有 LAW 和配套文档；workflows 已有总览及五个子流程的 DESIGN |
| `SID#README` 的人类权威文档分工 | 宪章、overall 的 LAW／DESIGN、workflows 的 DESIGN、[SID#2.1.LAW](2_domains/1_accounts/LAW.md)、[SID#2.2.LAW](2_domains/2_pages/LAW.md)、[SID#2.3.LAW](2_domains/3_admin/LAW.md) | 权威文档均由人类维护；2026-11-19 起各领域目录都有人类写的 LAW（运行维护设施按人类答复不设），进度见 [SID#2.AGENT](2_domains/AGENT.md#进度)。初次配置与维护的 DESIGN 明确引用各自的 AGENT-DESIGN，双方文档头记录引用关系与范围 |
| `SID#README` 的标识规则与固定文档头 | 本文件及各主题文档 | 使用 `SID#` 标识；调查材料保留原基线。旧 TMP 的历史数量不作为当前目录清单 |
| 已完成的工作流程编写 | [初配](1_workflows/0_setup/AGENT.md)、[开发](1_workflows/1_develop/AGENT.md)、[测试](1_workflows/2_test/AGENT.md)、[交付](1_workflows/3_deliver/AGENT.md)、[维护](1_workflows/4_maintain/AGENT.md) | 五个阶段均有操作补充与记录。六份流程 TMP 已退役，根流程迁移索引的独有基线及验证记录归入本文后删除 |
| 人类关于总体与领域分工的要求 | [SID#0.1.AGENT-DESIGN](0_overall/1_architecture/AGENT-DESIGN.md)、[草稿去向](0_overall/1_architecture/AGENT.md#草稿去向) | 总体草稿的主要正文已被 LAW／DESIGN 覆盖；剩余有效实现补充收进 AGENT-DESIGN，候选规则与历史记录收进 AGENT，十份 TMP 已退役 |
| `SID#0.1.DESIGN` 及人类关于链路对照的要求 | `SID#0.1.DESIGN`、`SID#0.1.AGENT` | DESIGN 已采用普通 flowchart 对照图，包含 FRP 反代、隧道与本机专用代理；主图包含 WebSocket 经反代转发。block-beta 试排经验保存在 AGENT，重复图稿已删除 |
| 人类关于总体与领域分工的要求 | [SID#2](2_domains/AGENT.md)各领域目录、[工作流程](1_workflows/DESIGN.md) | 业务与领域实现由各领域目录承接，工程流程由各阶段补充文档维护。两份领域调查材料 `TMP-DOMAIN-NOTES.md`、`TMP-IMPLEMENTATION-NOTES.md` 已按人类 2026-11-19 的决定删除；领域文档按人类要求没有参考它们，全部以源码为准 |
| `SID#0.1.LAW` 的六板块划分及弹窗归属 | `SID#0.1.AGENT`、[SID#2.0](2_domains/0_framework/AGENT-DESIGN.md)、[SID#2.1](2_domains/1_accounts/AGENT-DESIGN.md) | 七板块旧图已退役；公共框架只提供入口，登录注册弹窗的界面、业务逻辑和状态管理归账号与权限 |
| 人类的归档要求 | git tag `docs-legacy-final`（提交 `20a5ce5`） | 2026-11-03 确认原 `docs/` 的 55 个文件均已归档到 `docs-legacy/`，另有归档索引，共 56 个文件。2026-11-19 各领域承接完毕后，按人类决定删除该目录；删除前打了 tag，56 个文件的原文都在其中 |
| 人类要求工程规则全部迁入 Swordoc、工具入口只留指引 | [统一指引](../AGENTS.md)、[全项目约定](0_overall/AGENT-DESIGN.md)、[架构补充](0_overall/1_architecture/AGENT-DESIGN.md) | 根 AGENTS.md 集中提供指引，CLAUDE 和 Copilot 入口指向它，按路径入口保留 glob 及阅读链接，规则正文按下表归属维护 |
| 人类批准的前端业务模块重构 | [SID#0.1.AGENT](0_overall/1_architecture/AGENT.md) | 三阶段重构的验收、SSR 401 修正及独立补验已承接；后续 Content 整理逐批保留实际验证范围。最后一次组件目录整理的沙箱外完整 check 确认尚无记录，不沿用前批通过结论 |
| 归档过程中的链接核对 | 旧 OSS 对账、故障排查手册到云端台账的链接 | 2026-11-03 记录的两处历史锚点已在本轮改为现存的带日期发布记录；历史验收范围保持不变 |

## 待办

[近期需求清单](TMP-NOW.md) 集中记录本轮待处理的编辑与附件问题、Markdown 与界面调整、运维和工程维护事项

| 事项 | 引经据典 | 现状 | 怎么办 | 完成条件 |
| --- | --- | --- | --- | --- |
| 展开各领域文档 | `SID#README`、`SID#0.1.LAW` 及人类的分工要求 | 2026-11-12 14:37:08 +08:00 起：目录方案和三类文档的写法已定；人类已写账号与权限的 LAW，配套 AGENT-DESIGN、AGENT 已按它更新，代码也已按它调整但尚未在浏览器和真实数据库上验证；2026-11-12 18:42:51 +08:00 起人类已写平凡页面的 LAW，配套 AGENT-DESIGN、AGENT 已对齐，待定事项都已答复，验收测试已补并通过；2026-11-12 20:58:27 +08:00 起人类已写管理控制台的 LAW，两项待定都已答复，配套 AGENT-DESIGN、AGENT 已对齐；后台任务与存储审计视图获准做进控制台，2026-11-12 22:49:36 +08:00 起已按人类确认的方案实现并通过单元和组件测试，浏览器测试已写但没跑过；2026-11-19 起其余目录的 LAW 也已由人类写完，配套 AGENT-DESIGN、AGENT 都已写。详见 [SID#2.AGENT](2_domains/AGENT.md) | 机密命名、测试清理和源码线索核对已完成，详见[领域验证记录](2_domains/AGENT.md#落实与验证)。各领域仍列有浏览器、隔离库和生产验收 | 各主题按适用范围明确业务、状态、操作、入口及验收；总体 LAW 不重复领域细节 |
| 承接领域的旧资料 | `SID#0.1.LAW`、领域调查材料 | 2026-11-19 完成：`docs-legacy/modules/` 12 份手册逐章核对，仍成立的写进各领域 AGENT-DESIGN，去向记在各领域 AGENT；仍有效的运维合同（迁移明细表退出条件、首个管理员、旧浏览器夹具）迁入工作流程文档；其余带日期的证据只留在 tag `docs-legacy-final` | — | — |
| 完善并核定总体 DESIGN | `SID#README` 的 DESIGN 分工、`SID#0.1.AGENT` | 2026-11-19 已核对：领域引用已回填，用户身份注释稿已删除，依赖段已改为现行流程和领域入口，状态 DONE | — | — |
| 回填总体 LAW 的文档引用 | `SID#0.0.LAW`、`SID#0.1.LAW` 中的 TODO | 2026-11-19 完成：两份 LAW 的 TODO 都已处理，状态 DONE | — | — |
| 整理领域记录 | `SID#README` 的 AGENT 分工 | 2026-11-19 完成：各领域目录都有 AGENT；两份领域调查 TMP 已删除，`docs-legacy/` 已删除并存入 tag `docs-legacy-final` | — | — |

## 工程规则迁移对照

用户决定将工程规则全部迁入 Swordoc，根 `AGENTS.md` 集中提供阅读导航，`CLAUDE.md`、`.github/copilot-instructions.md` 及按路径加载的文件只保留阅读指引。旧 `TMP-CONVENTIONS.md` 的机制提案已由现行宪章和本次迁移结果承接，文件退役。

| 原来源及章节 | 当前归属 |
| --- | --- |
| copilot Entry points、授权／工作区／作者原话／提问、Protected author content | [全项目协作与保护规则](0_overall/AGENT-DESIGN.md)；文档权威性按 SID#README |
| copilot Workflow and runtime 的 pnpm／ESM、运行环境核对、开发与构建 | [开发与配置约定](1_workflows/1_develop/AGENT-DESIGN.md#开发与配置约定)及开发 DESIGN |
| copilot Configuration and secrets | 总体 DESIGN 的配置系统、[开发配置](1_workflows/1_develop/AGENT-DESIGN.md#配置实际从哪里来)、架构补充的共享边界 |
| copilot Data integrity and synchronization | [迁移编写与冻结](1_workflows/1_develop/AGENT-DESIGN.md#编写数据库迁移)、[迁移恢复](1_workflows/4_maintain/AGENT-DESIGN.md#迁移查询与失败恢复)、总体 DESIGN 的数据更新和后台任务、架构补充的 DB／档案接线 |
| copilot Testing、backend/frontend Verification | [测试编写](1_workflows/2_test/AGENT-DESIGN.md#编写与定向运行)，保留按风险选测、真实入口、回归检出和实际验证范围 |
| copilot Development test accounts | 开发 DESIGN 的账号表、开发补充中的账号复用和运行中 OTP 开关核对 |
| copilot Git and review | 开发 DESIGN 及[完整 PR／squash 补充](1_workflows/1_develop/AGENT-DESIGN.md#pr-与合并后的补充) |
| code-style Enforced syntax、Reuse and configuration、Comments and prose、Protected content markers | 全项目约定保留格式、复用、作者原文及标记语法和原示例，架构和配置内容引用所属文档 |
| code-style Verification | [格式工具](0_overall/AGENT-DESIGN.md#格式与代码复用)、测试补充的验证选择 |
| frontend Components and presentation | [前端组件与样式](0_overall/1_architecture/AGENT-DESIGN.md#前端组件与样式)，保留 UI 复用、表单、KeepAlive、token 与旧浏览器 CSS 限制 |
| frontend APIs, ownership and injection、Synchronization and hydration | 总体 DESIGN 及架构补充的前端接线、查询水合、账号档案接线。旧 proxy 描述按现行 QueryClient 实现更新 |
| backend Boundaries and types、Authorization and data | 总体 DESIGN 及[后端入口与类型](0_overall/1_architecture/AGENT-DESIGN.md#后端入口与类型)、账号档案接线、数据库和共享契约 |
| migrations 版本链／摘要／只读 plan/verify／原子 checkpoint／TS 生命周期 | 开发补充的迁移编写与 TS 生命周期管理，含历史 dump 基线注释不可变 |
| migrations 唯一账本／历史接管边界／SQL 部分执行／摘要修复／备份和 down 边界 | 维护补充的迁移查询与失败恢复 |
| migrations 专用表退出合同、消费者与冻结历史保留 | 开发补充的新增表约定、[明细归档与退役](1_workflows/4_maintain/AGENT-DESIGN.md#迁移明细归档与退役)，现存各表的具体退出条件也在后者 |

## 流程草稿与索引退役记录

原工程调查基线为 2026-11-03、提交 `67f8dad0a15c76acdb079c1334b143fcc146b935` 加当时工作区。原 `TMP-ENGINEERING-NOTES.md` 的环境、进程、生产编排由 1.0／1.1／1.3 承接，迁移与健康检查由 1.1／1.4 承接，Check 和专项验证由 1.2／1.3 承接。Redis 无业务读写的观察保留在总体架构和 [SID#2.AGENT](2_domains/AGENT.md#写档案板块时要核对的线索)，沿用原调查基线。

流程总览及 1.1～1.4 的五份 `TMP-DESIGN.md`、工程调查共六份 TMP 已在前轮删除。14 份旧手册的重复操作改指所属流程，原章节标题保留作兼容入口。Content 切换、具体退役合同、通知与扫描机制归领域，云端台账、恢复演练、CSS 报告及盘点摘要继续作为带日期的原始证据。命令与脚本职责清单仍保留其导航和可选实现建议。

2026-11-11 00:15:00 +08:00 起的迁入阶段验证通过 `pnpm lint`、`git diff --check`，当时 53 份 Markdown 的 790 个本地链接、95 个锚点及具体 pnpm 入口检查通过。2026-11-11 00:41:16 +08:00 起的收尾验证通过同两项检查，47 份 Markdown 的 853 个本地链接、228 个锚点及 17 个 pnpm 入口有效。六份流程 TMP 已删除，10 份权威文档摘要与当轮收尾前一致，根 README 两段保护内容保持不变。记录不扩展为应用、数据库或云端验收。

本轮删除原 `1_workflows/AGENT.md`，该文件的独有基线及两轮验证归入上文，各阶段的具体迁移对照继续保存在对应 AGENT。

本轮初配与源码导航收尾通过 `pnpm lint`、`git diff --check`。全仓 85 份 Markdown 的 1,490 个本地链接、336 个章节锚点检查通过，CLAUDE 的根指引导入目标存在。架构审查报告的 50 个历史源码链接已用本地 Git 对象核对目标文件及行号范围，另外 18 个无法明确对应提交的历史定位保留原路径。根 README 两段保护内容与 HEAD 完全一致。本轮验证覆盖文档与静态来源。

2026-11-19 删除 `docs-legacy/`。工作区里 32 份归档文件有未提交的改动（改指新入口、补了几条历史备注），所以没有直接在 `722c1cd` 上打 tag，而是用 `git commit-tree` 在 `722c1cd` 之上另建一个只含这些改动的提交 `20a5ce5`，tag `docs-legacy-final` 指向它。这个提交不在任何分支上，也没有碰暂存区。仓库内 56 处指向它的链接改成纯文本路径，有文档头的 AGENT 注明原文在 tag 里；仍有效的内容先迁入现行文档再删。

## 落实与验证

2026-11-19 对照总体 LAW 的六个板块与总体 DESIGN 的依赖段，关闭已回填文档的待办。核对了档案八个子目录的承接位置，以及对象退役和存储审计引用的迁移明细。代码、用例及运行结果见[领域验证记录](2_domains/AGENT.md#落实与验证)。

`pnpm check` 本轮通过了 `settings:check`、`lint` 和 `typecheck`。应用和服务端单测 2,136 项中有 2,133 项通过，`server/api/trpc/[trpc].test.ts` 的 3 项因沙箱拒绝本机回环连接而失败；串行命令在此停止。组件测试与独立 CSS 测试另行运行。

全仓用 Markdown 解析器检查了 78 份文档，833 个本地链接、5 张本地图片及 184 个章节锚点均有效。`git diff --check` 通过。

2026-11-21，[账号专项验收](2_domains/1_accounts/AGENT.md#2026-11-21-账号专项验收)已在 Chromium 核对跨设备与跨标签页退出，并在隔离 MySQL 验证四组旧授权数据的迁移结果。

### 2026-11-21 全仓本地复验

`pnpm check` 在修复环境选择测试、浏览器夹具、草稿回执和调整 SSR 预取后全量通过。配置、ESLint 和三套类型检查通过，应用与服务端单测 2,167 项、工具测试 415 项、组件测试 113 项通过。工具组因未指定 `STUPIG_EMQX_IMAGE` 跳过 1 项生产 MQTT 镜像集成测试。此前受回环连接限制的 3 项 tRPC 测试本轮全部通过。

首轮环境选择测试将 15 次真实 Node 启动合计在同一个 5 秒时限内，运行超时。现按命令分别验证，保留原来的环境断言和每项时限。[环境选择测试](../config/lib/environment.test.ts)

默认 Chromium 套件首轮 40 项中 12 项通过、28 项失败。4 项控制台用例全部通过。短信登录用例使用占位手机号，未能通过表单校验，已改用隔离库专用账号。其余失败跨越多个页面，服务器记录了 MySQL 和 MQTT 连接超时，Docker 的容器查询随后也返回 500。该轮还报告了临时消息容器清理失败，已给测试夹具补上某一资源清理失败后继续收尾的回归。[短信登录用例](../tests/e2e/accounts-otp.spec.ts) · [夹具清理测试](../scripts/testing/browser-cleanup.test.ts)

本地服务恢复后，首轮遗留的测试库、临时容器和运行配置已清理。在新建隔离库中单独复跑短信登录，发码冷却、拒绝错误验证码、登录及刷新后的会话均通过，夹具正常退出。

第二轮默认套件 34 项通过、6 项失败。双标签页正常交接时，服务端已确认的正文仍触发恢复区，已修正[草稿回执处理](../app/features/content/draft.store.ts)。删除提示用例已按实际分组核对云端草稿引用，并检查同名档案重建后发布页的链接。另 4 项发生在静态资源迟迟未加载完成期间，其中 3 项超过首屏时限，1 项未完成首页到档案列表的导航。

优化预取后的一轮连续运行通过 36/40 项。剩余 4 项都停在共用建档准备阶段。夹具现会先等到新草稿的正式编辑地址，核对该草稿完整正文及浏览器的自动保存回执，再点击一次创建。租约到期、图片尺寸限制、双浏览器正文同步和重新选择上传文件这 4 项随后在同一新建隔离库中复验全部通过。[共用建档夹具](../tests/support/e2e-browser.ts)

最近一次跑完的默认套件通过 39/40 项，唯一失败的权限页用例在建档时等待首屏遮罩离开 DOM 超时。夹具改为在浏览器内观察实际移除事件，保留原有 2 秒和 15 秒上限。按人类要求停止后续整套运行并清理该轮临时资源，只复跑[权限页用例](../tests/e2e/pages-restricted.spec.ts)，结果为 1/1 通过。本轮本地验收至此收尾。

### PrimeVue 预取实测

2026-11-21，人类确认优化全站 PrimeVue 组件预取。[Nuxt 构建钩子](../config/primevue-prefetch.ts)按已注册组件识别脚本入口。比较了两个真实 SSR 构建，使用相同的本机 Chromium 156 和 1280 × 720 视窗。按原版、优化版、优化版、原版的顺序各跑一轮，每轮独立预热后测 5 个冷缓存浏览器上下文。首页可交互后等 1 秒，点击档案入口，记录列表内容出现的时间。每版合计 10 个样本。

| 指标 | 原版 | 优化版 |
| --- | ---: | ---: |
| 首页 HTML 的 `prefetch` / `modulepreload` | 117 / 46 | 38 / 46 |
| 档案列表 HTML 的 `prefetch` / `modulepreload` | 116 / 51 | 37 / 51 |
| 首页打开至点击前的同源请求数（每次） | 185 | 106 |
| 首页可交互时间，中位数（范围） | 5.06 秒（3.59–6.47） | 4.14 秒（3.72–4.71） |
| 点击档案入口至列表就绪，中位数（范围） | 1.19 秒（0.90–3.54） | 0.31 秒（0.28–0.36） |

两种测量顺序均观察到档案导航提速。首页可交互时间受本机负载影响，第一组原版与优化版中位数分别为 3.96 秒、4.39 秒，交换顺序后分别为 6.06 秒、3.80 秒。

同一生产编译配置的 4 项定向检查全部通过。现代 Chromium 验证了无 JavaScript 首屏样式、水合后的分页、延迟加载的弹窗样式和动画。Chromium 80 与 Firefox 78 分别验证了生产样式和首次打开弹窗。[生产 SSR](../tests/e2e/css-production-ssr.spec.ts) · [延迟样式](../tests/e2e/css-production-overlays.spec.ts) · [旧浏览器](../tests/e2e/css-legacy-browsers.spec.ts)

## 工作经验

查旧资料用 `git show docs-legacy-final:docs-legacy/<路径>`。旧正文里的相对链接和源码行号对应 tag 所在的提交，不对应当前代码。tag 只在本地，推送要另外执行 `git push origin docs-legacy-final`，否则换一台机器就没有了。

更新 AGENT 基线时应同时复核状态内容；现有文档从“尚未建立”变为“正在编写”后，不能仅更换日期而沿用旧记录。历史记录缺少时分秒时不猜补，使用本次实际核对时间，并注明时区。
