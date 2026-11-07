# TMP：Content 工具归属整理计划

- 实施状态：DONE（人类要求除明确暂缓项外全部实施；代码迁移、死代码清理及验收已完成）
- 基线：实施核对时间 2026-11-05 20:55:39 +08:00（Asia/Shanghai）；提交 `67f8dad0a15c76acdb079c1334b143fcc146b935` 及当前未提交工作区
- 覆盖范围：`app/utils/content/` 的职责划分、迁移及直接调用方、测试和夹具的引用更新
- 依据：[SID#README](../../README.md)、[SID#0.1.LAW](LAW.md)、[SID#0.1.DESIGN](DESIGN.md)，以及人类关于将 Content 工具按实际归属继续整理的讨论和编写计划的指令
- 相关记录：[SID#0.1.TMP-GOOD-REFACTOR](TMP-GOOD-REFACTOR.md)、[SID#0.1.AGENT](AGENT.md)、[SID#0.1.TMP-GOOD-DESIGN](TMP-GOOD-DESIGN.md)

## 目标与边界

纠正实际归属错误、拆开混合职责，保持现有行为和依赖方向。上传执行等业务协作跟随 feature，CodeMirror、DOM、画布和交互生命周期跟随组件；纯且跨消费者使用的 Content 渲染、格式化能力可继续保留在 `app/utils/content/`。

当前 `SID#0.1.DESIGN` 规定 `app/features/` 负责业务查询、操作及状态管理，`app/utils/` 不依赖 Vue/Nuxt 上下文且由调用方传入配置和环境能力；尚未明确规定 `app/utils/` 只能保存与业务无关的全站工具。因此，本计划不预设所有 Content 纯函数都必须迁入 feature。若人类以后确认该规则，应先同步权威 DESIGN，再单独核对纯渲染和格式化模块的归属。

本计划是已完成三阶段重构之后的独立整理，按可独立复核的阶段实施、分别验收。前一轮保持收尾状态；本轮已按人类授权完成下述非暂缓范围。

范围包括职责拆分、文件移动、引用更新及必要的回归覆盖。不改变 UI、权限、Markdown 语义、上传及草稿协议，不引入依赖或重组后端。权威 LAW、DESIGN 继续由人类维护。

完成标准是归属清楚、依赖合理、行为验证通过，不要求清空 `utils/content/`。保留的文件应有明确理由，不为目录整齐而新增一套笼统的 `features/content/utils/`。

## 实施结果

### 第一阶段：归属明确的内部实现

- 上传执行实现及测试迁入 `app/features/content/uploads/`；运行时、store 与同步入口改为 feature 内显式引用。
- CodeMirror 的语言、诊断、补全、搜索、主题和视图状态迁入 `app/components/MyContent/Markdown/internal/editor/`；CSS 官方 API 夹具同步改用新入口。
- 图片解码、裁切／导出和涂抹实现迁入 `app/components/MyContent/Attachment/image-editor/`。
- 预览 DOM、轮播、裁切检测和吸顶标题实现迁入 `app/components/MyContent/Markdown/internal/preview/`。

### 第二阶段：附件模型与业务协作

- 工作区投影与 capability 规则、快照接纳、上传完成票据和附件工作区查询分别归入 `app/features/content/attachments/`；Content 资源读取归 `app/features/content/resource.ts`。
- `UploadPreparation` 归上传准入契约；附件模型只依赖上传模块公开类型，没有形成附件与上传运行时循环。
- 页面和组件改用上述明确入口，旧 `app/utils/content/` 路径不保留转发层。

### 第三阶段：混合职责拆分

- `attachment.ts` 只保留可读性、展示地址、媒体分类、图标等纯规则。上传 pick 与文件句柄遍历归 `app/features/content/uploads/picks.ts`；`DataTransfer` 和 webkit entry 读取归 `app/components/MyContent/internal/upload-picks.ts`；链接 DOM 识别与浏览器导航分别归预览及 `MyContent` 内部实现。
- 附件列表投影、批量操作、目录选择、展示数据及 Markdown 拖放协议归 `app/features/content/attachments/`；PrimeVue 菜单、鼠标选择及 `DataTransfer` 编解码归组件内部实现。附件面板通过 `AttachmentPanelInteraction` 接收浏览器打开／保存能力，不反向依赖组件。
- LQIP 样式验证继续作为纯渲染能力保留在 `app/utils/content/lqip.ts`，大小限制由调用方显式传入；图片与 iframe 的 DOM 加载观察迁入 `app/components/MyContent/internal/image-placeholders.ts`。
- 已核实 `draft-reference-bridge.ts` 无生产调用，现行草稿 store 已覆盖其仍有效的代次隔离、引用重放、连续输入保留及旧回调拒绝契约；旧源码及仅验证废弃入口的测试已删除。旧 bridge 的私有 3 秒重试定时器和 `local_revision` 往返语义不再是云草稿协议入口，现行实现改由租约、服务端序号、store owner／generation 和 cycle 恢复约束，因此未机械移植“失败后按 bridge 定时器重试”及“文字撤销回原值”这两类内部实现断言。

### 暂缓及保留结论

- 按人类要求，`app/utils/content/markdown/` 不整体迁移；它继续作为阅读正文与编辑预览共用的纯渲染入口。
- `event.ts`、`alerts.ts`、`html.ts` 和 `story-cover.ts` 不机械换目录。`story-cover.ts` 仅收拢既有封面纯规则并改为显式接收 LQIP 限制。
- 逐项核对剩余 `app/utils/content/` 后，均存在生产调用或作为 Markdown 公共入口的内部依赖；本轮除 bridge 外未发现另一个已确认可删除的生产模块。

## 实施前观察

- `attachment.ts` 同时承担附件访问与展示、上传文件接纳、目录遍历、浏览器下载及封面信息处理，需要按职责拆分。
- `attachment-list.ts` 混合操作判断、列表投影、PrimeVue 菜单对象和鼠标选择；`folder-picker.ts`、`attachment-drag.ts` 与这些类型和操作有关，不能只移动其中一个文件。
- `lqip.ts` 同时生成渲染用的占位样式和观察 DOM 加载状态，分别被 Markdown 渲染器、正文预览及封面组件使用。
- `editor/` 主要被 Markdown 编辑器及其内部实现使用；图片解码、编辑和涂抹工具主要被现有 `Attachment/image-editor/` 使用。
- `markdown/` 提供阅读正文与编辑预览共用的渲染能力，依赖附件展示、封面、提示块和 HTML 规则；应连同这些依赖的归属一起核对。
- `tests/fixtures/css-official-apis/client.ts` 直接引用编辑器语言和主题模块；`server/shared/content-markdown-syntax.ts` 的注释也引用旧工具位置。引用核对不能只搜索 `app/`。
- 当前目录包含 51 个非测试 TypeScript 文件、约 4388 行源码，以及 30 个测试文件、约 3713 行测试；整体搬迁属于大型架构改动，不能作为一次路径清理提交。
- `draft-reference-bridge.ts` 已完成死代码核查：当前生产代码、动态导入及 Nuxt 生成的自动导入表均无调用，仓库内除源码和自身测试外只有本计划及归档文档引用。它曾由编辑页和 `useStoryEditSession` 使用；当前分支的 `924e8d7` 在引入共享云草稿时移除了调用，并将引用重写、代次隔离、pending 状态和编辑器补丁整合进草稿 store。现行实现已迁至 `app/features/content/draft.store.ts`，旧模块属于迁移后遗漏的生产死代码。

以下目标是目录及职责层面的计划；具体文件名在实施时结合现有模块确定，避免同名文件冲突和重复封装。

## 实施前置

当前三阶段重构、文档迁移及其他工作仍共同位于相对 `67f8dad` 的未提交工作区。开始本计划的代码迁移前，应先将已经验收的工作形成独立 Git 提交或等价的可恢复、可比较检查点；随后以新检查点更新本计划基线，避免两轮大型重构混入同一差异。

实际实施时工作区仍含人类既有的大量未提交修改。为避免擅自提交或打包不属于本轮的内容，Agent 未创建 Git 提交；改以精确时间、原提交、路径级引用核对及完整测试结果记录实施边界。这是可比较性上的已知限制，不改变以下行为验收结论。

2026-11-06 00:02 +08:00 经人类授权补建检查点：分支 `refactor/app/feature-ownership` 上，代码迁移（含前一轮三阶段重构与本轮整理，两轮改动重叠于同一批文件，无法还原独立的中间状态）为 `c09f297`，Swordoc 文档迁移与旧手册归档为其后的文档提交。代码提交中的工程指令仍链接迁移前的 `docs/` 路径，文档提交再统一改为 `docs-legacy/`。

每一阶段开始前核对实际调用方、相对导入、类型依赖、受保护内容及目标依赖方向。阶段之间不保留仅用于过渡的长期转发入口；需要临时兼容时，应在当阶段内移除并记录。

## 第一阶段：迁移归属明确的内部实现

| 当前内容 | 建议归属 | 处理重点 |
| --- | --- | --- |
| `browser-upload.ts`、`upload-file-handle.ts`、`upload-timeline.ts`、`image-upload.ts` | `app/features/content/uploads/` | 接入现有上传模块，保留运行时初始化、取消及清理行为 |
| `editor/` 的搜索、主题、补全、诊断、视图状态 | `app/components/MyContent/Markdown/` 邻近内部目录 | 与已有内部实现整合，保留有独立职责的文件和诊断兼容入口 |
| `image-decode.ts`、`image-edit.ts`、`redact.ts` | `app/components/MyContent/Attachment/image-editor/` | 与 session、viewport、dialog 就近维护，保留裁切、涂抹、历史和导出行为 |
| `preview-dom.ts`、`sticky-headings.ts`、`carousel.ts`、`carousel-motion.ts`、`cropped-images.ts` | `app/components/MyContent/Markdown/` 邻近内部目录 | 保留观察器、监听器、动画和 DOM 的生命周期与释放逻辑 |

以上四组分别形成可独立审查的迁移单元，不要求合并为一个提交。每组先保持实现和导出不变，测试随所属模块移动，并更新 mock、夹具和源码注释中的路径。

执行要求：

1. 上传组保持文件校验、断点续传、文件句柄持久化、取消和时间线释放行为；feature 内部显式导入，不增加自动导入入口。
2. 编辑器组保持 CodeMirror 扩展、诊断兼容入口和主题加载顺序；同步更新 CSS 官方 API 夹具。
3. 图片编辑组保持画布、裁切、涂抹、撤销恢复和导出行为；配置读取由所属组件实现管理，不扩大公共入口。
4. 预览 DOM 组保持监听器、观察器、动画和布局清理；`lqip.ts` 暂不整体移动，留待第三阶段拆分。
5. 遇到混合职责或会迫使 feature 反向依赖组件内部实现的文件，停止该文件的机械迁移，转入第三阶段处理。

## 第二阶段：收拢附件 feature 的模型与协作

本阶段只整理已经由附件业务入口使用的模型和协作逻辑，不同时拆 UI 交互或 Markdown 渲染：

- `workspace.ts` 中的工作区行投影、操作 footprint 和 capability 判断归 `app/features/content/attachments/`，与现有查询控制器区分命名。
- `UploadPreparation` 属于上传准入状态，迁入 `app/features/content/uploads/` 的明确类型或入口；附件工作区模型可依赖该公开契约，上传模块不得为取得自身类型反向导入附件内部实现。
- `attachment-snapshot.ts` 作为附件目录快照接纳规则放入不依赖上传模块的附件模型入口；上传 store 可依赖这一低层规则，附件面板再组合上传模块，保持实际文件依赖无环。
- `upload-completion.ts` 仅由附件面板使用，作为面板内部的上传完成票据管理，保留 reset、dispose 及迟到结果失效边界。
- `read-resource.ts` 仅服务 Content 查询，应归 Content feature 的资源读取辅助能力，避免 `app/utils/` 反向依赖 `~/composables/useApi`；如果错误状态读取形成跨领域需求，再将该低层判断提取到中立的传输模块。
- `event.ts` 当前是由页面和组件共同使用的纯格式化能力，默认保留在 `app/utils/content/`，不因名称含有业务概念而机械迁移。

本阶段完成后，页面和组件通过明确的附件业务入口取得状态及操作；组件专用选择、菜单和 DOM 行为仍留待下一阶段，不为隐藏旧耦合而增加 feature 包装。

## 第三阶段：拆分混合文件

### 附件基础能力

拆分 `attachment.ts`：

- 附件可读性、展示地址、删减版选择、媒体类型和打开方式等纯规则形成一个稳定的附件模型入口。若权威 DESIGN 后续明确 `app/utils/` 只容纳与业务无关的工具，则归附件 feature；否则可继续保留为 `app/utils/content/` 下的纯模块。
- `AttachmentUploadPick`、文件和目录接纳归上传模块，供附件面板和编辑器使用。
- DOM 链接识别归预览交互实现；浏览器下载按调用范围归附件交互能力，确有跨业务复用再考虑公共工具。
- 文件图标和共用展示数据保留明确的业务入口，供卡片、Markdown 和编辑器使用；封面地址与替代文本继续与纯封面渲染能力共同核对，不强行并入上传或组件内部。

不要在拆分时复制同一条规则，也不要让渲染器为了取得图标或附件类型而导入上传运行时。

### 附件列表、目录选择和拖放

联合整理 `attachment-list.ts`、`folder-picker.ts`、`attachment-drag.ts` 和 `item-presentation.ts`：

- 业务操作判断、列表摘要投影及 Markdown 引用生成归 feature。
- PrimeVue 菜单对象、鼠标选择和 `DataTransfer` 读写归交互层；共同使用的数据协议和纯规则由明确的业务模块提供。
- 当前附件业务入口也调用选择辅助逻辑。若将该实现迁入组件，应同时调整调用边界，通过事件或必要的回调协作，不能留下 feature 导入组件内部文件的依赖。
- 附件卡片与编辑器补全共同使用的图标、标签等展示数据就近共享，避免两个组件目录彼此引用私有实现。

### 图片占位和封面

将 `lqip.ts` 中的占位样式生成与 DOM 加载观察拆开：前者作为纯渲染能力保留，并由调用方显式传入尺寸限制；后者供组件使用。封面和正文共用的 DOM 处理放在 `MyContent` 下明确的共用内部位置。结合 `story-cover.ts` 核对服务端生成的标记与客户端接管逻辑，保留加载、失败和图片切换时的状态重置。

### 无生产调用的模块

删除已确认不可达的 `draft-reference-bridge.ts`，不将它迁入 feature。其测试只验证废弃入口，原则上随源码删除；删除前逐项与现行 `draft.store.test.ts` 对照：现行测试已覆盖引用重放、发送快照后继续输入、旧页面回调隔离等行为，旧测试中“重写失败后的重试”和“输入后撤销回原文时拒绝旧结果”等场景应按现行云草稿协议判断是否仍是有效契约。确有价值时在草稿 store 的真实入口补行为测试，不照搬旧 bridge 的私有定时器和内部状态断言。

归档文档中对旧 bridge 的引用保留为历史材料，不据此恢复现行调用；新的实现说明不得继续将它列为当前入口。

## 第四阶段：核定剩余纯模块的去留

`markdown/` 默认保留在 `app/utils/content/markdown/`。它是正文阅读与编辑预览共用的纯渲染能力；在附件规则、LQIP 和封面依赖拆清之前，整体迁移只会扩大路径差异，不能改善依赖方向。

只有同时满足以下条件时，才另行迁入 `app/features/content/markdown/`：

1. 人类已在权威 DESIGN 中明确 `app/utils/` 只保存与业务无关的全站工具；
2. 目标模块有清楚的公开渲染入口，而不是笼统的 `features/content/utils/`；
3. 渲染模块不依赖组件、CodeMirror、DOM 观察器或上传运行时；
4. HTML 清理、私密内容、附件链接、源位置映射以及阅读／编辑预览一致性均有现有行为测试保护。

共享语法、权限相关规则和类型继续由现有 `server/shared/` 提供，前端不复制一套。`event.ts`、`alerts.ts`、`html.ts`、`story-cover.ts` 等纯且有多个消费者的模块也默认保留；若其依赖违反公共 utils 边界，应先消除隐式配置或环境读取，而不是仅靠换目录掩盖问题。

逐项核对未列入上述组的文件，记录调用方和保留、迁移或删除理由。名称通用不等于实际通用；搜索不到调用也不直接等于可以删除，应先核实动态使用、测试和历史用途。

## 依赖与生命周期约束

- 页面和组件使用明确的业务入口；feature 不依赖具体组件实例或组件内部实现，确需 UI 能力时接收必要接口。
- 业务内部和组件内部实现显式导入；不新增全局自动导入，不让 TypeScript helper 被识别为 Vue 组件。
- 浏览器对象只在适当运行阶段创建，DOM、文件句柄、编辑器和上传驱动不混入 SSR 序列化状态。
- 保留身份、编辑对象、页面会话及权限变化后的结果接纳检查，不能因迁移丢失取消、重置或释放逻辑。
- 保留在 `app/utils/` 的实现不得调用 composable、依赖 Vue/Nuxt 或 PrimeVue，也不得隐式读取配置及环境能力；所需限制、URL 转换、DOM 根节点或其他能力由调用方显式传入。
- feature 之间通过明确的低层模型或公开入口协作，避免为了移动文件形成附件与上传模块的运行时循环。
- feature 内部仍复用已有配置来源，不扩大浏览器公开配置或复制 `server/shared/` 规则。
- 保留原有注释、作者表达和资产；遇到受保护内容的移动或修改，遵循项目的明确授权要求。

## 验收安排

每个阶段及第一阶段的各独立迁移组均运行相关行为测试；阶段完成时运行 `pnpm lint`、`pnpm exec nuxt typecheck` 和 `git diff --check`。测试迁移保留原断言；只有职责拆分暴露了实际覆盖缺口时才新增测试，不为目录形状单独堆叠测试。

| 范围 | 验收内容 |
| --- | --- |
| 引用与生成清单 | 核对应用、服务端、脚本、配置及测试夹具中的旧路径和动态导入；Nuxt 组件与自动导入声明无内部模块泄漏 |
| 上传与附件 | 文件和目录接纳、暂停恢复、取消、完成回填、快照接纳；身份或会话变化后旧结果不能写入当前状态 |
| Markdown 与编辑器 | 正文和预览一致；搜索替换、补全、诊断及源位置映射保持；HTML 清理和私密附件处理不退化 |
| 图片编辑 | 图片解码、裁切、涂抹、撤销恢复、导出与另存为行为保持 |
| DOM 与布局 | 轮播、吸顶标题、图片加载及失败占位、封面与正文切换，退出后监听器和观察器释放 |
| 兼容入口 | 保留诊断 polyfill 加载顺序；编辑器语言和主题变更同步 CSS 官方 API 夹具，按受影响范围复验生产 CSS 和旧引擎入口 |

涉及浏览器 API、布局和生命周期的部分使用现有浏览器测试入口，不能仅凭单元测试通过验收。沿用隔离测试环境，不以真实供应商调用作为目录迁移的默认验证方式。最终记录实际运行的命令、场景与结果，区分本轮验证和沿用证据。

## 实际验收

| 检查 | 本轮结果 |
| --- | --- |
| 应用单测 | `pnpm exec vitest run --project app`：63 个文件、760 项通过 |
| 组件测试 | `pnpm test:component`：6 个文件、32 项通过 |
| 图片占位浏览器场景 | `content-image-loading.spec.ts`：隔离 Chromium 1 项通过 |
| iframe／轮播浏览器场景 | 生产 CSS 配置下 `content-iframe-carousel.spec.ts`：隔离 Chromium 1 项通过 |
| 静态检查 | `pnpm lint` 通过；`pnpm typecheck` 的 Nuxt、scripts 与 tests 三套检查通过 |
| 路径及生成清单 | 旧路径、动态导入和 bridge 生产引用均无残留；主应用及组件测试的 Nuxt 组件／自动导入声明无内部 TypeScript 模块 |
| 差异格式 | `git diff --check` 通过 |

应用单测使用仓库内 `.dev/tmp/vitest` 作为临时目录，规避沙箱对系统临时目录重命名的权限限制。两项浏览器场景使用项目自带隔离数据库和构建应用，真实 OSS、短信等供应商边界由测试替身代替；首次沙箱运行因本机 MySQL 连接被拒绝，取得本机测试服务权限后重跑通过。Nuxt 报告 `app-settings` 模块初始化较慢，但不影响本轮检查结果。

## 独立复验与改进建议

2026-11-05 21:11:28 +08:00（Asia/Shanghai），针对当前未提交工作区独立复验：通过，未发现本轮新增的阻塞性功能缺陷。总体 DESIGN 已更新目录职责；保留纯 Markdown 渲染及格式化工具符合当前权威边界，不构成漏迁。

- 对迁移前后的顶层函数体和文件实现进行对照：上传驱动、编辑器及预览内部实现主要保持原行为；重点复核了附件选择转入组件、打开／下载接口注入、LQIP 参数传入及其全部调用方。
- 重新运行应用单测 63 文件、760 项，组件测试 6 文件、32 项，`pnpm lint`、`pnpm typecheck`（Nuxt、scripts、tests）和 `git diff --check`，均通过。
- 独立运行 `content-upload`、`content-upload-preparation`、`content-upload-resume`、`content-editor-view-state`、`content-reference-attachments` 五个隔离 Chromium 场景，全部通过，覆盖上传确认、准备期间编辑、续传校验、编辑器布局与滚动恢复、附件目录引用重放及删除影响。
- `pnpm exec playwright test --config tests/css.config.ts` 的 11 项通过，包括编辑器语言／主题和 CSS 官方 API 夹具。此次不重复宣称执行上方两个图片／轮播场景，也未运行完整旧浏览器、真实供应商或生产环境验收。
- 主应用与组件测试各包含 40 个本地 Vue 组件，无遗漏或内部 TypeScript 组件；自动导入声明无 Content feature／组件内部实现泄漏。显式静态运行时导入图未发现环，旧迁移路径搜索无运行引用残留；该图检查不涵盖 Nuxt 隐式自动导入或动态调用关系。
- 浏览器启动器正常结束，测试结果为 passed，本轮临时 runtime.json 已清理。业务代码和权威文档未在复验中修改。

非阻塞改进建议：

1. `useAttachmentPanel` 的打开／保存能力当前默认空实现，`useStoryEditing` 也允许省略。现有生产调用均正确传入，但未来漏传会表现为按钮无反应且无错误。建议后续将能力作为必填 options，或明确提供不含交互操作的数据入口。
2. `Attachment/internal/list-interaction.test.ts` 部分既有测试仍截取 Workspace.vue 中的函数并在 VM 中执行。建议逐步替换为真实组件挂载及事件测试，优先覆盖选择锚点、右键目标、点击外部清空和组件释放；保留独立纯规则测试。
3. AGENT 和总体设计草稿中“权威 DESIGN 仍固定 app/stores”的说法已过期，本轮已更新。下一步是补充状态、身份及 SSR 协作规则，不必重新调整已经同步的目录表。

## 后续核对与待审核改进计划

2026-11-05 22:00:43 +08:00（Asia/Shanghai），按人类要求继续核对当前工作区并整理文档。此次只进行静态实现与测试边界核对，不修改业务代码，不重新运行应用、组件或浏览器测试；上方 21:11:28 的原始建议保留作为历史记录，以下状态修正不得被理解为当时已经验证后续改动。

### 原建议的落实状态

| 原建议 | 当前实现 | 后续结论 |
| --- | --- | --- |
| 将附件打开／保存能力改为必填 | `AttachmentPanelOptions.interaction` 与 `StoryEditingOptions.attachment_interaction` 均已必填且无默认空实现；阅读页和编辑页显式传入同一浏览器导航能力，`editing-entry.test.ts` 已断言对象透传 | 已完成，不再新增运行时兜底、缺失时报错或专门的类型抑制测试。三套 typecheck 负责发现漏传，行为测试只补真实调用缺口 |
| 用真实组件测试覆盖选择、右键、点击外部及卸载 | `Workspace.nuxt.test.ts` 通过真实 SFC、行组件和 PrimeVue 菜单覆盖普通／Ctrl／Shift 选择、右键目标、点击外部清空选择及锚点、身份或行移除后的锚点重置和 document 监听卸载；`internal/list-interaction.test.ts` 只保留独立纯规则 | 已完成，不再重复把这些组合全部搬成 E2E。后续待办改指下方仍真实存在的源码切片测试 |

现有 `panel.test.ts` 已验证下载调用 `save_url`，但尚无直接断言音视频打开调用 `open_url`。这是小型覆盖缺口，不是必填参数尚未落实。后续可补一个短单测：允许打开的音频／视频调用 `open_url(url)` 且不请求下载签名；普通非媒体文件走签名下载及 `save_url`，不调用 `open_url`。

### 剩余测试改造顺序

不再继续迁移已经明确的目录或重写纯规则。目标是让 UI 行为通过真实入口验证，同时保留有价值的算法矩阵和现有浏览器证据。

1. **P1：替换附件重命名／新建目录的 VM 测试。** `attachments/workspace-model.test.ts` 仍截取 `Workspace.vue` 的 `new_folder`、`rename`、`submit_name`。把接线场景迁到真实 `Workspace` 组件测试，覆盖 `.good` 文件只编辑主名但提交完整后缀、文件主名为空白时不提交且弹窗不关闭、带点目录名不误判扩展名，以及新建目录提交正确 `parent_id` 和完整名称。`server/shared/content-markdown.test.ts` 已覆盖扩展名拆分矩阵，不为替换 VM 再把所有名称组合做一遍组件挂载。
2. **P1：拆分附件复制／拖放／编辑器插入的跨组件 VM 测试。** `MyContent/internal/attachment-drag.test.ts` 目前同时截取 `Workspace.vue` 与 `Markdown/Editor.vue`，依赖多个源码位置却没有验证真实 DOM 接线。附件侧用真实组件验证复制菜单写入完整选择，以及 folder／image／file 行拖出相同 Markdown、正确 `drag_ids` 和 `copyMove`；编辑器侧用真实 drop 事件验证 payload 读取、插入位置及内容更新，只读时不插入。现有 DataTransfer 编解码和 Markdown 生成纯测试保留。只有需要证明浏览器原生拖放时才新增 Chromium 场景，不为复制菜单重复建立 E2E。
3. **P1：逐项替换 Markdown `Editor.test.ts` 剩余三项 VM 测试。** 优先通过真实 `Preview` 验证切换公开预览会关闭并清空私密图片灯箱；其次用 deferred promise 驱动真实 drop，证明异步读取文件期间变为只读后不上传、不插入；最后通过真实模式按钮验证编辑、私密预览、公开预览与全屏的组合。`content-editor-view-state.spec.ts` 已覆盖部分全屏、公开预览和恢复行为，可补断言或沿用其证据，避免重复建场景。
4. **P2：继续触碰附件交互时补生命周期中段覆盖。** `Attachment/List.vue` 补框选进行中卸载，随后 pointer／blur 不再改选择且监听释放；`Attachment/Card.vue` 补长按定时器未触发时卸载，随后不打开菜单且文档菜单监听不遗留。它们有实际全局监听器和定时器，比继续拆纯函数更值得测，但不作为未触碰这些代码时的阻塞项。

源码或构建产物本身就是合同的 CI、迁移及产物检查仍可合理使用 VM；本计划不以“消灭所有 VM”为目标，只移除 UI 行为测试对 SFC 字符串切片的依赖。

### 总体 DESIGN 的待核定规则

`SID#0.1.DESIGN` 的目录职责已经同步，下一步不是再次调整目录。人类可从 `SID#0.1.TMP-GOOD-DESIGN` 和 `SID#0.1.TMP-DESIGN` 选择候选正文，至少核定下列共用合同：

| 主题 | 需要写清的规则 | 文档验收重点 |
| --- | --- | --- |
| 状态生命周期 | 查询缓存、共享业务状态、页面会话、DOM／编辑器状态分别由谁持有；身份或对象切换、实例退出时如何重置和释放 | 每类状态有唯一维护者；共享 store 不跟随首个调用组件销毁，局部订阅和交互却会清理；创建、复用、重置、释放及旧结果拒绝条件完整 |
| 用户身份 | cookie／`useAuth` 的身份事实源地位；SSR 请求隔离；401、退出和跨标签页变化的依赖方向 | 不出现第二身份事实源、模块级跨请求身份或 API/auth 循环初始化；规则能链接到身份、传输和同步的实际入口 |
| 数据更新 | 服务端快照、本地编辑、pending 操作和操作回执的区别；通知触发失效，旧异步结果按 owner／generation 拒绝 | 不以页面局部 refetch 替代同步；回执合并、版本判断、身份切换和通知／重连恢复有明确边界 |
| SSR 水合 | 首屏取数一致、payload-backed 状态、序列化范围、浏览器对象启动时机和时间上下文 | 普通 `ref` 不被误写为自动水合；`File`、DOM、编辑器及上传驱动不进入序列化状态；首屏身份视图和时间显示一致 |

文档验收不能只检查章节是否填满：关键规则应链接 owning code，与工程指令及实际行为一致；目标设计和现行实现的差异须显式标记。总体 DESIGN 不膨胀成 Content 文件清单或测试报告，具体业务与测试命令仍归所属领域和 workflows。权威 DESIGN 只能由人类修改和确认，Agent 仅同步 AGENT／TMP 记录。

### 后续验收安排

最小代码批次为补 `open_url` 行为单测、替换附件剩余两处 VM 测试并同步实际验收记录。针对性检查为：

```bash
pnpm exec vitest run --project app app/features/content/attachments/panel.test.ts app/features/content/attachments/workspace-model.test.ts app/components/MyContent/internal/attachment-drag.test.ts
pnpm exec vitest run --config vitest.component.config.ts app/components/MyContent/Attachment/Workspace.nuxt.test.ts
pnpm exec nuxt typecheck
```

新增或修改 Markdown 组件测试时，将其明确加入第二条组件测试命令。完成剩余测试替换后的统一门槛为：

```bash
pnpm check
git diff --check
```

`pnpm check` 已包含生成检查、lint、Nuxt／scripts／tests 三套类型检查及单元、工具、组件测试。测试文件名或范围变化时更新命令，不以未执行的新命令写成通过记录。

涉及相应页面、生产行为或需要更新浏览器证据时，复验已有场景：

```bash
pnpm exec playwright test tests/e2e/content-reference-attachments.spec.ts tests/e2e/content-editor-view-state.spec.ts
```

`content-reference-attachments.spec.ts` 已通过真实页面完成右键重命名和删除确认，不重复新增同一链路。新增原生拖放场景时单独运行对应文件。只改测试不要求重跑 CSS、旧浏览器矩阵或真实云服务；若同时修改编辑器生产代码，则按影响补编辑器及 CSS 场景，并在记录中明确真实 OSS／云交付是否仍未验收。实施记录必须区分本轮实际执行、沿用证据和未执行范围。

### 最小批次实施记录

2026-11-05 22:39–23:10 +08:00（Asia/Shanghai），按人类审核执行最小代码批次；未修改任何生产代码，`Editor.test.ts` 的三项 Markdown VM 测试与权威 DESIGN 仍留在后续批次。

实际变更与验证：

- `panel.test.ts` 新增行为单测：允许打开的音频直接调用 `open_url(url)` 且不请求下载签名；普通非媒体文件走签名下载及 `save_url`，两条路径不混用。目标文件 37 项通过。
- 重命名／新建目录的 VM 用例已从 `workspace-model.test.ts` 删除；接线场景迁入 `Workspace.nuxt.test.ts` 真实组件测试，覆盖 `.good` 文件只编辑主名但提交完整后缀、空主名不提交且弹窗不关闭、带点目录名按目录整体重命名，以及在所选目录下以完整名称新建文件夹。扩展名拆分矩阵继续由 `server/shared/content-markdown.test.ts` 覆盖。
- `attachment-drag.test.ts` 的跨组件 VM 用例已删除，其 payload 编解码与 Markdown 生成纯测试保留。替代覆盖：`Workspace.nuxt.test.ts` 以真实菜单与 dragstart 事件验证复制与四种行拖出写入相同整选 Markdown、`drag_ids`、`copyMove` 及未选中行的独立拖出；新增 `Markdown/Editor.nuxt.test.ts` 以真实 SFC drop 处理器验证附件／文件夹引用插入位置、文件拖放转为 `files-dropped` 事件，以及读取文件期间转为只读后拒绝接纳。CodeMirror、视图持久化和文件句柄适配作为边界被 mock，与项目测试指引一致。
- 实施中发现原有菜单点击辅助函数对 `<li>` 触发 click 不能稳定命中 PrimeVue 4 的实际命令节点，导致部分既有用例在本机连锁失败；改为点击 `.p-contextmenu-item-content` 后全部通过。该修正只影响测试事件目标，不改变被测行为。另将空白文件名场景改为空值断言：真实 `MyFileNameInput` 会把空格清洗为 `_`，原 VM 用例的纯空格输入在真实入口不可达。
- 验证命令与结果：目标应用单测 3 文件 77 项通过；组件测试 2 文件 34 项通过；改动文件 ESLint 通过；`pnpm check` 全量通过——生成检查、lint、Nuxt／scripts／tests 三套 typecheck、应用及服务端单测 157 文件 1975 项、工具测试 402 项（1 项跳过为既有状态）、组件测试 8 文件 66 项——`git diff --check` 通过。`list-interaction.test.ts` 三个遗留未使用导入在 lint 中暴露，已一并清理。

本批次仅修改测试与文档，未重跑浏览器场景及真实云服务验收；`content-reference-attachments` 等既有浏览器证据继续沿用。

### 收尾批次实施记录

2026-11-05 23:16–23:30 +08:00（Asia/Shanghai），按人类审核执行前端测试改造的收尾批次，做到总体 DESIGN 规则核定为止；仍只修改测试与文档，未改生产代码。

- `Editor.nuxt.test.ts` 新增模式绑定测试：通过真实模式按钮（含 `aria-pressed`）与全屏切换验证编辑／私密预览／公开预览的受众共享、全屏隐藏编辑选项及退出后的模式恢复；`preview_audience` 经真实预览组件 stub 的 `public-view` 属性观测。
- 新增 `Preview.nuxt.test.ts`：真实挂载正文渲染，点击图片打开灯箱后切换 `public-view`，断言灯箱关闭并清空图片列表；无图片正文不渲染灯箱。认证 API 客户端（拉起 MQTT 传输配置）作为边界 mock。
- `Editor.test.ts` 三项 VM 测试全部替代后删除文件：只读拖放拒绝（前批次 `Editor.nuxt.test.ts`）、模式绑定与灯箱清理（本批次）。至此 UI 行为测试不再截取 SFC 源码在 VM 中执行；CI 与产物合同类 VM 用例保持不变。
- 新增 `List.nuxt.test.ts`：背景 pointerdown 开始框选并发出 `start`；卸载结束会话发出 `end`，随后的 pointermove／pointerup／blur 不再产生选择事件。
- 新增 `Card.nuxt.test.ts`：长按 600ms 打开菜单的正向对照，以及长按未触发时卸载后不打开菜单；使用假定时器控制长按窗口。
- 事件记录改用 `onMarqueeSelect` 监听器而非 `wrapper.emitted()`：后者在组件卸载后不再可靠，监听器方式与生产事件通路一致。
- 验证命令与结果：四个测试文件目标运行通过（组件配置）；改动文件 ESLint 通过。2026-11-05 23:42 +08:00 复核：`pnpm check` 全量通过——生成检查、lint、Nuxt／scripts／tests 三套 typecheck、应用及服务端单测 156 文件 1972 项、工具测试 402 项（1 项跳过为既有状态）、组件测试 11 文件 72 项；`git diff --check` 通过。删除 `Editor.test.ts` 后单测由 157 文件 1975 项降为 156 文件 1972 项，组件测试相应增至 11 文件 72 项。
- 复核时修正 [TMP-IMPLEMENTATION-NOTES](../../2_domains/TMP-IMPLEMENTATION-NOTES.md) 中仍指向旧路径 `app/utils/content/upload-file-handle.ts` 的失效链接，改为 `app/features/content/uploads/upload-file-handle.ts`；`docs/` 下其余相对链接均有效。

本批次未重跑浏览器场景及真实云服务验收；生产代码零改动。

### 清空 `utils/content/` 批次实施记录

2026-11-06 00:44–01:10 +08:00（Asia/Shanghai）。人类已在 `SID#0.1.DESIGN` 中将 `app/utils/` 核定为「全站通用」工具，上文「暂缓及保留结论」及默认保留 `markdown/`、`event.ts`、附件纯规则的理由随之失效；人类明确要求 `markdown/` 一并迁移。本批次只移动文件和改写导入路径，不改行为。

| 原位置 | 新位置 | 依据 |
| --- | --- | --- |
| `markdown/`（含测试） | `app/components/MyContent/Markdown/internal/render/` | 生产调用方只有 `Markdown/Preview.vue` 与 `Markdown/internal/preview.ts`；阅读与编辑预览均经 `Preview.vue` 共用，迁入组件组不影响共用 |
| `alerts.ts`、`html.ts` | `app/components/MyContent/Markdown/internal/` | 仅 Markdown 渲染器与编辑器使用 |
| `attachment.ts`（含测试） | `app/features/content/attachments/rules.ts` | 附件可读性、受限、展示地址、删减版和打开方式等业务规则；附件 feature、Markdown 渲染与编辑器共用 |
| `event.ts` | `app/features/content/event.ts` | 档案日期格式化规则，与 `stories.ts` 同属档案业务 |
| `story-cover.ts`、`lqip.ts`（含测试） | `app/components/MyContent/internal/` | 只被 MyContent 组件、阅读页及 Markdown 渲染器用于生成封面与占位样式 |

- 依赖方向：组件引用 feature（`rules.ts`、`event.ts`），feature 不引用组件；`lqip.ts` 引用 `attachments/rules.ts` 符合该方向。
- `editor/language.ts` 保持相对导入 `../html`，因为 CSS 官方 API 夹具在不支持 `~` 别名的 tests 类型检查中导入它；`render.test.ts` 读取 `server/shared/content-private.ts` 的相对路径随目录层级更新；`server/shared/content-markdown-syntax.ts` 的注释改指新位置。
- 验证：`pnpm settings:check`、`pnpm lint`、Nuxt／scripts／tests 三套 typecheck 通过；组件测试 11 文件 72 项通过；应用及服务端单测 156 文件中 155 文件、1969 项通过。未通过项全部来自当前沙箱环境：`server/api/trpc/[trpc].test.ts` 3 项依赖本机回环 HTTP，独立的 Node 回环 `fetch` 探测同样 4 秒超时，而 2026-11-05 23:42 同一测试通过；工具测试 5 个文件（`stage-env`、`dev/cli`、`esa/workflow`、`maintenance-build`、`e2e-query`）失败于 `sh` fork 崩溃（`0xC0000005`）、回环连接或容器数据库不可达，且均不导入任何 `app/` 代码。2026-11-06 01:22 +08:00 前，人类在沙箱外对同一未提交工作区执行 `pnpm check`，确认全部通过（结尾为组件测试 11 文件 72 项通过，无 `ELIFECYCLE`），上述沙箱失败项据此确认为环境限制。本批次只移动文件与改写导入，未重跑浏览器场景及真实云服务。

### 组件目录只保留 Vue SFC 批次实施记录

2026-11-06 15:35–16:00 +08:00（Asia/Shanghai）。人类决定 `app/components/` 不再放 `.ts` 实现，放宽 feature 语义，将组件配套逻辑全部归入 `app/features/content/`；组件保持现有平铺的 `.vue` 文件和标签名，不改为同名文件夹。只移动文件与改写导入，不改行为。

| 原位置（`app/components/MyContent/` 下） | 新位置（`app/features/content/` 下） |
| --- | --- |
| `Markdown/internal/`（编辑器、预览 DOM、渲染器、alerts、html 等） | `markdown/`（保留原子目录 `editor/`、`preview/`、`render/`） |
| `Attachment/image-editor/` | `image-editor/` |
| `Attachment/internal/list-interaction.ts` | `attachments/list-interaction.ts` |
| `internal/attachment-drag.ts` | `attachments/drag-transfer.ts` |
| `internal/upload-picks.ts` | `uploads/browser-picks.ts` |
| `internal/browser-navigation.ts`、`image-placeholders.ts`、`lqip.ts`、`story-cover.ts` | 同名文件，直接位于 `features/content/` |

- 共移动 81 个文件、改写 31 个文件的导入；`app/components/` 现在只含 `.vue` 与 `.nuxt.test.ts`，四个 `internal`／`image-editor` 目录已删除。
- `markdown/editor/language.ts` 保持相对导入 `../html`，供不支持 `~` 别名的 CSS 夹具类型检查；`render.test.ts` 的服务端相对路径随层级更新；`nuxt.config.ts` 注释、`frontend.instructions.md` 的组件规则和 `server/shared/content-markdown-syntax.ts` 注释改为新归属；修正 [TMP-IMPLEMENTATION-NOTES](../../2_domains/TMP-IMPLEMENTATION-NOTES.md) 的失效链接。
- 验证：`pnpm lint`、`pnpm typecheck`（Nuxt／scripts／tests）通过；应用单测 62 文件 725 项、组件测试 11 文件 72 项通过。服务端单测与工具测试仅一行注释受影响，因沙箱回环与子进程限制未在沙箱内运行，需人类在沙箱外执行 `pnpm check` 确认。未运行浏览器场景及真实云服务。

## 收尾条件

- 各阶段分别通过验收，剩余问题有明确处理结论。
- 已迁移文件不再保留旧运行入口或无必要的转发层；`utils/content/` 已在清空批次整体删除。
- 业务模块、渲染模块和组件交互之间没有新增循环或反向依赖。
- Markdown 渲染器的保留或迁移结论注明所依据的权威规则，不以目录整齐替代设计决策。
- `draft-reference-bridge.ts` 已删除，仍需保留的行为断言已落在现行草稿 store 的真实入口；其他无生产调用候选也有保留或删除结论及核对依据。
- 更新本计划的实施状态、实际迁移归属和验证结果，并在主题 AGENT 记录后续事项。
- 向人类提供总体 DESIGN 的同步建议，区分已实现结构与仍在讨论的规则；不直接修改权威文档。
