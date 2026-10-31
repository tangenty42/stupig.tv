# Markdown、引用与卡片

正文使用 front matter 加 Markdown。`markdown-it` 负责展示，共享引用解析器负责依赖、校验和目标改写，CodeMirror 负责编辑。三者各有职责，编辑器着色不构成完整语法规范。

## 元数据

新建模板形如：

```markdown
---
title: 新建档案
label: #人上人
time: 2026/10/24
---

正文
```

标题、标签、事件时间、可选 `desc` 和 `cover` 由共享解析器校验。日期支持日／月精度，格式和组合以 `parse_story_markdown()` 为准；它是项目 front matter 规则，不应推断为支持任意 YAML 对象。封面支持外部图片或显式附件引用，同样参与引用一致性检查。

## 业务引用

| 写法 | 表现 |
| --- | --- |
| `[](att://docs/a.pdf)` | 文件卡片 |
| `[下载说明](att://docs/a.pdf)` | 带标签的附件链接 |
| `![照片说明](att://photo.png)` | 附件图片 |
| `[](att://folder)` | 文件夹卡片，计数包含后代文件 |
| `![](att://folder)` | 直接子图片组成的图集，不递归，按自然名称排序 |
| `[](content://档案标题)` | 档案卡片 |
| `[说明](content://档案标题)` | 档案文字链接 |
| `![视频标题](iframe://player.bilibili.com/player.html?bvid=BV1Pvnd6JEVD)` | 官方播放器，标签作为 carousel caption |

附件和档案链接的标签可以包含加粗、斜体和行内代码，不会因为不是纯文本就误变成卡片；iframe 图片的标签则显示在 caption 中。链接可以使用标准完整、折叠或快捷引用定义，例如：

```markdown
[说明][file]

[file]: att://docs/a.pdf "附件说明"
```

解析遵循实际生效的定义：标签大小写和空白归一化、首个定义优先，未使用或被遮蔽的定义不形成依赖。代码、HTML 属性／注释及不解析 Markdown 的原始 HTML 区域不参与业务引用扫描。

附件／档案目标匹配忽略 scheme 和名称大小写，并采用 Unicode NFC。query 与 fragment 不参与目标身份：`ATT://Docs/A.png?download=1#page2` 与当前 story 的 `att://docs/a.png` 匹配同一目标。先分离参数再解码目标；编码后的非法名称字符仍会被拒绝。不同 story 的同名附件互不相干；路径分隔、扩展名和 `.good` 等仍有业务意义。

重放只改写发生变化的目标，保留其实际大小写以及原 query/fragment。渲染保留链接选项，但不会用它们覆盖服务端生成 URL 中已有的表示版本等参数。可读附件链接单独保留原始投影地址供下载识别，追加参数或锚点后，非媒体文件仍通过签名接口按附件名称下载；媒体保留原有标签页打开行为。未变化的链接不自动改写成小写或重新编码。附件改名、移动或切换机密状态后，与旧完整路径或文件 basename 完全相同的默认标签随目标更新；自定义说明与格式保持原文。引用式链接／图片同步显示标签，折叠及快捷引用必要时保留原定义 ID，以免影响共用定义的其他说明。

旧相对附件写法和 `@标题` 不再被推断为在线业务引用，也不添加『旧引用写法已停用』一类诊断。历史数据升级属于离线[迁移流程](../../operations/content-cutover.md)，不是输入时自动猜测替换。

## 启用的语法

基础语法包括标题、段落、强调、删除线、列表、引用、分隔线、代码和标准链接／图片。裸 URL 不自动链接；围栏代码只展示，不执行 Mermaid、公式或程序。任务列表不会自动变成可交互复选框。

表格由 `markdown-it-multimd-table` 提供：支持当前配置的合并单元格、多表体和 caption，未启用的插件能力不构成项目支持范围。五种提示框使用引用首行 `[!NOTE]`、`[!TIP]`、`[!IMPORTANT]`、`[!WARNING]`、`[!CAUTION]`；标记大小写敏感，同行余文作为纯文本标题。

允许白名单内的静态 HTML，完整普通块容器可递归渲染内部 Markdown，表格和代码容器沿用专门解析边界。正文展示与编辑预览的最终 HTML（包括行内输出和业务插件输出）统一经过 `sanitize-html` 净化：禁止 script、SVG/MathML、嵌入对象和事件处理属性，仅允许 Bilibili 官方播放器 iframe，拒绝可执行 URL 协议；样式只保留有限排版属性和受控图片占位。脚本和其他来源的 iframe 不会执行，也不提供放行开关。HTML 结构诊断只负责语法提示，不替代此渲染出口的安全策略。

`<good>…</good>` 表示机密片段，支持现有行内、块和嵌套规则。无权限时服务端先生成删减正文，不能只靠 CSS 隐藏；完整合同见[访问控制](access.md)。

## 图片与卡片

独占段落的连续图片组成 carousel，单图也使用相同结构。caption 读取图片标签中的说明，按现有规则处理空标签、文件名重复和行内格式。图片区域加载失败或引用无效时以占位符替代，外围图片项和 caption 规则保持不变。

轮播边缘渐变由 DOM 生命周期中的动画驱动，保留 300ms ease 过渡，不依赖 `:has()` 或 `@property`。初次挂载和相同媒体重渲染直接恢复当前位置、渐变及已关闭的滚动提示；卸载清理动画和监听。原生平滑滚动不可用时使用逐帧回退，手动输入可中断；系统要求减少动态效果时直接切换。

图片尺寸尚未就绪时保留待恢复位置，随 load / resize 重试，避免旧引擎的临时滚动边界覆盖快照；用户操作可接管。失败占位、空封面和 iframe 保留响应式 16:9，不要求浏览器支持 `aspect-ratio`。

图片与其他元素同段混排时，caption 行为未定义为独立 carousel 的同等合同；当前保留现状。不能据此假定所有 Markdown 图片都会生成 caption。

文件、机密附件、删减表示、档案及失效卡片复用共享布局和展示数据。机密附件是否有可读像素由服务端投影决定。`iframe://` 仅用于图片语法，与普通图片组成同一个 carousel；普通链接使用该方言会产生 warning。嵌入范围见[视频卡片集成](../integrations.md)。普通视频链接保持普通链接。

有权限的私有图片使用服务端提供的可读 URL，复用普通图片的加载遮罩、淡入和失败占位；不再存在客户端解密期间专用的加载元素。无可读表示时不生成图片请求或加载遮罩。

## 诊断、改写与预览

编辑器汇总元数据／引用、HTML 结构和 markdownlint 诊断。附件、档案及 iframe 方言的引用诊断统一标记为 `outer-refs`。附件或档案目标不存在属于 warning，不因悬空引用本身升级成 error；其他结构或业务校验仍可能阻止保存。全屏和非全屏复用同一诊断列表。

Markdown 诊断的兼容入口在依赖初始化前加载 FormatJS 标准 `Intl.Segmenter` polyfill，已有原生实现时保留原生 API；生产构建同时用 Babel 官方转换编译依赖中的静态 Unicode `/v` 正则。两者分别处理运行时标准 API 和正则语义，不修改依赖安装包。验证入口见[测试指南](../../development/testing.md)。

正文标题按层级吸顶，低级标题停在上级标题下方，同级或上级标题到来时推走旧标题；不透明背景阻止下级标题透过上级标题。全屏时编辑器与预览双向同步滚动，编辑器顶部对应预览中最下方吸顶标题下沿的正文位置；标题交接时对齐位置平滑过渡，两侧滚动到顶部时均回到各自的起点。

引用目标改写保留自定义标签、title、定义 ID、换行和缩进；标签恰好等于旧目标名称时跟随新名称。解析位置映射回原始 UTF-16 字符位置，中文、emoji 和 CRLF 不应导致偏移。main 与草稿的改名／移动、标题更新共用重放模块；删除保留原链接并通过同一目标解析规则生成 warning。

编辑预览将纯渲染与 DOM 增强分开：图片加载、轮播、灯箱和标题定位在 DOM 生命周期中安装／清理，未变化媒体节点尽量保留。『天子上朝』使用当前用户实际可读表示，『微服私访』生成无机密权限的预览，不提升真实读取授权。

## 源码、验证与已知差异

- 语法和元数据：[`content-markdown.ts`](../../../server/shared/content-markdown.ts)、[`content-markdown-syntax.ts`](../../../server/shared/content-markdown-syntax.ts)。
- 引用：[`content-reference-definitions.ts`](../../../server/shared/content-reference-definitions.ts)、[`content-reference-replay.ts`](../../../server/shared/content-reference-replay.ts)。
- 渲染：[`app/utils/content/markdown/`](../../../app/utils/content/markdown/)，预览编排：[`useStoryPreview.ts`](../../../app/composables/useStoryPreview.ts)、[`useStoryPreviewBody.ts`](../../../app/composables/useStoryPreviewBody.ts)。
- 自动测试覆盖语法、引用定义、原始 HTML 边界、文字／卡片分支、权限表示、引用改写、标题吸顶及全屏双向滚动。浏览器需验证其他布局、caption、图片加载和连续输入时的媒体复用。

已知差异：渲染器支持的 Setext 标题和表格扩展，并未全部对应 CodeMirror 的着色／语法树；当前不为此统一重写所有解析器。
