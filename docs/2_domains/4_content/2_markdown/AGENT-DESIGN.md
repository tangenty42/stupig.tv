# AGENT-DESIGN：档案 Markdown 的实现

- 本文档状态：PENDING（初稿，待人类审阅）
- 覆盖范围：渲染器、HTML 白名单、B 站 iframe、卡片与图片带、正文里的机密内容、统一占位、编辑器与预览器
- 对应 LAW：[SID#2.4.2.LAW](LAW.md)；总则见 [SID#2.4.AGENT-DESIGN](../AGENT-DESIGN.md)；引用写法与改名跟随见 `3_references`

## 入口

| 位置 | 内容 |
| --- | --- |
| `server/shared/content-markdown.ts`、`content-markdown-syntax.ts` | 前后端共用的 Front Matter 解析、语法检查、可包 Markdown 的 HTML 标签 |
| `server/shared/content-private.ts` | `<good>` 解析；服务端对无权者裁掉机密原文 |
| `server/shared/content-placeholder.ts` | 统一占位的类名、图标和文字 |
| `app/features/content/markdown/render/` | markdown-it 渲染器：`index.ts` 组装，`link-cards.ts` 卡片，`images.ts` 图片与 iframe，`carousel.ts` 图片带，`alerts.ts` 提示框，`private.ts` 机密，`sanitize.ts` 白名单，`compiled-icons.ts` 图标登记 |
| `app/features/content/markdown/editor/` | CodeMirror 语言、检查、补全、查找替换 |
| `app/features/content/markdown/preview/` | 预览 DOM：图片带滚动、附件链接、粘性标题 |
| `app/components/MyContent/Markdown/` | `Editor.vue`、`Preview.vue`（含正文全部样式）、`Body.vue` |

## 语法范围

- 裸网址不自动变链接（`linkify` 关闭）；
- 支持 Setext 标题；表格支持 `colspan`、`rowspan`、多个 `tbody` 和 `caption`（`content-markdown-syntax.ts`）；
- 不执行 Mermaid 和数学公式，任务列表也不变成可勾选的框，都按原文或代码显示。

## HTML 白名单

`sanitize.ts` 用 sanitize-html：在默认标签外允许 `center`、`img`、`button`、`details`、`summary`、`video`、`audio`、`source`、`iframe`；链接协议限 `http`、`https`、`mailto`、`tel`、`att`、`content`。iframe 只放行 `https://player.bilibili.com/player.html`，其他地址整个删掉。`![标题](iframe://…)` 在 `images.ts` 换成 `https://` 后同样校验，不合格时显示占位。

B 站 iframe 的地址参数和 `#…` 原样保留，用浏览器原生的懒加载，不改 `autoplay`。标题按行内 Markdown 渲染，可以含链接。加载完后 iframe 淡入、共用的加载遮罩淡出（`global.css`）。旧的 B 站视频信息接口已删除。

## 图片帧

列表及详情封面、正文档案卡片封面和 Markdown 图片共用图框的尺寸元数据、低清层、加载遮罩和失败图标，由同一套监听处理缓存及原生加载事件。列表和详情封面用 Vue 模板渲染，水合时保留已有图片节点。Markdown 生成 HTML 时使用相同的图框参数。图框尺寸分别适应卡片全宽、详情封面限高和正文图片的裁剪规则。iframe 和大图预览复用加载遮罩，大图也采用同款失败图标。大图的失败由当前请求的原生错误事件决定。[图片帧](../../../../app/features/content/image-frame.ts) · [加载状态](../../../../app/features/content/image-placeholders.ts)

正文图片和档案详情页的可预览封面悬停时，浅色主题亮度降至 90%，深色主题升至 125%。嵌入档案卡片的封面随整张卡片一起变亮或变暗。

## 卡片

只有空标签的附件引用渲染成文件卡片或文件夹卡片。写了标签的附件引用显示普通链接条，沿用作者写的文字。图片有 caption 时，按行内 Markdown 渲染在图片下方。

文件夹卡片显示 `N 项`。`folder_item_count()` 汇合附件路径和显式文件夹路径，按第一层子路径去重。直属文件和子文件夹各算一项，空子文件夹也计入。

正文和编辑预览中的卡片、图片框及无权／失败占位使用同一套明暗纯色底，不画虚线；caption 使用另一底色。可打开的链接和引用卡片统一用 4px 实线底边：默认取图标灰色，档案卡片取品牌色，机密和删减版卡片分别用琥珀色和蓝色；文件与文件夹卡片共用文件主体和末尾跳转图标。悬停只改变整体亮度，浅色主题变暗、深色主题变亮；占位不画底边。卡片底色使用 `global.css` 的 `--content-card-surface`，中性、机密和删减版强调色使用 `--content-accent-*`，这些强调色由附件行、机密确认和 Markdown 样式共用。文件夹卡片始终保留可交互样式和键盘语义；宿主能展开附件列表时触发 `folder-open`，否则提示预览中无法打开附件列表。

只有成对的 `<carousel>…</carousel>` 会创建轮播。开闭标签可以同行，也可以夹在正文里。独立成块时，列表、表格、引用、代码块和内层轮播各自保留结构；夹在正文中的轮播按行内 Markdown 解析子内容。标签支持 `id`、`class`、`title` 等属性，由同一套 HTML 白名单筛选后加到轮播外框上。整排超出宽度时横向滚动。作者在项目之间写空格或换行时留出半个字号（`0.5em`），紧挨着写就没有间隔。档案正文和编辑预览的文字空格用 `word-spacing: 0.25em` 加宽，文字与行内代码、链接及机密标记之间也只在作者写下空白时留间距。单个普通换行渲染为空格，Markdown 的硬换行仍然换行。

图片带由 `carousel.ts` 组装。普通、机密和删减版图片按完整卡片底边对齐，机密标条不另加竖向外边距。直接位于图片带的链接卡和行内占位均不参与 flex 收缩，避免被相邻宽卡片挤窄。同段连续图片和卡片按正文排版。普通链接的内边距和底边计入整个链接盒的高度，长标签在盒内换行。正文里的图片、视频和对应占位留上下间距，折行后两排不会贴在一起；轮播内仍按项目底边对齐。图片附件须指向文件。`![](att://文件夹)` 显示『渲染失败：图片无效』，`[](att://文件夹)` 渲染成文件夹卡片。

轮播滚动条的轨道设为透明，滑块沿用明暗主题的中性色。优先用 `scrollbar-color`，旧版 Chromium 和 Safari 用 `::-webkit-scrollbar` 系列样式。轮播右侧还有内容且尚未滚动时，右箭头旁的药丸按钮高 2.75rem，左内边距为 1rem，两行文字左对齐。第二行『可左右滚动』用 0.6875rem，颜色比第一行『右边还有！』更浅。首次滚动时文字淡出，按钮在 300 ms 内收成圆形箭头。系统要求减少动态效果时直接收起。

预览里的图片带（`preview/carousel.ts`、`carousel-motion.ts`）：翻页动画 300 ms ease，浏览器不支持平滑滚动时自己补动画，系统要求减少动态效果时不做动画；挂载时恢复各条的滚动位置，图片晚加载好时再试一次；卸载时清理监听。

### 旧文件夹图片引用盘点

```sh
pnpm exec tsx --tsconfig scripts/tsconfig.json scripts/content/legacy-folder-image-inventory.ts --env=dev
```

盘点从同一个只读数据库快照读取正式版、云端草稿及当前附件目录。输出为 `.dev/legacy-folder-images/development.md`。直属图片按渲染顺序改为显式图片链接。多张图片在同一行用 `<carousel>` 包裹，已有轮播时直接插入图片链接。单张图片直接插入链接。有目录但无直属图片时建议改为普通文件夹卡片。现有目录无法识别的图片目标列为人工核对。清单只收录相关引用片段和替换建议。[盘点入口](../../../../scripts/content/legacy-folder-image-inventory.ts)

生产盘点使用 `--env=prod` 并读取已配置的生产数据库，输出为 `production.md`。开发与生产库复扫均为 0 后已移除自动展开，保留盘点工具供复核。

## 统一占位

无权查看和渲染失败共用一种占位，只有文字和图标不同：

| 类名 | 含义 |
| --- | --- |
| `content-placeholder-denied` / `-failed` | 无权查看（`lucide:ban`）/ 渲染失败（`lucide:triangle-alert`） |
| `content-placeholder-inline` / `-block` / `-media` | 卡片位（与附件卡片同尺寸）/ 机密块 / 图片位（图标和文字纵向居中） |

| 情形 | 文字 |
| --- | --- |
| 无权查看正文里的机密内容 | 你无权查看此处的机密内容 |
| 机密附件无权 | 你无权查看此处的机密附件 |
| 附件路径无效 | 渲染失败：附件不存在 |
| 档案标题无效 | 渲染失败：档案不存在 |
| 图片地址无效 | 渲染失败：图片无效 |

图片地址有效但加载失败时不用占位：只把 `<img>` 换成图框里的 `lucide:image-off` 图标（`image-unavailable`，aria“图片加载失败”），图框和 caption 照旧，和档案卡片封面加载失败一致。
| iframe 不合格 | 渲染失败：嵌入内容不可用 |

卡片位的占位由 `placeholder_link` 生成，仍算卡片，可以进图片带。图片加载失败时的图标填充带 `image-unavailable` 类，平时隐藏，`[data-image-error]` 时由 `global.css` 显示。新增占位图标要登记到 `compiled-icons.ts`，测试会检查。

## 正文里的机密内容

`<good>` 可单独成块、可在行内、可嵌套。服务端在下发前对无权者把整段换成占位，原文不出服务端。有 `private_read` 的人看到和附件同底色的圆角区域，顶部复用附件的锁形标条，文案为「机密内容」，下面按普通 Markdown 排版。行内的 `<good>` 作为一个整体随段落换行。未闭合的 `<good>` 当普通文字，编辑器和保存时报错。

## 正文里的机密附件

附件卡片与图片共用顶部机密标条。文件名、文件类型图标和尺寸恢复普通卡片的样式，由顶部标条和底边区分状态。

| 情形 | 顶部标条 |
| --- | --- |
| 显示机密原件 | 琥珀色锁形图标和「机密附件」，有无删减版都一样 |
| 显示删减版 | 蓝色打开的锁和「机密附件删减版」，直接引用和因无权读取原件而展示删减版都一样 |
| 有权读取机密文件夹 | 琥珀色「机密文件夹」，卡片主体保留文件夹图标和直属项目数 |
| 无权读取机密文件夹，或无权读取文件且没有删减版 | 统一占位 |

普通链接不套机密卡片配色，但仍解析到当前可读的版本；完整版和删减版都不可读时保留无权占位。图片标条、`<good>` 机密框和行内机密内容仍使用 `app/features/content/privacy-marker.ts` 的锁形图标。

正文的机密文件夹引用按有效路径判断机密状态，以当前阅读权限决定是否显示卡片。公开预览按无机密权限渲染，机密目录的名称、直属项目数和跳转入口一并换成「你无权查看此处的机密附件」。附件列表的目录展示遵循 [SID#2.4.6.LAW](../6_access/LAW.md)。

## 编辑器与预览器

- 左写右看，按行号锚点双向联动滚动（`scroll-sync.ts`）。
- 进入和退出全屏编辑时，普通页面与全屏分栏用浏览器视图过渡交叉淡化。旧浏览器先淡出再淡入，系统要求减少动画时直接切换。两种布局由同一个编辑器实例切换（`Editor.vue`）。
- 预览里的标题按层级吸顶，遇到同级或更高级的标题就被推走（`preview/sticky-headings.ts`）。
- 预览有两个视角：「天子上朝」看全文；「微服私访」按没有『机密可读』的人的视角裁掉机密内容，只是模拟，不改变权限（`Editor.vue`、`preview.ts`）。
- 实时检查 Front Matter、HTML 闭合、引用有效、标题重名、大小上限；保存时服务端再查一遍。引用类问题（档案、附件、文件夹不存在，普通链接误写成 `iframe://`）的诊断来源都叫 `outer-refs`（`editor/iframe-lint.ts`）。
- markdownlint 加载前先补上 `Intl.Segmenter`；生产构建用 Babel 转换 `/v` 正则，兼顾旧浏览器（`editor/markdownlint.ts`、`config/browser-transforms.ts`）。
- 补全提示框标记、档案标题、附件名；支持查找替换。标签建议及其来源失败提示只在文档开头的 Front Matter `label:` 行显示，正文、代码和 HTML 示例中的同名行不触发。
- `Body.vue` 用固定的渲染函数提供初始 HTML，避免水合把动态 `innerHTML` 重新赋值并替换服务端媒体节点。后续正文变化仍由 DOM patcher 更新相应片段，保留图片、低清层和运行时状态。
- 在已有链接或图片语法中选择引用补全，只替换目标地址，保留 `[]` 内的链接文字或图片说明，包括与原目标名称相同的文字。正文中的裸 `@` 补全会生成完整引用。
- 档案与附件来源各自维护加载状态。请求失败且尚无快照时，补全旁显示『档案来源暂不可用』或『附件来源暂不可用』。已有快照的刷新失败显示『档案列表更新失败』或『附件列表更新失败』，成功的空列表也算已有快照。提示不可选中，旧建议和其他来源的建议仍可选择。下次成功后消除提示，加载中或成功但没有匹配时不显示失败提示。
- 在有补全建议的位置，Ctrl+Space 或 Ctrl+Shift+Space 可重新打开补全。后者供系统拦截 Ctrl+Space 时使用。
- 编辑器在明暗主题下都用琥珀色标出 `<good>` 的开闭标签，用紫色标出 `<carousel>` 的开闭标签。两种标签都带淡底色，标签内的 Markdown 内容沿用本身的语法高亮。

## LAW 没写的细节

- 卡片可以和图片混在一条图片带里。
- 提示框 `[!TIP]` 的默认标题是英文 “TIP”。
- 提示框标记只认大写（`[!NOTE]` 等）；标记后面同一行的文字成为标题（`render/alerts.ts`）。

## 验收标准

| 条目 | 测试 |
| --- | --- |
| 渲染器各语法、白名单、iframe | `render/render.test.ts`、`render/index.test.ts` |
| 图片带与卡片混排、占位进图片带、缺失附件显示占位 | `render/carousel.test.ts` |
| 机密解析与裁剪 | `server/shared/content-private.test.ts` |
| Front Matter 与语法检查 | `server/shared/content-markdown.test.ts`、`editor/lint*.test.ts` |
| 补全、编辑器状态 | `editor/completions.test.ts`、`editor/view-state.test.ts` |
| 生产 CSS 下的占位样式 | `tests/e2e/css-production-markdown.spec.ts` |
