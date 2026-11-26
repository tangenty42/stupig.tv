# AGENT：引用的裁定、出入与待办

- 本文档状态：PENDING（初稿，待人类审阅）
- 覆盖范围：本目录的人类裁定、落实与验证、出入和待办
- 旧文档：`docs-legacy/` 已于 2026-11-19 删除；本文提到的旧手册、旧台账以及“留在原文”的内容，原文都在 git tag `docs-legacy-final`
- 核对范围：读了引用解析、引用历史、删除影响的代码；运行了 `server/shared`、`server/services/content`、`app/features/content/markdown` 的单元测试
- 实现设计：[SID#2.4.3.AGENT-DESIGN](AGENT-DESIGN.md)

## 人类裁定

| 原话或要点 | 落实 |
| --- | --- |
| 删除对话框列出引用位置 | 已改代码，见下 |
| 对话框标题“空城计？”保持 | 现状 |
| 档案列表最后按标题文字排序，不看修改时间 | 已改代码，见下 |
| 附件只能被本档案引用 | 现状 |
| 旧写法已没有存量，“直接终止支持” | 已改代码，见下 |
| 人类写了正式 [LAW](LAW.md)，Agent 审查通过 | 草稿已删除 |
| 2026-11-25：引用机密附件完整版时，其对应的删减版也视为被引用 | 编辑器侧栏、补全、详情和删除检查均计入这条单向引用 |

建议人类在 [LAW『引用写法』](LAW.md#引用写法)的链接表后补充一条。引用机密附件完整版时，其对应的删减版也视为被引用。

## 落实与验证

2026-11-19 为引用历史测试的附件夹具明确文件夹可有空对象键、节点可带机密标记；复核每个范围只保留 200 批、只有附件范围要求连续。`pnpm exec vitest run server/services/content/draft.service.test.ts server/services/content/reference-history.service.test.ts` 共 32 项通过。

| 改动 | 验证 |
| --- | --- |
| `DeleteImpact.vue` 列出每篇引用的档案和行号，封面写作“封面” | 组件测试 5 项通过；eslint、vue-tsc 通过 |
| 2026-11-22：[附件未引用标记](AGENT-DESIGN.md#附件未引用标记)共用当前 Markdown 和封面的引用索引，侧栏及已打开的补全实时更新 | 定向单测 193 项、组件测试 40 项通过，未跑浏览器验收 |
| 2026-11-25：完整版引用同时覆盖现存删减版的引用状态，删减版删除检查也计入完整版引用 | 定向单测 185 项、组件测试 59 项通过，待人工验收 |
| `pages/content/index.vue` 最后按标题 `localeCompare(…, 'zh-CN')` 排序 | eslint、vue-tsc 通过 |
| 删除 `legacy_*` 引用类型、`parse_migration_ref`、`upgrade_legacy_refs` 和 `reference-migration.service.ts`；相对路径改为按普通链接原样输出 | 上述三处单元测试 984 项通过；eslint、vue-tsc 通过 |

## 代码与 LAW 的出入

没有发现。

## 待办

| 事项 | 完成条件 |
| --- | --- |
| 人类截图确认删除对话框的列表外观 | `pnpm dev` 下删一个被引用的档案 |

## 旧资料去向

2026-11-19 逐章对照源码后记录；仍成立的实现细节已补进 AGENT-DESIGN。

| 来源 | 去向 |
| --- | --- |
| 旧 Markdown 手册（`docs-legacy/modules/content/markdown.md`）『业务引用』 | AGENT-DESIGN『写法细则』『改名跟随与引用历史』 |
| 旧草稿手册（`docs-legacy/modules/content/drafts.md`）『三类版本』『异步重放』『引用历史维护』 | AGENT-DESIGN『改名跟随与引用历史』『删除前的引用确认』；升级迁移归 `SID#1.4` |
