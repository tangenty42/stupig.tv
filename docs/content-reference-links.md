# 正文引用语法：`att://` 与 `content://`

状态：引用语法、转换、草稿 v3、渲染、lint 和补全已实施；命名空间及标题日志、草稿服务端替换和保存重放尚未实施，详见[执行记录](./content-refactor-progress.md)。本文是[附件工作区重构提案](./attachment-workspace-refactor.md)的配套文档，定义正文中附件和档案的引用写法、解析与改写、旧写法迁移、lint 规则以及编辑器 `@` 补全。命名空间日志和保存兜底见主文档 §4.2。

## 1. 目标

- 附件和档案引用都使用显式 scheme，不再根据“无 scheme 的相对路径”或 `@` 前缀推断类型。
- 服务端校验、引用改写、预览渲染、补全和 lint 共用 `@shared` 中同一个解析／格式化入口，不再在各文件分别维护触发规则。
- 文件和文件夹的改名、移动使用同一套改写逻辑，同一批变更一次替换完成。

## 2. 语法

| 构造 | 写法 | 渲染（规则与现状一致，只是识别方式改变） |
| --- | --- | --- |
| 附件文件 | `[](att://docs/a.pdf)`、`[说明](att://docs/a.pdf)` | 无标签时渲染文件卡片，有标签时渲染普通链接 |
| 附件图片 | `![](att://img/a.png)` | 图片 |
| 文件夹卡片 | `[](att://cards)` | 文件夹卡片 |
| 文件夹图片展开 | `![](att://cards)` | 展开为文件夹内的图片 |
| 档案引用 | `[](content://标题)`、`[文字](content://标题)` | 无标签时渲染档案卡片，有标签时渲染指向档案的普通链接 |
| 封面 | `cover: ![](att://cover.jpg)` 或外链 | 同现状；数据库 `cover` 列只存不带前缀的路径，`coverMaxBytes` 不计前缀 |

- 只识别小写的 `att://` 和 `content://`。其他大小写给出 lint 警告和快速修复。
- `att://` 之后的整段是路径：以 `/` 分段，不能有空段，不能以 `/` 开头。末尾的 `/` 可写可不写，表示同一路径；规范写法不带。文件和文件夹共用命名空间（主文档 §4.1），不需要用尾斜杠区分类型，也没有“同名文件优先”的规则。
- `content://` 之后是档案标题，大小写不敏感匹配（与现状一致）。标题不能包含 `/`，因此 `content://a/b` 为 lint 错误，此形式保留给以后使用。
- 附件名称和档案标题都遵守 `link_file_name_illegal_chars`，已排除 `<>:"?*|()[]\/#@&=%`、空白、反引号和控制字符，写入时无需编码。markdown-it 会对非 ASCII 字符做百分号编码（已验证 `att://图片/a.png` → `att://%E5%9B%BE%E7%89%87/a.png`；大小写和 `.` 保持不变，自定义 scheme 不做 punycode）。因此统一在解码后再匹配，这一点与现状相同。
- 原始 HTML（`<a href>`、`<img src>`）和代码块、行内代码中的内容不解析（与现状一致）。`#锚点`、`http(s)://`、`mailto:` 等其他目标保持不变。
- 路径一律按原始字符串解析，不经过 `new URL()`，否则 `att://folder/x` 的第一段会被当成 host。
- scheme 名称是方言常量，不进入配置，因为已保存的正文依赖它。

## 3. 单一解析／格式化入口

放在 `server/shared/`（浏览器安全）：

```ts
type ContentRef
  = | { kind: 'attachment', path: string } // 已解码，已去掉末尾 /
    | { kind: 'story', title: string }
    | { kind: 'legacy_attachment', path: string } // 兼容期：无 scheme 的相对路径
    | { kind: 'legacy_story', title: string } // 兼容期：@标题

declare function parse_content_ref(destination: string): ContentRef | null
declare function format_attachment_ref(path: string): string // 'att://' + path
declare function format_story_ref(title: string): string // 'content://' + title
```

以下现有实现收敛到这个入口：

- 服务端：`attachment_name_from_url`、`attachment_markdown_path`、`extract_attachment_names`、`rename_attachment_references`、`extract_story_reference_titles`、`rename_story_references`，以及封面行解析。
- 客户端：`links.ts` 中的 `is_bare_file_url`、`local_file_name`、`decode_story_title`、`resolve_content_url`，`completions.ts` 中的 `story_at_patterns`、`attachment_dest_pattern` 等正则，以及拖拽和复制所用的 `content_attachment_markdown`、`content_folder_markdown`。

引用构造登记到方言清单（旧任务文档 §12/§13.3 提出的 `content-dialect.ts`），即 `attachment_ref`、`folder_ref`、`story_ref` 三项，由清单完整性测试守护。这样也解决了旧文档提到的缺口：`@` token 和目录简写的触发规则在多个文件中各写一份。

## 4. 引用改写

`rewrite_content_refs(markdown, steps)`：

- `steps` 是有序的若干步，每一步是一组映射：文件映射为 `path → path`，文件夹映射为前缀 `dir → dir`。
- **步内一次性同时替换**：每个引用只按改写前的值查一次映射，因此链式移动（`X/n → Y`、`Y/n → Z`）不会串改。现有实现逐对顺序替换，会出现这个问题。
- 步与步之间按顺序执行，对应命名空间日志中的先后操作。
- 文件夹映射同时改写 `att://a` 本身以及 `att://a/...` 子路径。现有的 `apply_folder_rename` 不改文件夹引用，这次一并修正。
- 默认标签等于旧名称时一起改写，图片标签中嵌套的链接递归处理（沿用现有语义）。
- 已入库正文改写、草稿引用替换接口和保存兜底重放都在服务端调用同一个函数，保证三处结果一致。attachment list 更新后，前端若持有 draft，主动提交草稿快照及版本基线给服务端；客户端只负责安全应用返回的变化区间，不拉取日志自行改写（主文档 §4.2）。
- 档案标题级联沿用同一族函数，把 `content://旧标题` 改成 `content://新标题`。

## 5. 迁移与兼容期

- **语法转换器** `upgrade_legacy_refs(markdown)`：把旧附件解析器能识别的相对路径目标改为 `att://`，把 `@标题` 改为 `content://标题`，封面行同样处理。转换只依赖语法，不需要附件列表，且可以重复执行。
- **存量数据**：在 `scripts/` 下新增一个一次性脚本（与 `cleanup-orphan-attachments.ts` 同类）。
  - 默认 dry-run，输出每篇档案的改写统计。
  - `--apply` 时逐篇档案加 `FOR UPDATE` 改写，不抬正文 revision，并发布刷新事件。
  - 不能写成 SQL 迁移，因为 SQL 无法解析 markdown。
  - 在切换步骤中执行，可以重复执行。
- **浏览器草稿**：`content.draft.schemaVersion` 升到 3。`read_persisted` 读到 v2 草稿时先用同一个转换器升级，不再直接删除；升级后的草稿 `base_namespace_revision` 与 `base_title_revision`（§7）记为未知，按主文档 §4.2 中“基线不可用”的规则处理。
- **兼容开关** `app.content.reference.legacyCompat`（布尔，默认 `true`，作为配置项提案）：
  - `true`：服务端保存时先对传入的正文执行 `upgrade_legacy_refs`，再做校验和写入。这样切换前已打开的旧版前端仍能正常保存。
  - `false`（下一个发布周期关闭）：服务端不再转换。`parse_content_ref` 返回 `legacy_*` 的目标是错误：编辑器 lint 报错，有同名附件或同名档案时提供快速修复；服务端拒绝保存（400 `LEGACY_REF`，列出行号）。关闭前用脚本 dry-run 确认已保存正文中的旧写法为 0。
  - 渲染端不需要兼容旧写法：存量数据已由脚本转换，草稿在读取时升级，旧版前端的保存由服务端转换。

## 6. 编辑器 `@` 补全

### 6.1 触发

| 光标前的内容 | 补全列表 |
| --- | --- |
| 行首、空白或 `(` 之后的 `@query`（不在链接目标内） | 档案区 + 附件区（附件只列顶层） |
| `[](@query`、`![](@query` | 同上 |
| `](att://a/b/` + query | 只有附件区：`a/b` 的直接子项 |
| `](att://` + query | 只有附件区：顶层 |
| `](content://` + query | 只有档案区 |
| 空目标 `[](`、`![](` 上手动按 Ctrl+Space | 同 `@` |
| 自动补出 `)` 后，光标在 `[]()`、`![]()` 的空目标内 | 同 `@`，自动触发 |

- 只输入未闭合的 `[](` 不自动弹出列表；自动补出右括号、光标位于空目标内时自动弹出档案和附件列表。
- 下钻：`from` 定在最后一个 `/` 之后，`validFor` 为 `/^[^/)\s<>]*$/`。再输入 `/` 时会重新查询，列出下一级。
- 档案补全的 `label` 带 `@` 前缀以便过滤，`displayLabel` 不带。附件在 `@` 位置同样处理；下钻时 `label` 就是子项名称。
- 排除当前档案自身（自引用是 lint 错误）。未提交的上传预约不出现在列表中，因为正文不能插入未提交的对象（主文档 §5.1）。
- `a@b` 这类写法不触发，必须有边界（与现状一致）。

### 6.2 选中后的展开

| 选中项 | 在裸 `@` 位置 | 在 `[](@…`、`![](@…`、`](att://…`、`](content://…` 中 |
| --- | --- | --- |
| 档案 | `[](content://标题)`，光标放在 `)` 之后 | 只替换 `@query`／scheme 后的 query，光标放在 `)` 之后 |
| 图片文件 | `![](att://a.png)`，光标放在 `)` 之后 | 同上，不增删 `!` |
| 其他文件 | `[](att://a.pdf)`，光标放在 `)` 之后 | 同上 |
| 文件夹 | `[](att://cards)`，光标停在 `cards` 之后、`)` 之前 | 同上，光标停在 `)` 之前 |
| 下钻子项 | — | 只替换最后一个 `/` 之后的 query |

- 文件夹的光标位置让用户接着输入 `/` 就能下钻。要把文件夹展开成图片，由用户自己补 `!`。
- 与 `closeBrackets` 配合：如果光标后已有 `)`，复用它，不叠加第二个 `)`（与现有标签补全的处理一致）。
- 补全、拖拽和“复制 Markdown 代码”三个入口共用 `format_*_ref` 和 `content_attachment_markdown`，生成的文本完全相同。

### 6.3 菜单 UI

- 用 CodeMirror 的 `Completion.section`（`CompletionSection { name, header?, rank? }`，已确认当前依赖的 `@codemirror/autocomplete` 6.20.3 支持）分区。档案区 `rank: 0`，附件区 `rank: 1`，两者固定，不使用 `'dynamic'`，以免输入时分区跳动。只在有内容时显示该分区。
- 由同一个 `reference_completion_source` 返回两个分区的选项，共用一个 `from`。
- 视觉与附件列表的右键菜单（`Card.vue` 中的 PrimeVue `ContextMenu`）保持一致：
  - 容器、条目内边距、圆角、悬停／焦点颜色和分隔线取自 `--p-contextmenu-*` design token，替换 `Editor.vue` 中 `.cm-tooltip-autocomplete` 目前硬写的 Tailwind 值。选中行使用 ContextMenu 的焦点样式，不再使用 primary 实色填充。
  - 图标列使用 lucide 图标（沿用 `completion_icon_by_type`），尺寸与 ContextMenu 的 `itemicon` 相同。
  - 分区之间的分隔线与 ContextMenu 的 `separator` 相同；分区头显示一个小号、弱化的名称（“蠢猪档案”／“附件”），因为列表会滚动，单靠分隔线难以分辨当前分区。
  - 文件夹行末尾显示 `lucide:chevron-right`，样式同子菜单指示，提示可以用 `/` 下钻。新图标需要登记到 `completion_icon_names`，由已有的图标登记守卫测试覆盖。
  - 右侧说明列：档案显示评级；附件显示 图片／附件／机密附件／文件夹。
- 标签补全和 alert 标记补全使用同一套样式，只有一个分区，不显示分区头。
- 键盘：↑／↓ 可以跨分区移动，Enter／Tab 应用，Esc 关闭。不新增按键绑定。

### 6.4 lint

| 情况 | 级别 |
| --- | --- |
| `att://` 路径不存在 | 警告（失效链接），允许保存 |
| `content://` 标题不存在、引用自身 | 错误（与现在 `@标题` 的规则一致） |
| `content://` 中含 `/` | 错误 |
| scheme 大小写不对 | 警告 + 快速修复 |
| 兼容期后的旧写法 | 错误，服务端拒绝保存；有同名目标时提供快速修复（见 §5） |

## 7. 档案标题改名

标题改名与附件改名、移动走同一条路径：已保存正文在同一事务内级联改写，前端主动提交草稿给服务端替换并安全应用结果，保存时服务端重放兜底（主文档 §4.2）。区别是标题属于全站命名空间，版本和日志不按档案划分。

- **标题版本与锁**：单行表（例如 `content_title_namespace`）保存全站单调递增的 `title_revision`，同时作为标题锁。改标题、删除档案时取 `FOR UPDATE`；其他保存取 `FOR SHARE`，彼此不阻塞。两者都先取标题锁、再取档案行锁（主文档 §5.2），避免与级联改写互相等待。只靠档案行锁会漏掉“本篇保存”与“他篇改标题”交错的情况。
- **标题日志**：改名、删除在同一事务内写入 `content_story_title_journal(title_revision, story_id, op, from_title, to_title, created_at)`，`op` 为 `rename`／`delete`。新建档案不写日志。保留期与附件命名空间日志共用 `reference.journalRetentionDays`。
- **已保存正文**：沿用现有级联。同一事务内对引用方正文执行 `rewrite_content_refs` 的标题步骤，引用方行 `FOR UPDATE`，不抬其 revision；正文变化时发布正文资源事件。`related_story_ids` 改为基于 `content://` 提取。
- **前端草稿**：档案列表资源（编辑器 lint 已用它取 `existing_titles`）附带当前 `title_revision`。列表更新且版本高于草稿基线（或基线未知）后，持有草稿的编辑器调用与附件相同的草稿引用替换接口，提交最新正文及两条基线；服务端读取标题日志并同源替换，返回实际处理到的版本。客户端按主文档 §4.2 的快照校验规则应用结果，再推进已成功重放的 `base_title_revision`；标题与附件更新共用同一草稿请求编排，避免两个响应互相覆盖。
- **保存兜底**：`update_story` 同时携带 `base_title_revision`。服务端在锁内按序重放基线之后的标题日志，再按现有规则校验（标题不存在、自引用仍是错误）。引用的标题在基线之后被删除、当前又属于另一篇档案时，草稿替换和保存均与附件相同返回 409 `REF_TARGET_REPLACED`，替换失败不推进基线。基线早于保留期或未知时不重放，草稿替换标记基线不可用，保存按现有规则校验。
- 标题匹配沿用现状的大小写不敏感规则，级联、重放和 lint 使用同一个比较函数。

## 8. 测试

- 解析／格式化：大小写、末尾 `/`、百分号编码与中文、嵌套标签、`<…>` 目标、title 属性、代码块和行内代码、原始 HTML 不解析。
- 改写：文件、文件夹前缀、一步内的链式移动、多步顺序、默认标签改写、重复执行结果不变。
- 渲染等价：在旧渲染器上，`att://` 写法与旧写法输出相同的 HTML（快照对比）。
- 转换器：可重复执行，不改动 `http(s)`、`#`、`mailto:`、代码内容和原始 HTML。
- 补全：触发矩阵、分区归属、下钻只列直接子项、文件夹的光标位置、各类展开文本、与 `closeBrackets` 的配合。
- 草稿 v2 → v3 升级不丢引用。
- 草稿替换接口与已入库正文、保存兜底的同源结果一致；附件／档案列表更新后有 draft 才主动提交，客户端不请求日志自行替换；请求期间继续输入、保存或切换编辑上下文后旧响应作废；重复版本不重复请求，失败不修改正文或基线，基线不可用不循环请求。
- 兼容开关关闭后，旧写法被拒绝保存并列出行号。
- 标题日志：链式改名（`A → B`、`B → C`）和先后互换按序重放；删除后同名新建返回 `REF_TARGET_REPLACED`；基线不可用时不重放；保存与改标题并发不留下失效引用（集成测试，不只 mock 数据库）。
- 现有测试中 `![](cards)` 等字面量 fixture 改为 `att://` 写法；这类改动属于预期内的语法变更，不是放宽断言。
