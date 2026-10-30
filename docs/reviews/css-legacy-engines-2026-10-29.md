# 真实旧浏览器 CSS 验收

日期：2026-10-29。承接[生产产物一致性验收](css-production-parity-2026-10-29.md)，本轮安装并运行真实历史引擎，使用同一个隔离生产构建入口，不改写 User-Agent，也不注入兼容补丁。

后续工作区已接入云端草稿并以服务端租约替换 Web Locks；旧引擎编辑流程的隔离复验和生产边界见[实施记录](../designs/shared-cloud-draft-implementation-2026-10-30.md)。下文保留 CSS 独立 PR 的当时证据。

## 安装与复跑

浏览器和驱动解包到被 Git 忽略的 `.dev/tools/legacy-browsers/`，使用临时测试 profile。当前主机为 Windows ARM64，运行 x64 历史浏览器；没有替换系统浏览器。

| 引擎 / 驱动 | 官方来源 | 本机目录 |
| --- | --- | --- |
| Chromium 80.0.3987.0，revision 722234 | [Google Chromium snapshot](https://storage.googleapis.com/chromium-browser-snapshots/Win_x64/722234/chrome-win.zip) | `chromium/chrome-win/chrome.exe` |
| ChromeDriver 80.0.3987.106 | [Google ChromeDriver archive](https://chromedriver.storage.googleapis.com/80.0.3987.106/chromedriver_win32.zip) | `chromedriver/chromedriver.exe` |
| Firefox 78.0 ESR | [Mozilla release archive](https://archive.mozilla.org/pub/firefox/releases/78.0esr/win64/en-US/) | `firefox/core/firefox.exe` |
| geckodriver 0.30.0 | [Mozilla GitHub release](https://github.com/mozilla/geckodriver/releases/tag/v0.30.0) | `geckodriver/geckodriver.exe` |

Chromium zip 的 MD5 与 Google 存储响应的 `x-goog-hash` 一致，为 `a1019dc80d35107b7bf4337c55718775`；本机 SHA-256 为 `1f673943d2b4e011f0dd61c97603f6b21c4e979817c3d8195c6c77b0c64cb69a`。Firefox 安装包 SHA-512 与 [Mozilla SHA512SUMS](https://archive.mozilla.org/pub/firefox/releases/78.0esr/SHA512SUMS) 中 `win64/en-US/Firefox Setup 78.0esr.exe` 一致，本机 SHA-256 为 `e471792bf19480e541ba9e673f73ebd3492de363e7463d6ae6d10d6394af8dab`。

```powershell
pnpm exec playwright test --config tests/css-legacy.config.ts
```

[测试配置](../../tests/css-legacy.config.ts)复用 production profile 的完整构建和随机 E2E 数据库。匹配年代的 [WebDriver 适配器](../../tests/support/legacy-webdriver.ts)读取真实 session capabilities 并校验主版本，避免当前 Playwright 协议与历史二进制不兼容；[Mozilla 支持表](https://firefox-source-docs.mozilla.org/testing/geckodriver/Support.html)列明 geckodriver 0.30.0 支持 Firefox 78 ESR。

报告位于 `.dev/css-legacy/report.json`；每个引擎的 `engine.json`、`initial.png`、`dialog.json` / `dialog.png`、`confirm-popup.png`、`popup-position.json`、`animations.json`（到达相应步骤时）、`final-state.json` / `final.png` 和 `driver.log` 位于 `.dev/css-legacy/results/`。记录 hydration 状态、六级标题 z-index、分页器颜色、实际资源加载和浏览器能力；交互测试要求 hydration 连续稳定后再打开懒加载 Dialog，并验证进出动画触发、稳态可见性、关闭结果及确认浮层提交。动画结束 / 取消事件另存诊断。

历史 CSSOM 的 shorthand 序列化有差异：圆角分别读取四个长属性；Dialog 动画验证 `animationstart`、最终 opacity、单位变换矩阵和尺寸，不把 `none` 与等效单位矩阵的字符串差异当作视觉失败。框架移除动画 class 时结束 / 取消事件也可能不同，因此以可见稳态和关闭后的实际节点状态为验收条件。

按钮操作使用 W3C WebDriver 原生 element click。程序化 `HTMLElement.click()` 会改变事件与 microtask 的调度时序；本项目安装版本的 ConfirmPopup 通过文档点击监听调用定位，因此最终验收额外记录浮层与触发按钮的矩形，要求弹出位置紧邻按钮下方且水平相交。

## 初次实测（修复前）

Chromium 80 已稳定复现应用错误：正文挂载后进入 Nuxt 500 错误界面，正文标记消失，错误为 `.story-section > :is(h1, h2, h3, h4, h5, h6)` 不是有效选择器。实际调用点为[吸顶标题布局](../../app/utils/content/sticky-headings.ts)与[编辑滚动同步](../../app/composables/useMarkdownEditorScrollSync.ts)。Vite 的 CSS target 不处理 JavaScript 字符串中的选择器，legacy JS 转译及 polyfill 也没有消除这个 DOM API 兼容问题。

Firefox 78 的基础检查通过：hydration、六级标题 `30 / 29 / 28 / 27 / 26 / 25`、分页器白字、懒加载 Dialog 的 `321px` 宽度、四角 `6.4px` 和 `0px` PT 内边距；Dialog 的进出动画均触发，最终可见状态和关闭后节点消失也通过。但 **ConfirmPopup 定位未通过**：原生 WebDriver 点击后，按钮矩形为 `left:348.5 / top:169 / right:470.5 / bottom:211`，浮层矩形为 `left:0 / top:2 / right:202 / bottom:99`，出现在页面左上角，没有贴着触发按钮。

补充核对：初验页单独使用了裸 ConfirmPopup，没有接入应用根节点已有的 `confirm_popup_transition`。应用当时已有定位补偿，但通过 `instance.alignOverlay()` 调用内部方法。因此上述 Firefox 结果证明了验收夹具的定位问题，不能直接推广为全站已有补偿后的表现。本次修复同时纠正夹具接线并移除内部方法调用。

初验生产构建运行结果为 **0 通过、2 失败，旧引擎验收未通过**，无重试 / 跳过。对应构建报告为 `.dev/e2e/d3a8663cecc2408fa4968c6c21dec83d/css-build.json`；临时运行凭据已删除，随机测试库和本轮服务由既有启动器清理。

| 实际版本 | 本轮结果 |
| --- | --- |
| Chromium 80.0.3987.0 | 未通过：正文布局使用不支持的 DOM 选择器，进入 500 错误界面 |
| Firefox 78.0 ESR | 初验夹具未通过：基础页面和 Dialog 通过，裸 ConfirmPopup 未定位到触发按钮 |

两引擎的资源记录均确认真实加载了 `*-legacy.js`。控制台中的 `import.meta.resolve not supported` 是 legacy 插件能力检测并回退时的预期探针输出；Chromium 的失败原因以错误页面中的实际选择器异常为准。初验时未修改应用代码，保留失败断言作为后续修复的复验入口。

已安装的 `primevue/confirmpopup/ConfirmPopup.vue` 中，`onEnter()` 设置监听和 z-index，`alignOverlay()` 由文档点击监听调用；裸组件最终 DOM 没有有效 top / left 定位。这是补齐首次进入定位的依据；现代浏览器回归也已增加实际定位断言。

## 修复与复验

两处 JavaScript 查询改为共享的普通选择器列表 `story_heading_selector`，保留六级标题及其直接父级范围；CSS 中的选择器仍由现有生产转换处理。

[确认浮层入口](../../app/composables/useMyConfirm.ts)现在只读取公开 PT `state.visible` / `state.confirmation.target`，通过 Vue transition 提供的 DOM 元素测量和设置位置，进入与聚焦后各测量一次；不读取组件实例或调用内部方法。[定位函数](../../app/utils/confirm-popup.ts)处理主题 gutter、文档滚动、底部向上翻转、水平边界和 RTL，对关闭或已移除目标停止定位。当前应用全局隐藏确认箭头，定位补偿按此约定工作。公开扩展点依据见 [PrimeVue Pass Through](https://primevue.org/passthrough/)；具体字段和 transition 类型以安装的 4.5.5 类型声明及 Nuxt 类型检查为准。

验收页复用 `useMyConfirm()` 和同一个 `confirm_popup_transition`。原生点击、动画、确认提交和贴靠按钮的坐标断言均保留；同一生产构建新增现代 Chromium 对照，运行生产 SSR / hydration、延迟 CSS / 浮层、吸顶遮挡及全屏编辑滚动，共 6 个浏览器场景。

最终同一生产构建 **6 / 6 通过**，耗时约 4.8 分钟，无失败、重试或跳过：

| 项目 | 结果 |
| --- | --- |
| Chromium 80.0.3987.0 | 正文挂载、六级标题、分页器、懒加载 Dialog、动画、ConfirmPopup 定位与确认通过 |
| Firefox 78.0 ESR | 同上，通过 |
| 现代 Chromium | 生产 SSR / hydration、延迟 CSS / 浮层定位与动画、标题实际遮挡、全屏编辑滚动四项通过 |

两个旧引擎中按钮底边均为 `211px`，浮层顶部均为 `213px`，恢复 2px gutter。已查看两种引擎的确认浮层截图。构建证据为 `.dev/e2e/3b30ca084a4e40329c7c3eecf1811981/css-build.json`，实际保留 production 模式、四引擎 CSS targets、Lightning CSS、分块与 legacy，观测到 16 个 CSS / 181 个 legacy JS chunks；临时运行凭据已删除。浏览器汇总、位置 JSON 与截图位于 `.dev/css-legacy/`。

配套检查：`pnpm test` **2041 项通过、1 项既有跳过**；`pnpm lint`、Nuxt 类型检查和 tests TypeScript 检查通过。定位函数与公开 state / transition DOM 合同的 5 项定向测试涵盖常规定位、底部翻转 / 右边界、RTL、过大浮层、关闭和目标已移除的保护。

上述为浮层修复轮次的范围；后续媒体、主题和编辑入口改写见下节。

## 媒体与主题兼容改写

- [轮播生命周期](../../app/utils/content/carousel.ts)直接驱动两侧渐变宽度，[动画](../../app/utils/content/carousel-motion.ts)保留 300ms CSS ease 曲线和多段 mask。相同目标不重启动画，反向切换从当前采样值继续；卸载取消动画。初次挂载及恢复状态直接应用，不依赖 `:has()` 或 `@property`。
- 图片尚未恢复尺寸时，旧引擎可能把请求的 scrollLeft 夹到 0。现在保留待恢复位置，在 load / resize 后重试，直到可以恢复或可测量容器中的图片均已完成 / 失败；隐藏预览继续保留快照，手动滚动及导航按钮可接管。减少动态效果时直接切换，缺少原生 smooth scrolling 时使用可中断的逐帧滚动。[WebKit 15.4 说明](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/)记录了原生 smooth scrolling 的后续支持；本机回退合同测试不代替 Safari 13.1 实测。
- [Preview 样式](../../app/components/MyContent/Markdown/Preview.vue)保留原来的渐变形状，移除已停用的 `.encrypted-image-loading` 样式。当前私有图片读取服务端可读 URL，与普通图片共用加载、淡入和失败状态。轮播使用相邻 margin 替代 flex gap；失败占位、空封面及 iframe 的 16:9 布局使用百分比 spacer。
- 生产包中 Tailwind 默认 class 策略生成的 `.carousel-caption:is(.dark *)` 在 Chromium 80 不生效；静态转换不能把这一复杂选择器作为已兼容结果。改用 [Tailwind 官方自定义 dark variant](https://v3.tailwindcss.com/docs/dark-mode#customizing-the-dark-variant)，输出 `.dark` 普通祖先选择器。源码中的标题、控件及附件状态 `:is()` 同时改为普通列表，没有新增 CSS 转换插件或依赖 patch。
- Nuxt Icon 运行时 CSS 默认使用 `:where()`，Chromium 80 截图中导航、锁和加载图标没有形状。通过公开 `icon.cssWherePseudo: false` 配置修复；回归读取实际 icon mask 和非零宽度，截图确认箭头与锁图标显示。图片有效元数据另生成经过净化的尺寸变量，在加载前预留相同裁剪几何；不依赖旧引擎对 HTML 宽高比例提示的处理。

[共享媒体用例](../../tests/support/css-media.ts)通过真实 Preview 渲染入口检查渐变中间帧、12px 间距、滚动到末尾、正文修改 / 卸载重挂后的恢复、深浅色 caption、288px 容器、私有图片加载 / 失败和无权限表示。历史编辑用例要求通过原生输入操作真实 CodeMirror，检查全屏预览、主题、双栏跟随、用户菜单和 500px 视口；初始化失败时不得把后续步骤计为通过。现代对照另验证 iframe 加载与 16:9 尺寸。单元测试覆盖平滑滚动回退、手动中断、减少动态效果、尺寸未就绪的恢复及卸载清理。

新增登录流程曾暴露测试传输边界：实际 Chromium 80 拒收 HTTP localhost 的 Secure 测试 cookie，不能沿用现代浏览器的本机 HTTP 特例。[历史 HTTPS 边界](../../tests/support/legacy-https.ts)使用 Windows 自签证书和仅回环的 HTTPS 代理；证书只驻留内存，WebDriver 会话接受该测试证书，不安装系统信任、不修改应用 cookie 属性。这个边界用于完整登录流程，不把 HTTP 下丢失认证的结果归因于 CSS。

扩大到真实编辑页后的生产构建 `8c8c55cd10da4e7a9e0c3755c7b6de04` 为 **10 / 12 通过**：两种历史引擎的媒体和浮层通过，现代 Chromium 的六项生产对照通过；两个历史编辑用例停在初始化。Firefox 78 的实际错误为 `Intl.Segmenter is not a constructor`。依赖链为 `markdownlint@0.41.1 → string-width@8.2.1`，后者在模块顶层无条件创建 Segmenter；CodeMirror 命令模块本身对此 API 有存在性检查。不得把 CSS / 媒体的通过计为旧编辑器已通过。

该轮提出使用 [FormatJS Intl.Segmenter 标准 polyfill](https://formatjs.github.io/docs/polyfills/intl-segmenter/)补齐 API，在 Markdown 诊断依赖初始化前加载，避免 patch 或内部模块替换。注册表只读查询版本为 `12.2.15`，展开大小 `1,182,496` 字节，直接依赖 `@formatjs/intl-localematcher@0.9.0`；这不是生产压缩包体。用户后续已批准并安装，实际构建改动与复验见下文。

## 当前 CSS 改写的最终复验

在等待新增依赖授权时，对最终媒体、隐藏预览恢复和图标配置执行独立的 CSS 场景选择：

```powershell
pnpm exec playwright test --config tests/css-legacy.config.ts --grep-invert 'edits real'
```

结果 **10 / 10 通过**，无失败、重试或跳过，耗时约 9.2 分钟。该命令明确选取四项历史 CSS / 媒体场景及六项现代对照；两个历史编辑用例保留在完整配置中，仍处于前述失败状态。

构建证据为 `.dev/e2e/c9131bef6a7247fc89b09f5eef0f56e8/css-build.json`：production 模式、`chrome80 / edge80 / firefox78 / safari13.1` CSS targets、Lightning CSS、16 个 CSS 和 183 个 legacy JS chunks。临时运行配置已删除，隔离服务及测试库由启动器清理。当前报告与截图位于 `.dev/css-legacy/`，后续复跑会替换该目录。

两种历史引擎观测到 48px 渐变及介于 0–48px 的动画帧、12px 图片间距；重新挂载恢复末尾位置。288px 容器中的私有图片加载前后均为 `288 × 128px`，失败占位为 `256 × 144px`。图标具有实际 mask 及 `20px` 宽度；已查看 Chromium 80 的深色窄容器截图，确认箭头和锁图标显示。

该轮配套检查合计 **2050 项通过、1 项既有跳过**（应用 / 服务 1698、工具 322、组件 30）；官方 API 独立 CSS 十组、lint、Nuxt 类型检查和 tests TypeScript 检查通过。该轮没有新增应用依赖或更改锁文件，没有提交、部署或变更系统证书信任。

## 编辑器标准 API 与正则转换

用户分别授权新增运行时和构建依赖后，固定接入 `@formatjs/intl-segmenter@12.2.15`、`@rollup/plugin-babel@7.1.0`、`@babel/core@7.29.7` 与 `@babel/plugin-transform-unicode-sets-regex@7.29.7`。后两项原已作为间接依赖存在；现有包版本没有升级，锁文件仅增加新入口及其依赖闭包。

[诊断兼容入口](../../app/utils/content/editor/markdownlint.ts)先加载 FormatJS `polyfill.js`，再导出 markdownlint，确保后者在模块求值时可以创建 Segmenter；原生实现存在时保留原生 API。[入口回归](../../app/utils/content/editor/lint-legacy.test.ts)移除平台 Segmenter 后加载实际诊断模块，验证中文、组合字符和家庭 emoji 的字素分段，以及真实 MD018 诊断。

仅补齐 Segmenter 后，生产构建 `dbd4403041f748239b7f14611e7a20ab` 仍为 10 / 12：旧编辑器另报 `Invalid flags supplied to RegExp constructor 'v'`。`string-width@8.2.1` 使用静态 `/v` 正则及 `RGI_Emoji`；[Oxc 文档](https://oxc.rs/docs/guide/usage/transformer/lowering)说明正则 lowering 会转为构造器，不提供完整语义回退。后续 legacy 转换无法再把动态 `RegExp(..., 'v')` 当作静态字面量编译。

[构建入口](../../config/browser-transforms.ts)使用官方 Rollup Babel 插件和 Vite 公开 `enforce: 'pre'` / `apply: 'build'`，在 Oxc 前编译 JavaScript 模块中的静态 `/v` 正则；现代和 legacy 双产物继续保留。[Babel 官方插件](https://babel.dev/docs/babel-plugin-transform-unicode-sets-regex)处理 Unicode 集合语义，不是移除 flag 或替换依赖内部模块。[产物回归](../../scripts/verify/browser-regexp.test.ts)构建真实 Vite 双产物，在拒绝 `v` flag 的平台构造器边界验证家庭 emoji、普通中文和组合字符。另用真实 Chromium 80 / Firefox 78 执行转换后的独立样本，两者均得到 `[true, false, true]`；独立样本通过不代表整页编辑流程已经通过。

### 完整矩阵与资产观测

构建 `68660e66bcad437d94af2bbf2f646a16` 的完整矩阵为 **10 / 12 通过**，无跳过 / 重试：历史媒体与浮层四项、现代对照六项通过；两个编辑用例失败。Chromium 80 的 trace 已证明通过编辑器可写初始化，随后在原生清空 / 批量输入步骤超时。键盘替换后的独立探针确认短文档可以输入，但长文档批量命令仍超时，不能认定是 Element Clear 单独导致；登录截图另发现用户名漏字符。[历史 WebDriver 边界](../../tests/support/legacy-webdriver.ts)现对 contenteditable 使用原生 Ctrl+A、退格，并逐字符发送原生输入，让响应式更新在命令间完成；表单另有 Tab 和字段值断言。完整编辑定向复验另行记录，不计作本轮矩阵通过。Firefox 78 的独立阻塞见下节。该完整矩阵归档于 `.dev/css-legacy-babel-matrix/`，固定输出 `.dev/css-legacy/` 会被后续复跑替换。

构建记录确认 Babel 在 Oxc 前运行。后续满幅几何修复的最终构建 `8ba36fad4fcc4ff7ad37092ee2b3b20f` 同样保留 production 模式、四引擎 CSS targets、Lightning CSS、CSS 分块与 modern / legacy，CSS / legacy JS 数量为 16 / 183。以下资产表比较该最终构建与此前不含 Segmenter、正则预转换和满幅几何修复的 `c9131bef6a7247fc89b09f5eef0f56e8`，仅统计实际 `_nuxt/*.js`（字节）：

| 产物 | 文件数 | 原始合计：改前 → 改后 | gzip 合计：改前 → 改后 | gzip 增量 |
| --- | --- | --- | --- | --- |
| modern | 183 → 183 | 7,259,281 → 7,455,181 | 1,864,758 → 1,912,970 | 48,212，约 47.1 KiB |
| legacy | 183 → 183 | 7,523,174 → 7,719,561 | 1,935,426 → 1,984,224 | 48,798，约 47.7 KiB |

测量使用 Node `gzipSync` level 9，逐文件压缩后求和，不含 sourcemap。这是整组前端资产观测，不是首屏下载或真实 CDN 传输增量，也不是 FormatJS 安装包展开大小。测量保存在 `.dev/tools/editor-assets.json`。

配套检查为 **2052 项通过、1 项既有跳过**（应用 / 服务 1699、工具 323、组件 30）；lint、Nuxt、scripts 与 tests 类型检查通过。新增依赖的最小锁文件已通过 `pnpm install --frozen-lockfile --ignore-scripts`，现有依赖版本未升级。该完整矩阵的临时运行配置已删除，服务和测试库由启动器清理；未部署或提交。

## 满幅裁剪修复与最终交互复验

逐字符原生输入保留全部 25 段正文后，Chromium 80 已通过输入、全屏预览、文字主题切换和双栏滚动。500px 窄屏继续发现横向溢出：水印的巨大旋转伪元素使用不受支持的 `overflow: clip`，同时 `50vw` 包含滚动条空间；只在 body / html 隐藏溢出并不能满足实际文档宽度约束。

水印现在通过 `@supports not (overflow: clip)` 使用局部 hidden 回退。不能只连续写 `overflow: hidden; overflow: clip`：实际 Lightning CSS 会把它折叠为单个 clip 声明；最终 `entry.CJsmnGp2.css` 已确认保留条件回退。应用在不支持 clip 时用 ResizeObserver 维护共享 `--app-half-viewport`，读取 `document.documentElement.clientWidth / 2`，供 Story Header、MyDivider 和 Preview 满幅几何共用；现代路径保留 `50vw`。没有固定 500px 或滚动条宽度，也没有给应用根节点新增滚动容器；观察器卸载时清理。

隔离真实旧引擎验证中，裁剪和可用视口计算使文档 scrollWidth 等于 clientWidth，滚动后的吸顶标题仍为 top 0。最终完整生产构建 `8ba36fad4fcc4ff7ad37092ee2b3b20f` 为 **11 / 12 通过**，约 15.1 分钟，无跳过 / 重试：Chromium 80 三项、Firefox 78 媒体与浮层两项、现代 Chromium 六项通过；唯一失败为 Firefox 78 的只读编辑。Chromium 80 编辑用例耗时约 3 分钟，500px 窗口实际 clientWidth / scrollWidth 均为 `466px`，溢出元素列表为空。报告和截图在 `.dev/css-legacy/`；临时运行配置已删除。

**这不是完整视觉验收通过。** 查看全屏和窄屏截图后发现 Chromium 80 暗色文字已变浅，但编辑区和部分背景仍白色。此前交互用例只断言文字颜色改变，未覆盖底色；新增的独立底色回归确认这是当前全局权重策略的缺陷，见下节评估。不能用上述 11 / 12 的交互结果关闭暗色视觉门槛。

## 暗色工具类与权重方案评估

本节先保留迁移前的评估证据：用户选择取消全局 selector important，使用现有 tokens/PT 和局部 `!`。随后用户授权实际接入，当前代码已切换；最新状态见下节，不能把本节历史失败当作迁移后的结果。

实际生成的规则是 `#stupig-app :is(.dark .dark\:bg-slate-900)`。Tailwind 3.4.19 的祖先 important 策略会为包含顶层组合符的变体加 `:is()`；所以 `.dark &` 虽修复了部分 scoped `@apply` 输出，却没有修复全局暗色工具类。Chromium 80 忽略该规则，Firefox 78 可以匹配。问题在 PostCSS 原始输出中已存在，不由 Lightning CSS 压缩引入。通用 [CSSTools 转换器](https://github.com/csstools/postcss-plugins/tree/main/plugins/postcss-is-pseudo-class#%EF%B8%8F-known-shortcomings)说明复杂选择器与 specificity 的已知限制，不能直接作为完整等价方案接入；本轮没有安装它或编写专用转换器。

```powershell
pnpm exec playwright test --config tests/css-legacy-utilities.config.ts
pnpm exec playwright test --config tests/css.config.ts
```

[旧引擎工具类回归](../../tests/e2e/css-legacy-utilities.spec.ts)使用真实 Tailwind / Autoprefixer / Lightning CSS 输出，独立回环页面和已有历史 WebDriver，不启动 Nuxt、数据库或云服务。它比较当前加权策略与 `important: false` 对照，覆盖普通及局部 `!` 背景类。8 项结果为 **6 通过、2 失败**：当前策略在 Chromium 80 的压缩前 / 后均保持白底；关闭全局加权后，两引擎压缩前 / 后均得到 `rgb(15, 23, 42)`，普通与局部 `!` 类均通过。Firefox 78 的当前策略两项也通过。失败断言保留；证据在 `.dev/css-legacy-utilities/`。

隔离候选 `application-local` 使用以下公开配置，并挂载相同的真实 PrimeVue preset、PT 和 CodeMirror：

```ts
export default {
  important: false,
  darkMode: ['variant', '.dark &'],
}
```

只对已知冲突的 Button padding / 圆角、Dialog PT content padding、演示 CodeMirror content 颜色和状态背景使用局部 `!`；宽度类保持普通优先级。完整独立夹具 **12 / 12 通过**，其中候选占压缩前 / 后两项；补充底色断言后的当前 / 候选四项定向复验也通过。候选保留 Button `123px`、Dialog `321px` 行内宽度，覆盖 body Teleport，公开 token 与深浅色更新正常。没有修改 PrimeVue 或 style-mod 安装包，没有内部 alias 或原型替换。

评估结论：此路线在隔离组件原型及旧引擎底色样本上有正向证据，值得继续迁移；**不是全站迁移已完成，也不是完整旧引擎组件原型已通过**。建议接入顺序：

1. 盘点实际调用点，优先保留 / 补齐 preset、实例 dt、PT 和 CodeMirror 主题入口；只在确认需要 utility 覆盖的节点使用局部 `!`，不批量给所有类加重要性。
2. 在同一个待审实现中迁移冲突并关闭全局 selector important，保留上述普通 dark variant。继续保护行内几何、正文净化、SSR 和懒加载，不引入新解析依赖。
3. 为真实编辑器与预览增加背景 / 前景对比度验收，扩展暗色、hover / group / peer 等实际状态、Teleport 和延迟 CSS 的旧引擎回归；独立失败用例必须转绿，再判断是否接入。

Web Locks 兼容仍是独立门槛；取消样式加权不会补齐 Firefox 78 的跨标签草稿互斥。

### 官方局部权重接入

实际应用的 Tailwind 已设置 `important: false`，保留 `darkMode: ['variant', '.dark &']`。生产 `entry.giYY_DUY.css` 的暗色背景直接生成 `.dark .dark\:bg-slate-900`，不再包裹祖先 ID 和复杂 `:is()`；body ID 仍用于 SSR / 验收定位。既有 preset、dt、PT、CodeMirror 主题及其他兼容修复继续使用。

实际调用点仅补齐必要的局部优先级：命令栏输入字体、颜色、透明背景及浮层裁剪；验证码附加区的横向间距 / 按钮字号；附件添加按钮的指定宽度。通用组件宽度保持普通优先级。没有新增依赖、CSS 转换器或草稿存储协议。

隔离夹具已把 `application-local` 合入正式 `application`，删除重复候选模式和开关。正式配置的十组对照通过；补充晚到库样式后的两项定向复验通过，Button `123px` / Dialog `321px` 行内宽度、PT 间距及主题继续正确。真实旧引擎的普通 / 局部 `!` 底色断言均通过；首次 Firefox 退出驱动时报一次 Marionette 解码错误，其对应两项单独复跑通过。

完整生产验收使用构建 `a744ff657ba44a3489ef14081549a27d`。旧编辑用例新增了管理页实际命令栏样式、编辑区 / 全屏层底色与页面主题一致性检查；现代验收新增共享登录弹窗、验证码附加区和管理页的字体、间距、深浅色与 hover 状态，未触发短信发送。Chromium 80 的完整流程已通过，已查看全屏与 500px 窄屏截图，确认此前白底浅字问题消失。Firefox 78 的管理页样式、媒体与浮层通过，编辑仍因缺少 Web Locks 只读；本次没有放开保护。

该整轮结果为 **11 / 13**：除 Firefox 78 只读外，新增表单用例因 Dialog 没有可访问名称而定位失败。随后补充复验又检出隐藏注册表单内的重复验证码节点；测试改为定位 Dialog 中可见的附加区，所有样式断言保留。最终构建 `fc044ec2fd0f4ff7a9086835c00fa89f` 的共享表单 / 管理页用例 **1 / 1 通过**，与整轮使用相同应用源码，仅修正测试定位。两次结果分别保留，不计作单次全绿。生产 targets、Lightning CSS、CSS 分块及 modern / legacy 双产物仍保留；测试运行配置与隔离数据库均已清理。

### CSS 独立 PR 拆分（2026-10-30）

用户决定只提交 CSS / 旧浏览器兼容，候选从 main `2f8e623` 建立，保留 #45 的图片占位、标题层级和封面过渡修复。引用、迁移、删除提示和草稿会话代码不进入候选；原工作区完整保留。最新计数与提交范围见[当前入口](css-official-apis-validation-2026-10-29.md#css-独立-pr-范围2026-10-30)，此前混合工作区的构建及计数作为历史证据保留。

构建 `c0e74933f3ed4e68b91aee64e58fddb4` 首轮所选 12 项中，现代七项和 Firefox 样式两项通过；Chromium 80 三项建会话超时，尚未进入应用页面。安装目录通过 Windows 目录联接共享，辅助函数改为使用真实安装路径后，真实 Chromium 80 会话探针成功建立并关闭。构建 `2dbf02e4af18456584b686ee191d99c1` 的三项受影响场景定向复验全部通过，未提高时限、缩短正文或减弱样式断言；已查看全屏及 500px 窄屏截图，暗色底色正常。应用源码相同，只有测试安装路径修正。首轮 9 / 12 与定向 3 / 3 分别保留；运行配置和随机数据库均已清理。只排除已明确延后的 Firefox 78 编辑用例，其失败断言仍保留，不能把本次选择计作完整旧引擎编辑验收。

## Web Locks 兼容评估（未实施）

**后续方向已调整：** 用户指出后续将按后续共享云端草稿改造（另案设计，不属于本 PR）重构。该设计明确由服务端租约成为唯一编辑权依据，替换 Web Locks，停止浏览器正文持久化，不建立每标签草稿分支。因此不再单独推进下面的临时 IndexedDB 原型；以下保留为此前针对现有本地存储协议的评估。云草稿仍是未实现的提案，本次未改草稿代码、删除本地数据或放开只读保护；Firefox 78 的完整编辑要求须在云草稿接入后重新验收。

用户已选择保留 Firefox 78 的完整编辑要求，先评估跨标签互斥兼容方案。生产构建 `68660e66bcad437d94af2bbf2f646a16` 的 Firefox 78 已加载真实 CodeMirror，客户端错误列表为空，但 `contenteditable="false"`，页面显示『当前浏览器不支持跨标签页安全同步』。这是 [useStoryEditSession](../../app/composables/useStoryEditSession.ts) 对缺少 `navigator.locks` 的主动保护。[Mozilla Firefox 96 开发说明](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/96)记录 Web Locks 默认启用；[WebKit Safari 15.4 说明](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/#web-apis)记录相应支持，因此 Safari 13.1 也必须列入此兼容评估，不能仅修 Firefox。

当前合同是『前一持有者保存草稿后才释放，接手者读取最新草稿后才可编辑』。保存或引用重放进行中会延迟释放，存储失败也不会正常交出编辑权。草稿的写入、删除和旧 schema 升级由 [contentDraft](../../app/stores/contentDraft.ts) 同步操作 localStorage；`pagehide` 和卸载会立即调用 `persist_now()`。这些合同都必须保留，不能只把只读条件放开。

| 候选 | 评估 |
| --- | --- |
| 直接移除 Web Locks 检查 | 不采用：会失去同一草稿的跨标签写入保护 |
| BroadcastChannel / storage 消息加 localStorage 心跳锁 | 不作为互斥保证：消息负责通知，localStorage 的读后写不是原子竞争；冻结标签恢复后可能仍持旧身份写入。[HTML 标准](https://html.spec.whatwg.org/multipage/webstorage.html#introduction)明确要求作者不要假定存在存储锁 |
| SharedWorker 协调 | 不能覆盖当前全部最低版本；[Safari 16 才加入 Shared Workers](https://webkit.org/blog/12824/news-from-wwdc-webkit-features-in-safari-16-beta/) |
| IndexedDB 仅保存锁，正文继续共享 localStorage | 不足：锁校验与正文写入位于两种存储，旧持有者可在两步之间失去资格，随后覆盖新正文 |
| IndexedDB 短事务同时校验编辑权并写入草稿 | 此前建议进入隔离原型，现已停止推进；使用公开标准 API，可不新增依赖，但属于草稿存储与交接协议变更，尚未实现或证明完整等价 |

此前候选原型采用每个草稿的持有者 ID 与递增代次（epoch）。抢占、续约和交接通过短 `readwrite` 事务更新；每次保存、删除、迁移均在覆盖相同存储范围的事务中检查持有者和代次，检查通过才写入正文与引用基线。超时只影响何时尝试接管，正确性依赖事务内的代次检查，不能依赖心跳准时执行。接手者先读取已提交正文；旧持有者恢复后写入被拒，保留未提交文本并进入只读。[IndexedDB 2.0](https://www.w3.org/TR/IndexedDB-2/)规定重叠范围的读写事务串行调度；这是方案可行性的标准依据，尚不是旧引擎原型实测。

原型使用基础 `open / transaction / get / put` 与自动提交；事务中不等待网络、计时器或整个编辑会话，只有 `complete` 后才显示已保存。不要依赖最低版本未验证的显式 `commit()` 或新事务选项。通知只负责触发重新读取，不能代替事务内的检查。

此前列出的原型门槛如下；这不是当前实施清单，云草稿按其设计合同另行验收：

1. **离页恢复。** IndexedDB 是异步事务，不能把现有同步 `pagehide` 保存简单换成未等待的 Promise。需验证每标签独立的同步恢复记录等方案；记录带草稿身份、代次和基线，只作待恢复分支，不得直接覆盖权威草稿。恢复、容量限制、清理和敏感正文的权限边界均需设计。
2. **交接与迟到结果。** 覆盖双标签同时竞争、后台冻结 / 恢复、崩溃、不依赖关闭事件的接管、保存 / 引用重放期间切换、身份 / 档案变更，以及旧异步回调。所有修改入口都受同一代次约束；通知通道丢消息仍不能导致旧写入成功。
3. **不确定的服务端提交。** 当前更新接口有 revision 冲突保护，创建接口有标题唯一性检查，但没有请求幂等键；本地代次不能撤回已经发出的 HTTP 请求。原型需明确在途创建 / 保存结果不明时如何阻止重复提交、保留正文并核对结果，不能按锁超时自动重发。
4. **迁移与回退。** 需要验证已有 localStorage 草稿的一次性导入、旧新标签同时存在、旧版本仍写旧 key、数据库升级被旧连接阻塞，以及回退代码如何读回新草稿；失败时保留原数据。不得只让 Firefox 使用独立锁协议而与同源现代标签各写一套正文。
5. **真实引擎与负向验证。** 先在 Chromium 80 / Firefox 78 的隔离双标签验证旧代次写入和删除必定被拒，再补 Safari 13.1；同时验证关页恢复、配额 / 禁用存储、事务中止和上面各类迟到情况。数据丢失与竞争用例需能检出故意移除代次检查的错误。通过后再评估接入主流程。

此前评估说明，没有把一个已验证的官方 polyfill 接上就能维持现有 localStorage 协议的证据。当前将此功能阻塞交由云草稿改造解决，不再为即将替换的本地协议增加另一套实现。本轮保持 Web Locks 保护、全部最低版本要求和失败断言；未改草稿协议、未新增相关依赖，也未把 Firefox 78 的只读结果计作编辑验收通过。

## 覆盖边界

Chromium snapshot 是真实的历史 Chromium 引擎，但不是正式 Chrome 80 或 Edge 80 品牌发行包；[Chromium 官方说明](https://www.chromium.org/getting-involved/download-chromium/)也明确 snapshot revision 不一定对应用户发行版。Firefox 本轮使用实际 78.0 ESR 发行版。当前没有对 Chrome 80 / Edge 80 品牌包、Safari 13.1、真实发布镜像或线上缓存作通过声明。Safari 13.1 需要对应 macOS 环境，Windows 上的其他 WebKit 版本不能代替。
