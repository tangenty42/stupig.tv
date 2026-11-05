# 官方主题 API 与 Tailwind 选择器策略验证

更新日期：2026-10-31。当前代码状态：**CSS 兼容改造已随 [PR #46](https://github.com/tangenty42/stupig.tv/pull/46) 合并；Tailwind 关闭全局 selector important，使用官方主题入口与局部 `!`，保留 Segmenter、静态 Unicode 正则及窄屏修复。随后 [PR #48](https://github.com/tangenty42/stupig.tv/pull/48) 已用服务端租约替换 Web Locks，Firefox 78 编辑不再因缺少 Web Locks 而只读。**

Firefox 78 编辑流程的隔离复验见[实施记录](../designs/shared-cloud-draft-implementation-2026-10-30.md)。下文按各轮实际范围保留历史证据，不累加为一次全绿，也不把代码合并当作生产验收；本次整理未读取生产回执。

这是[动态转换公开 API 可行性评估](css-layer-public-api-feasibility-2026-10-29.md)之后采用的路线：通过各库支持的接口定制样式，保留生产 CSS 转换与懒加载。自定义分层插件仍暂停；本路线不提供完整 layer 等价保证。旧浏览器交互与动画等价的要求保留。

本文集中维护当前范围、证据索引和发布门槛；后文的隔离实验及开发接入记录保留其当时范围。

## CSS 独立 PR 范围（2026-10-30）

用户选择本次只提交 CSS / 旧浏览器兼容。候选分支 `fix/css/legacy-browser-compat` 从 main `2f8e623`（含 #45）建立；引用归一化、历史迁移、删除提示和草稿会话改动均留在原工作区。图片渲染只保留尺寸几何与对应净化 / 回归，引用匹配及业务接口沿用 main；云草稿设计另案维护。本候选没有 server / migrations 差异，未改 Web Locks 或本地草稿协议。

拆分后的应用 / 服务测试 1674 项、组件 27 项通过；工具首轮 322 项通过、1 项既有跳过，另有既有 ESA CLI 启动超时，其原样五项定向复验通过。合计 2024 个不同用例已有通过结果，但不称单次 `pnpm test` 全绿。Nuxt、scripts / tests 类型检查、配置生成检查和全仓 lint 通过；独立 CSS 十组通过。拆分时补入轮播生命周期测试的样式边界与监听清理断言，保留作者受保护注释；原工作区 150 个待处理源文件逐字节未变。

生产构建 `c0e74933f3ed4e68b91aee64e58fddb4` 首轮选择 12 项，只有明确延后的 Firefox 78 编辑用例未运行，其源码断言保留。现代七项和 Firefox 样式两项通过；Chromium 80 三项在进入页面前建会话超时。旧浏览器安装通过工作树目录联接复用，测试辅助改为先解析真实安装路径；真实 Chromium 80 会话探针通过，未提高等待时限。随后构建 `2dbf02e4af18456584b686ee191d99c1` 的三项定向复验全部通过，应用源码相同，仅修正测试安装路径；已查看全屏与 500px 窄屏暗色截图。首轮 9 / 12 与定向 3 / 3 分别保留，不能称为单轮 12 / 12。此前 2052 项和完整 11 / 13 等结果属于混合工作区的历史记录，不能代替本候选的复验。

## 当前交付与证据

CSS 独立候选的历史结果如下；其中 Web Locks 只读限制已由后续草稿协议解决，当前剩余范围以文末清单为准。

| 范围 | 当前结果 | 证据 |
| --- | --- | --- |
| 样式入口 | Tailwind `important: false`；PrimeVue preset / dt / PT、CodeMirror 主题与必要的局部 `!`。`stupig-app` 仅保留稳定 body 身份，不参与 utility 加权 | [官方局部权重接入](css-legacy-engines-2026-10-29.md#官方局部权重接入) |
| 生产前端构建 | production Browserslist、四引擎 CSS targets、Lightning CSS、legacy 和 CSS 分块保留 | [生产一致性验收](css-production-parity-2026-10-29.md) |
| 真实旧引擎 | 两引擎管理页控件、媒体、正文、Dialog、动画、ConfirmPopup 通过；Chromium 80 长文档输入、全屏、前景 / 底色主题切换、滚动及窄屏通过，截图确认白底浅字已修复。Firefox 78 因缺少 Web Locks 只读 | [当前接入结果](css-legacy-engines-2026-10-29.md#官方局部权重接入) |
| CSS 独立复验（此前） | 四项历史 CSS / 媒体及六项现代对照 10 / 10 通过；该选择不包含两个历史编辑用例 | [CSS 复验](css-legacy-engines-2026-10-29.md#当前-css-改写的最终复验)，生产构建 `c9131bef6a7247fc89b09f5eef0f56e8` |
| 生产验收 | CSS 独立候选首轮 9 / 12，Chromium 启动路径修正后定向 3 / 3 通过；两轮分别记录。Firefox 78 编辑仍未通过，未运行的失败断言保留 | 构建 `c0e74933f3ed4e68b91aee64e58fddb4` 与 `2dbf02e4af18456584b686ee191d99c1`；此前混合工作区结果留在历史证据中 |
| 暗色工具类门槛 | 当前配置在 Chromium 80 / Firefox 78 的普通及局部 `!` 底色断言通过；首次 Firefox 退出驱动异常后，对应两项复跑通过 | 当前独立入口仅保留应用的四种引擎 / 输出组合，历史加权失败留在评估记录 |
| 配套检查 | CSS 独立候选合计 2024 项已有通过结果、1 项既有跳过，含 ESA CLI 超时后的定向复验；lint、Nuxt、scripts / tests 类型、配置生成检查通过。独立 CSS 十组通过 | 重复候选模式已合入正式应用夹具；旧 2052 项及晚到样式定向结果属于混合工作区的历史计数 |
| 远端 CI / 发布 | PR #46 已合并；源码中的验证入口见 Check，生产交付与缓存 / 回滚结果按发布回执单独核验 | [Check](../../.github/workflows/check.yml)、[发布准备](../deployment/README.md#css-样式变更发布准备) |

浏览器报告和截图是被忽略的本机 `.dev/` 证据，其他检出需按[测试指南](../development/testing.md)重新生成。旧浏览器安装包不进入源码或应用依赖；生产 CSS profile 已加入 CI，历史二进制 profile 仍为本机专用入口。

## 审阅范围

下表按职责列出本路线的改动入口，不表示所列共享文件的所有工作区差异都属于样式任务。工作区同时含 Content / 引用功能等改动，提交前应按文件和 hunk 核对。

| 部分 | 对应文件与职责 |
| --- | --- |
| 构建与主题 | `config/ui-style.ts`、`config/primevue-preset.ts`、`config/browser-targets.ts` 及测试；`nuxt.config.ts`、`tailwind.config.ts`、`primevue-overrides.css`；稳定 body ID、主题 token、JS / CSS targets。`config/browser-transforms.ts` 通过官方 Babel 插件提前编译静态 Unicode 集合正则 |
| DOM 与确认浮层 | `sticky-headings.ts`、`useMarkdownEditorScrollSync.ts`；普通 DOM 选择器列表。`useMyConfirm.ts` 及测试、`utils/confirm-popup.ts` 及测试；公开 PT state / transition DOM 定位，移除内部方法调用 |
| 媒体及主题选择器 | `carousel.ts`、`carousel-motion.ts` 及测试；Preview 的加载几何、mask、间距和 16:9 回退；Markdown 图片尺寸输出与净化；Editor / global.css 普通选择器列表；Tailwind 官方 dark variant 与 Nuxt Icon `cssWherePseudo` 配置 |
| 满幅几何与裁剪 | `app.vue` 测量缺少 overflow clip 时的可用视口，供 Header、MyDivider 和 Preview 共用；水印通过 `@supports` 保留局部 hidden 回退，不把应用根节点改成新的滚动容器 |
| 编辑器标准能力 | `editor/markdownlint.ts` 在诊断依赖初始化前提供标准 Segmenter；`lint-legacy.test.ts` 与 `scripts/verify/browser-regexp.test.ts` 验证真实入口和 modern / legacy 转换产物；`package.json` / 锁文件固定已授权依赖 |
| 自动验证 | `tests/css.config.ts`、`tests/css-production.config.ts`、`tests/css-legacy.config.ts`、`tests/css-legacy-utilities.config.ts`；CSS spec / support / fixture、正式局部权重夹具、六级吸顶回归；`scripts/testing/browser.ts`、`scripts/verify/nuxt-config.test.ts`、`tests/tsconfig.json` 与 Check |
| 可行性诊断 | `scripts/verify/css-cascade-feasibility.ts` 及测试；保留为独立诊断，不接入产品运行时 |
| 文档 | 前端约束、测试 / 命令指南、本文及阶段证据；旧插件设计仅保留提案与暂停原因 |

原有 `Preview.vue` 公共 `z-10` 修复作为前置基线保留；`global.css` 既有图片占位动画、Story Header 除上述满幅几何以外的既有改动，以及 Content / 引用功能等其他差异不合并进上述范围。用户已分别授权并接入 FormatJS 标准 polyfill 与官方 Rollup / Babel 构建依赖，现有依赖版本保持不变。没有安装包 patch、内部模块 alias 或动态 CSS 拦截器。

## 初次隔离验证：输入与执行方式

- [真实浏览器夹具](../../tests/fixtures/css-official-apis/client.ts)挂载 Vue、PrimeVue InputText / Button / Dialog，以及两个真实 CodeMirror 编辑器；Dialog 实际 teleport 到 body。
- [构建辅助](../../tests/support/css-official-apis.ts)加载项目现有 Tailwind 配置及 PrimeUI 插件，编译真实 `global.css`、`primevue-overrides.css`。为使实验有界，content 只扫描夹具及根元素标识；这不是全站 CSS bundle。
- 每种策略分别运行 Tailwind + Autoprefixer 输出，以及随后经 Lightning CSS 转换并压缩的输出。后者从 package.json 的 production Browserslist 解析 Chrome/Edge 80、Firefox 78、Safari 13.1 目标，覆盖全部声明引擎；不等于已经采集或执行 Nuxt 最终生产构建配置。
- 浏览器 JS 由现有 esbuild 对真实依赖打包，目标为 ES2020；库自身动态 CSS 保持原生输出，没有使用依赖 patch、内部包装、原型替换或 CSS 转换 adapter。
- 该轮实际运行环境为 Playwright Chromium **156.0.8078.4**，当时未安装 Playwright Firefox / WebKit。后续另行安装并验证的历史 Chromium / Firefox 见上表；此处保留隔离对照的原始范围。

复现命令：

```powershell
pnpm exec playwright test --config tests/css.config.ts
pnpm exec tsc --project tests/tsconfig.json --noEmit
pnpm lint
```

[独立配置](../../tests/css.config.ts)不启动 Nuxt、数据库或云服务；用例禁止所有网络请求。报告、目标记录、计算样式观测及失败 trace 位于 `.dev/css-official-apis/`。同一[回归文件](../../tests/e2e/css-official-apis.spec.ts)也能由原有 E2E 配置发现，但通过原配置运行时仍会先执行原有应用全局 setup。

## 策略对照结果

四种对照策略各有两种 CSS 输出，另加两组实际应用 preset / 作用域回归，共十组均通过。对照包含不合适策略的负向断言；“测试通过”不表示四种策略都符合接入要求。

| 策略 | 普通工具类覆盖受测组件规则 | 覆盖 body 内 Teleport | 保留受测行内宽度 | 判断 |
| --- | --- | --- | --- | --- |
| 原默认权重（对照） | 不能稳定覆盖受测 PrimeVue / CodeMirror 规则 | 不能覆盖受测浮层规则 | 是 | 保留了可检出的冲突对照 |
| `important: '#__nuxt'` | 根内可以 | 否，浮层不在祖先范围内 | 是 | 不适合作为全应用祖先 |
| `important: '#css-app'`，ID 位于 body | 可以 | 可以 | 是 | 适合继续做应用集成评估 |
| `important: true` | 可以 | 可以 | 否 | 不建议全局启用 |

`#css-app` 是对照夹具标识；实际应用标识为 `#stupig-app`，由共享配置同时提供给 Nuxt 和 Tailwind，另有实际配置回归。祖先 ID 策略使普通工具类在受测组件 class 规则之上，并保留行内样式；全局 important 则将按钮的行内 `123px` 改为工具类 `32px`，Dialog 的 `321px` 改为 `256px`。这是实际计算样式结果，不是只比较 CSS 字符串。

dark（类位于 html）、hover、响应式宽度切换、运行时 PT class 更新，以及将库样式节点移到 head 末尾的晚到场景均已覆盖。普通工具类仍不能覆盖受测的双 ID 规则或 important 声明，因此此策略不能提供完整 layer 等价保证。祖先范围也不包含该根元素自身或其他 ShadowRoot。

## 各库官方接口的观测

**PrimeVue：** preset 将 InputText 圆角设为 `12px`，实例 dt 设为 `24px`；调用 updatePreset 后，全局实例变为 `16px`，局部实例保持 `24px`。PT 对 Button label 的 class/style，以及对 Dialog content 的动态 padding 生效。

最初探针复现了迁移障碍：旧 `html:root` 中的 Button 圆角变量盖过 preset 的 `12px`。当前已将对应变量迁入应用 preset，并把回归改为验证真实应用 CSS 不再遮蔽新 preset。迁移需要逐项撤销已由 preset 接管的旧变量覆盖，不能直接加入新 preset 后假定它已经生效。

**CodeMirror：** 使用项目真实 `theme_extensions()`，通过官方 Compartment 重配置切换深浅色。编辑器文本、gutter 及真实 Markdown 标题高亮均得到预期颜色。两种主题预热后反复切换 20 次，style 节点数与 CSS 规则总数保持不变；这只覆盖固定主题集合，不是任意动态主题的回收保证。

## 初次开发工作区接入与实测

以下保留初次接入时的结果；当时的 body 祖先加权策略已由上文当前配置取代，Nuxt 仍保留稳定 body ID。

- [ui-style.ts](../../config/ui-style.ts)提供共享 body ID 与原有圆角值；[Nuxt](../../nuxt.config.ts)将 ID 输出到 body，[Tailwind](../../tailwind.config.ts)使用同一个 ID 增加普通工具类权重，并扫描其定义文件。
- [primevue-preset.ts](../../config/primevue-preset.ts)按原有数值迁移 Button / Dialog / AutoComplete 圆角、InputText invalid placeholder、Toast blur、分页器背景、DatePicker buttonbar padding、Menu / ContextMenu 阴影及间距、ToggleButton / SelectButton 圆角。[原 CSS](../../app/assets/css/primevue-overrides.css)保留 ConfirmPopup、Slider 专用变量，以及浮层动画和其他未迁移规则；原有作者注释保留。
- 新的实际配置回归挂载对应真实组件，检查浅深色 token、popup Menu 的实际阴影 / padding、body 下 Dialog、PT 更新与行内宽度。Nuxt 配置合同另检查 SSR body ID 接线。
- MCP DevTools 在本地 `http://localhost:3042` 使用项目登记的开发测试账号完成密码登录，检查档案列表和未提交的编辑草稿；没有创建或修改数据库中的档案。
- 登录 Dialog 实际位于 `#__nuxt` 之外，宽度 `448px`、圆角 `6.4px`。编辑器普通 / 全屏切换、深浅色切换均正常；全屏编辑器仍在 body 作用域内，预览 h1–h3 的 z-index 为 `30 / 29 / 28`。
- 另行读取服务端 HTML 确认 SSR body ID 与 hydration 后均为 `stupig-app`。
- 检查桌面及实际 CSS viewport 宽 `500px` 的窄屏，未观察到横向溢出。MCP 请求的更小窗口受浏览器最小尺寸限制，本次不声称完成 `390px` 真机验收。
- 开发进程最初持有失效依赖路径，随后按原 `pnpm dev` 入口重启了已核对的项目 Nuxt 进程及其授权通道。初次依赖预构建时出现过一次编辑页动态导入错误；重新加载后编辑器可用，最终页面控制台无新的 error / warn。首页曾出现开发静态资源的 CORS 报错，该资源链路未在本次样式改动中调整。

CodeMirror 本来就通过 `theme_extensions()` 使用公开主题 API，本次保留其实现；没有为了迁移而复制 CSS 或接管 style-mod。

本轮自动检查：十组 Chromium CSS 回归通过；`pnpm test` 的应用／服务、工具及组件测试合计 2033 项通过、1 项跳过；应用、工具、浏览器测试的 TypeScript 检查及全仓 lint 均通过。没有运行完整 Nuxt 生产构建或全量业务 E2E。

后续已增加[完整生产 CSS 构建验收](css-production-parity-2026-10-29.md)，并将其中发现的分页器选中态问题迁入官方 preset token 修复；上述检查记录是最初开发接入时的范围。

## 发布门槛与剩余工作

生产构建、SSR body 标识、限定 token 迁移、DOM 选择器修复和受测浮层场景已有证据。整理和审阅可以继续，但目前不能把全站旧浏览器兼容标为已完成。

| 未完成项 | 完成条件 |
| --- | --- |
| 浏览器覆盖 | 补正式 Chrome / Edge 80 和 Safari 13.1；Chromium snapshot 不代替两种品牌版本，当前 WebKit 不代替 Safari 13.1 |
| 完整旧引擎业务 | 受测媒体、Chromium 80 编辑及后续 Firefox 78 草稿流程已有记录；其他业务组件仍需扩展验收，不能据此宣称全站已覆盖 |
| 真实发布交付 | 固定待发布代码与构建身份，通过远端 Check；验证镜像实际 SSR / CSS、静态资产交付、新旧标签页懒加载和整体回退 |

发布时的操作与回退要求由[部署清单](../deployment/README.md#css-样式变更发布准备)维护。上述未完成项需要真实结果关闭，不能用受测 CSS 场景的通过替代，也没有降低门槛。

官方依据：[Tailwind 3 selector strategy](https://v3.tailwindcss.com/docs/configuration#selector-strategy)、[PrimeVue 4 styled tokens](https://v4.primevue.org/theming/styled/)、[PrimeVue 4 Pass Through](https://v4.primevue.org/passthrough/)、[CodeMirror styling](https://codemirror.net/examples/styling/)。
