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

标签中的加粗、斜体、行内代码仍属于文字链接，不会因为不是纯文本就误变成卡片。业务引用可以使用标准完整、折叠或快捷引用定义，例如：

```markdown
[说明][file]

[file]: att://docs/a.pdf "附件说明"
```

解析遵循实际生效的定义：标签大小写和空白归一化、首个定义优先，未使用或被遮蔽的定义不形成依赖。代码、HTML 属性／注释及不解析 Markdown 的原始 HTML 区域不参与业务引用扫描。

旧相对附件写法和 `@标题` 不再被推断为在线业务引用，也不添加『旧引用写法已停用』一类诊断。历史数据升级属于离线[迁移流程](../../operations/content-cutover.md)，不是输入时自动猜测替换。

## 启用的语法

基础语法包括标题、段落、强调、删除线、列表、引用、分隔线、代码和标准链接／图片。裸 URL 不自动链接；围栏代码只展示，不执行 Mermaid、公式或程序。任务列表不会自动变成可交互复选框。

表格由 `markdown-it-multimd-table` 提供：支持当前配置的合并单元格、多表体和 caption，未启用的插件能力不构成项目支持范围。五种提示框使用引用首行 `[!NOTE]`、`[!TIP]`、`[!IMPORTANT]`、`[!WARNING]`、`[!CAUTION]`；标记大小写敏感，同行余文作为纯文本标题。

允许白名单内的静态 HTML，完整普通块容器可递归渲染内部 Markdown，表格和代码容器沿用专门解析边界。正文展示与编辑预览的最终 HTML（包括行内输出和业务插件输出）统一经过 `sanitize-html` 净化：禁止 script、iframe、SVG/MathML、嵌入对象和事件处理属性，拒绝可执行 URL 协议；样式只保留有限排版属性和受控图片占位。脚本或 iframe 不会执行，也不提供放行开关。HTML 结构诊断只负责语法提示，不替代此渲染出口的安全策略。

`<good>…</good>` 表示机密片段，支持现有行内、块和嵌套规则。无权限时服务端先生成删减正文，不能只靠 CSS 隐藏；完整合同见[访问控制](access.md)。

## 图片与卡片

独占段落的连续图片组成 carousel，单图也使用相同结构。caption 读取图片标签中的说明，按现有规则处理空标签、文件名重复和行内格式。图片区域加载失败或引用无效时以占位符替代，外围图片项和 caption 规则保持不变。

图片与其他元素同段混排时，caption 行为未定义为独立 carousel 的同等合同；当前保留现状。不能据此假定所有 Markdown 图片都会生成 caption。

文件、机密附件、删减表示、档案及失效卡片复用共享布局和展示数据。机密附件是否有可读像素由服务端投影决定。Bilibili 无标签链接交给[视频卡片集成](../integrations.md)。

## 诊断、改写与预览

编辑器汇总元数据／引用、HTML 结构和 markdownlint 诊断。附件或档案目标不存在属于 warning，不因悬空引用本身升级成 error；其他结构或业务校验仍可能阻止保存。全屏和非全屏复用同一诊断列表。

引用目标改写保留标签、title、定义 ID、换行和缩进，只产生必要的目标补丁。解析位置映射回原始 UTF-16 字符位置，中文、emoji 和 CRLF 不应导致偏移。删除保护、改名／移动、标题更新及草稿历史重放使用同一套引用语义。

编辑预览将纯渲染与 DOM 增强分开：图片加载、轮播、灯箱和标题定位在 DOM 生命周期中安装／清理，未变化媒体节点尽量保留。『天子上朝』使用当前用户实际可读表示，『微服私访』生成无机密权限的预览，不提升真实读取授权。

## 源码、验证与已知差异

- 语法和元数据：[`content-markdown.ts`](../../../server/shared/content-markdown.ts)、[`content-markdown-syntax.ts`](../../../server/shared/content-markdown-syntax.ts)。
- 引用：[`content-reference-definitions.ts`](../../../server/shared/content-reference-definitions.ts)、[`content-reference-replay.ts`](../../../server/shared/content-reference-replay.ts)。
- 渲染：[`app/utils/content/markdown/`](../../../app/utils/content/markdown/)，预览编排：[`useStoryPreview.ts`](../../../app/composables/useStoryPreview.ts)、[`useStoryPreviewBody.ts`](../../../app/composables/useStoryPreviewBody.ts)。
- 自动测试覆盖语法、引用定义、原始 HTML 边界、文字／卡片分支、权限表示和引用改写。浏览器需验证布局、caption、图片加载和连续输入时的媒体复用。

已知差异：渲染器支持的 Setext 标题和表格扩展，并未全部对应 CodeMirror 的着色／语法树；当前不为此统一重写所有解析器。
