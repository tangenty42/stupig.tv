# AGENT-DESIGN：引用的实现

- 本文档状态：PENDING（初稿，待人类审阅）
- 覆盖范围：引用写法的解析、改名跟随、引用历史、删除前的引用确认
- 对应 LAW：[SID#2.4.3.LAW](LAW.md)；总则见 [SID#2.4.AGENT-DESIGN](../AGENT-DESIGN.md)；卡片外观和失效占位见 `2_markdown`

## 入口

| 位置 | 内容 |
| --- | --- |
| `server/shared/content-reference.ts` | 解析 `att://`、`content://`，名字比较键，非法字符 |
| `server/shared/content-markdown.ts` | 提取引用、按改名批量改写（`rewrite_content_refs`）、引用检查 |
| `server/shared/content-reference-replay.ts` | 按引用历史重放改名 |
| `server/shared/content-reference-definitions*.ts` | 引用式链接定义（`[x]: att://…`）的处理 |
| `server/shared/content-delete-impact.ts` | 在 Markdown 里找指向待删目标的引用 |
| `server/services/content/reference-history.service.ts` | 附件改名、档案改标题时写引用历史并改写正式版和云端草稿；保存时补改 |
| `server/services/content/reference-journal.repository.ts` | 引用历史的读写与清理 |
| `server/services/content/delete-impact.service.ts` | 删除前的引用确认接口 |
| `app/components/MyContent/DeleteImpact.vue` | 删除对话框里的引用列表 |
| `app/pages/content/[id]/edit.vue` | “引用历史不可用”对话框 |

## 写法细则

- 比较名字时先做 NFC 归一化，再转小写，所以不分大小写；
- 名字不能为空，也不能含空白、控制字符和 `<>:"?*|()[]\/#@&=%` 及反引号；含了就不算引用；
- 链接里的 `?…`、`#…` 原样保留，不参与比较；
- 不带协议的相对路径和旧版 `@标题` 都不算引用，按普通链接原样输出（2026-11-15 起不再支持旧写法）；
- `att://` 只在所属档案内解析；`content://` 在全部档案里按标题查找；
- 引用式链接支持完整、折叠、简写三种用法，标签可以带强调和行内代码；同一标签有多处定义时第一处生效，没用到或被遮蔽的定义不算依赖（`content-reference-definitions-live.ts`）。

## 附件未引用标记

[引用索引](../../../../server/shared/content-markdown.ts)复用正文链接扫描，按完整路径计入当前正文的有效引用和 `cover:`。空标签的文件夹卡片覆盖其子树，带标签的文件夹链接只计入文件夹本身。图片引用只匹配附件文件，引用过的条目也会标记其祖先目录。代码示例和未使用的链接定义不计入。

机密附件完整版被计为引用时，其当前存在的删减版也计为被间接引用。文件夹引用已覆盖到的完整版同样适用，覆盖范围沿用原规则。关系只从完整版传向删减版，直接引用删减版不会反向标记完整版。配对沿用现有附件删减版关系，不修改 Markdown 或插入额外链接。

编辑页以本页 Markdown 为准，未保存的修改也会刷新侧栏和已打开的补全列表。未引用的存量文件和文件夹在行尾显示紫色断链图标，悬停及读屏提示『当前草稿未引用』。详情页使用正式版正文和封面，提示『未引用』；正文被裁剪时不作未引用判断。

## 改名跟随与引用历史

| 范围 | 版本号 | 清理下限 | 说明 |
| --- | --- | --- | --- |
| 某篇档案的附件 | `content_stories.namespace_revision` | `namespace_floor` | 每次附件操作写一批，空批也写 |
| 全站档案标题 | `content_title_namespace.revision` | `revision_floor` | 改标题写一批 |

- 记录都存在 `content_reference_journals` 表，`scope_id` 为 0 表示标题，否则为档案 id；
- 一次操作是一批，批内同时生效，所以两个名字对调时不会串；文件夹改名时里面的路径一起改；
- 附件改名在同一事务里改写本档案的正式版、封面和云端草稿；改标题时扫描全部档案的正式版和全部云端草稿；
- 编辑页记下打开时的两个版本号。保存时按这之后的记录补改草稿；
- 每个范围最多保留 `app.content.reference.journalBatchLimit`（默认 200）批，更早的会被删除并抬高下限。草稿的版本号低于下限时补改不了，编辑页弹“引用历史不可用”，用户确认后按当前内容保存；
- 附件历史缺批时报 503“附件引用历史不完整”，不会静默跳过；只有标题范围（`scope_id` 为 0）不检查批次是否连续（`reference-journal.repository.ts`）；
- 改写只换目标和真正的默认文字：原大小写、`?…`、`#…`、格式和自定义的链接文字都保留；简写或折叠的引用式链接要改名时，显式保留原定义 id（`content-reference-replay.ts`）；
- 云端草稿被机械改写时只加 `draft_revision`，不占正式版的版本号；档案只加 `namespace_revision`，`updated_at` 不变；
- 编辑器收到改写时，`apply_reference_changes` 先核对原文还对得上，再只替换涉及的片段，其他文字不动；补丁本身不进撤销历史，已有的撤销历史保留；迟到回包由 `draft.store.ts` 按页面代次丢弃。

## 删除前的引用确认

- 接口：`get_delete_impact`，返回 `targets`、`sources`（每篇档案的 `story_id`、`title`、`references[{target,line,effect}]`）、`cloud_draft_references`；
- 删档案时查其他所有档案；删附件时只查本档案，另外查一次存储的封面，行号记为 0；
- 图片语法指向目录时跳过该引用。链接定义同时被图片和普通链接使用时，按普通链接检查目录影响。
- 删除删减版时，指向其完整版的有效引用也计入受影响范围，沿用原引用的位置。正式版、云端草稿和当前未保存的修改使用同一单向规则，权限裁剪规则照常。
- 没有『机密可读』权限时，先去掉机密内容再查，行号映射回原文；机密封面不查；云端草稿也不查；
- 删除整篇档案和附件都先在原删除入口发起引用检查，等待时入口显示加载状态并禁用。成功取得结果后才打开『空城计？』。失败显示 Toast『引用检查失败，请重试后再删除』，用户从原删除入口重试。
- “空城计？”先提示尚未删除，只显示命中的『正文引用』和『草稿引用』，两组无折叠按钮；
- 删档案时，正文引用按篇缩进列出档案链接和位置。链接复用 `.link`，带档案图标，在新标签页打开。删附件时只显示本篇的位置。云端草稿命中时在『草稿引用』标题右侧显示『有引用』，本页未保存的修改中的引用位置在同组另列一行。同一来源显示首个正文行号，有其他正文行时写『第 X 行等』，封面引用另标『封面』；
- 只提示，不阻止，也不自动改写 Markdown。被直接引用的目标删除后，原引用显示“渲染失败”占位，之后再出现同名目标时，原引用直接指向它。删减版仅被间接引用时，删除它不删除对应完整版。
