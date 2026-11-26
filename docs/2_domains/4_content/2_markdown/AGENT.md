# AGENT：档案 Markdown 的裁定、出入与待办

- 本文档状态：PENDING（初稿，待人类审阅）
- 覆盖范围：本目录的人类裁定、落实与验证、出入和待办
- 旧文档：`docs-legacy/` 已于 2026-11-19 删除；本文提到的旧手册、旧台账以及“留在原文”的内容，原文都在 git tag `docs-legacy-final`
- 核对范围：读了渲染器、白名单、机密、占位相关代码；运行了 `app/features/content/markdown` 与 `server/shared` 的单元测试
- 实现设计：[SID#2.4.2.AGENT-DESIGN](AGENT-DESIGN.md)

## 人类裁定

| 原话或要点 | 落实 |
| --- | --- |
| `[!TIP]` 标题保持英文 | 现状 |
| 所有机密内容（含 `<good>`）统一图标：机密为锁上的锁，删减版为打开的锁；取代早先的「机密框图标保持现状」 | 已改代码，见下 |
| HTML 标签白名单放 AGENT-DESIGN | 已写 |
| 机密内容原处留“无权查看”提示 | 现状 |
| 无权查看和渲染失败“搞个统一的占位符格式”，只改文字区分 | 已改代码，见下 |
| LAW 不覆盖编辑器和预览器 | 人类改 LAW 覆盖范围；编辑器和预览器只写在 AGENT-DESIGN |
| 2026-11-23 批准显式 `<carousel>`，旧文由作者手工迁移。轮播和正文间距由作者写的空白控制 | 显式语法启用，旧自动分组和文件夹展开依现行 LAW 暂时保留 |
| 2026-11-23 要求移除旧自动分组兼容，并加宽作者在轮播项目之间写出的空白 | 轮播由 `<carousel>` 显式创建。项目之间的空白占 `0.5em`，连写仍无间隔 |
| 2026-11-23 裁定文件夹图片语法退役，旧引用由人类手工迁移 | 开发与生产复扫旧语法均为 0，生产原 4 处均已改为显式图片链接并包裹 `<carousel>`。已移除渲染和引用检查的旧语法特例。[盘点命令](AGENT-DESIGN.md#旧文件夹图片引用盘点) |
| 2026-11-23 裁定文件夹卡片只数直属项目，文件与子文件夹各算一项 | 文件夹卡片显示 `N 项`，空子文件夹也计入。2026-11-25 人工验收通过 |
| 2026-11-24：UI-I07 补全无匹配时沿用现状，无需显示提示。档案或附件列表加载失败时，标明不可用来源，继续提供其他可用来源的建议 | 2026-11-25 细分失败提示：尚无快照时显示『档案来源暂不可用』或『附件来源暂不可用』，已有快照的刷新失败显示『档案列表更新失败』或『附件列表更新失败』。旧建议仍可选择，下次成功后消除提示。已人工验收 |
| 2026-11-24：UI-L07 编辑器预览的文件夹卡片保留目前无法打开的提示 | 已移除 Editor 中未用的事件转发，Preview 继续给出提示，详情页使用 Preview 的跳转事件。已验收 |
| 2026-11-24：无权阅读时，正文里的机密文件夹引用与机密附件使用同一占位 | 详情页及公开预览已接入。空目录和继承机密的子目录也适用，待人工验收 |
| 2026-11-25：移除附件路径同名时的标签与 caption 特判 | 空标签生成卡片，非空标签显示普通链接条，非空 caption 显示在图片下方。目录引用索引按同一卡片条件覆盖子树。定向单测 386 项通过 |

## 落实与验证

2026-11-25 复核后将标签补全与来源错误提示限制在真正的 Front Matter，正文、围栏代码及 HTML 示例不再误触发；清理 UI-L11 的重复长图文案，统一由渲染器输出『点击查看完整图片』。补全、渲染及草稿会话定向单测通过。另以实际 `Body.vue` 的服务端渲染和独立 Chromium 复现水合替换媒体节点，固定初始渲染函数后，水合及后续正文修改都保留原图片与低清层。SSR 水合、正文更新和点击转发的组件回归已通过，保留人工验收记录。

2026-11-24 批次 2 覆盖文件夹卡片的空目录、直属文件与子目录混合计数，以及数据变化后的预览。补全来源用例覆盖单源和双源失败、保留可用建议、无匹配及恢复。见[批次 2 验证](../../../TMP-UI-AUDIT.md#批次-2-验证)。

2026-11-24：定向组件核对中，在 Markdown 编辑器输入 `@`、关闭补全并保持编辑器焦点后，向编辑器发送 Ctrl+Space 的键盘事件，附件建议能再次打开。此核对不覆盖操作系统及输入法的按键分发。

| 改动 | 验证 |
| --- | --- |
| 新增 `server/shared/content-placeholder.ts`；机密、附件卡片、档案卡片、图片、iframe 的占位都改用它；`Preview.vue` 的旧占位样式换成 `content-placeholder*` | eslint、vue-tsc 通过；单元测试 540 条通过（含新增“缺失附件显示占位”）。E2E 只改了选择器，没有运行 |
| 人类看截图后要求：失败图标改三角感叹号，卡片位占位加大，图片位图标与文字居中；清理了 `story-card-dead`、`story-card-cover-empty`、`book-x` 和死档案卡片分支 | 同上 |
| 行为变化：附件路径无效原先什么都不显示，档案标题无效原先是灰色卡片，现在都显示占位 | 同上 |
| 新增 `privacy-marker.ts` 的 `PRIVATE_ICON`（`lucide:lock`）与 `REDACTION_ICON`（`lucide:lock-open`），正文的附件卡片、图片标条、`<good>` 块和行内都改用它，删减版改蓝色；不再用 `lock-keyhole` 系列 | `app/features/content` 单元测试 601 条通过（图标登记测试同时扫描 `privacy-marker.ts`）；`MyContent` 组件测试 64 条通过；eslint 通过；typecheck 只剩 3 个已有错误。没有截图确认 |
| 2026-11-22：附件列表、补全和文件卡片恢复类型图标，保留机密色；卡片的机密标签移至尺寸或文件数量前，机密目录卡片沿用文件夹图标。图片标条与确认弹窗的状态变化图标不变 | 定向单测 219 项、组件测试 38 项通过；未跑浏览器验收 |
| 2026-11-22：普通链接不套机密配色，完整版和删减版卡片各用同色文件名与图标；确认同行混排的 caption、底边对齐和滚动位置 | `pnpm exec playwright test --config tests/css-production.config.ts css-production-markdown.spec.ts` 通过，覆盖宽窄窗口与明暗主题；不涉及真实 OSS |
| 2026-11-22：卡片及图片占位共用明暗纯色底，正文与封面原生懒加载，大图打开时才请求并复用图片加载图标 | `pnpm exec playwright test --config tests/css-production.config.ts css-production-markdown.spec.ts` 2 项通过，隔离生产构建，覆盖混排、明暗底色、封面慢加载、正文按需加载和大图失败；另有定向单测 232 项、组件测试 40 项通过 |
| 2026-11-22：正文和预览的可跳转链接、卡片使用主题色 4px 底边，悬停不换色；附件和图片共用顶部机密标条，显示原件时不再区分是否有删减版 | 渲染与预览测试 183 项、生产 Chromium 测试 2 项通过，覆盖明暗主题、宽窄布局、底边主题色及 hover；未改变档案列表卡片 |
| 2026-11-22：新增内容语义色 token，统一卡片中性强调、机密／删减版强调及机密正文框色值，供附件行、机密确认和 Markdown 共用 | `pnpm test:component app/components/MyContent/Attachment/PrivacyConfirm.nuxt.test.ts` 1 项通过；`pnpm build` 客户端 CSS 构建成功，Nitro 阶段因 ali-oss 源码解析失败而终止；未运行 E2E |
| 2026-11-23：Markdown 文件夹卡片复用文件卡的尾部跳转图标，保持普通与机密文件夹的可点击提示一致 | `pnpm exec vitest run app/features/content/markdown/render/render.test.ts` 111 项通过；ESLint 与 `git diff --check` 通过；未运行 E2E |
| 2026-11-23：封面、正文图片与 iframe 共用图片加载遮罩片段；封面和正文图片共用失败图标片段，各入口保留自己的辅助标签和外层状态逻辑 | `pnpm exec vitest run app/features/content/image-frame.test.ts app/features/content/story-cover.test.ts app/features/content/markdown/render/render.test.ts` 3 个文件 114 项通过；ESLint 与 `git diff --check` 通过；未运行 E2E |
| 2026-11-23：修复横向 carousel 中附件无权占位被 flex 收缩而异常换行；占位现在与卡片一样不收缩、垂直 margin 由轮播管理 | 生产 CSS 用例补了混排回归，但按人类要求未运行 E2E；定向渲染测试与 ESLint 通过 |
| 2026-11-23 加入显式 `<carousel>`、多附件复制和拖入分组，移除固定间隔并修复普通链接折行时的重叠 | 定向单测 499 项、组件测试 40 项通过。生产 CSS 的新用例通过，覆盖折行、连写无缝和换行留一格。旧混排用例的悬停断言跑在错误主题，已修正测试前置，另以 Chromium 复核明暗悬停、翻页跳过空格和滚动位置恢复 |

2026-11-19 人类确认保留旧浏览器的 `Intl.Segmenter` 补丁。`pnpm exec vitest run app/features/content/markdown/editor/lint-legacy.test.ts` 验证首次加载、字素分割与诊断，1 项通过，本轮沿用原超时。

## 代码与 LAW 的出入

显式 `<carousel>` 已写入 LAW，运行时已移除同段自动分组和旧文件夹图片展开。盘点工具继续识别旧文件夹图片写法。

## 待办

| 事项 | 完成条件 |
| --- | --- |
| 人类截图确认占位外观 | `pnpm dev` 下看三种尺寸 |
| 人类截图确认机密附件与删减版的卡片、图片标条 | `pnpm dev` 下深浅两种主题各看一次 |
| 迁移旧轮播正文和草稿 | 生产中 27 组完成显式轮播迁移和两格缩进，档案 #9 第 34–35 行的两张建模卡片经人类确认保留普通排版。独占段落的单项另列于 `.dev/legacy-folder-images/production-implicit-carousels.md`。文件夹图片语法退役按近期需求清单处理 |

## 旧资料去向

2026-11-19 逐章对照源码后记录；仍成立的实现细节已补进 AGENT-DESIGN。

| 来源 | 去向 |
| --- | --- |
| 旧 Markdown 手册（`docs-legacy/modules/content/markdown.md`）『元数据』 | `SID#2.4.0` |
| 旧 Markdown 手册『业务引用』 | 卡片在 LAW 和 AGENT-DESIGN『卡片』；引用写法和改名跟随归 `SID#2.4.3` |
| 旧 Markdown 手册『启用的语法』 | LAW；AGENT-DESIGN『语法范围』『HTML 白名单』『正文里的机密内容』『LAW 没写的细节』 |
| 旧 Markdown 手册『图片与卡片』 | AGENT-DESIGN『卡片』『统一占位』『正文里的机密附件』 |
| 旧 Markdown 手册『诊断、改写与预览』 | AGENT-DESIGN『编辑器与预览器』；引用改写的补丁规则归 `SID#2.4.3` |
| 旧集成手册（`docs-legacy/modules/integrations.md`）『Bilibili 视频卡片』 | LAW『内嵌 iframe』『图片卡片』『Carousel』；AGENT-DESIGN『HTML 白名单』。已过时：“caption 不可点击”，caption 按行内 Markdown 渲染 |
| 旧集成手册『外链、外图与静态资源』 | LAW；静态资源和桶的分工归 `SID#2.4.7`『存放』 |
| 两份手册的『源码与验证』 | AGENT-DESIGN『入口』『验收标准』；测试归 `SID#1.2` |
