# AGENT-DESIGN：全项目工程约定

- 本文档状态：DONE
- 覆盖范围：全项目协作、文档维护、作者内容保护、格式及代码复用
- 依据：[SID#README](../README.md)
- 迁移基线：2026-11-11 20:55:43 +08:00（Asia/Shanghai），提交 `722c1cd3392cb4cdb5c8b051f3354c8e3905e355` 及未提交工作区

本文件承接原仓库级及按路径加载的协作与格式规则。架构、业务及操作按 [项目指引](../../AGENTS.md) 查阅所属文档。

## 协作与文档维护

- 涉及依赖、数据库结构、部署配置或大范围重构时，先说明影响和方案，取得授权再改。已授权的范围继续执行。删除或重建文件须有用户授权，替换或重组相关文件的请求可涵盖该操作。
- 保留工作区内无关改动，控制差异范围。结合代码和会话自行处理日常实现细节，遇到影响后续工作的重要歧义再问人类。若运行模式会跳过交互提问，把必须回答的问题放在回复末尾，等人类答复。
- 文档写清当前可观察的行为，链接所属源码、配置或策略，标出尚未实现的工作和未验证的部署状态。核对事实时优先看源码、已验证配置及可执行策略。发现它们与 LAW 或 DESIGN 不符，提出偏差，由人类裁定。
- 每项要求由所属文档维护。操作步骤归 [工作流程](../1_workflows/DESIGN.md)。旧文档 `docs-legacy/` 已于 2026-11-19 删除，历史实现、运维经验和原始证据的原文在 git tag `docs-legacy-final`，使用前核对适用版本与验证范围。[迁移进度](../AGENT.md)记录已承接的内容和剩余事项。

## 作者内容与保护标记

保留作者在注释及 README 中的原话、`POV`、玩笑、排障故事和配图。重写、翻译、清理或重构周边内容时先查 Git 历史，恢复误删的原文。事实需要更新时可以另加说明。

以下标记区分大小写，按原样保留：

- `THIS IS A GOOD COMMENT BEGIN` / `THIS IS A GOOD COMMENT END` 用所在语言的注释语法包住受保护的注释或相邻注释块。标记外的运行代码不在这对标记的保护范围内。
- `THIS IS A GOOD SECTION BEGIN` / `THIS IS A GOOD SECTION END` 包住受保护的文档段落，包括标题和配图引用。Markdown 使用 HTML 注释隐藏标记。
- `THIS IS A GOOD DOCUMENT` 在文件开头的注释中出现一次，保护整份文档，无需结束标记。

修改包含标记的文件前先搜索 `THIS IS A GOOD`，核对是否触及保护范围或其关联图片。成对标记须完整，不按标题层级推测结束位置。删除、重写、翻译、格式化、移动或自动修复受保护内容及关联资产前，先说明具体改动、范围和原因，取得人类对此处内容及操作的明确授权。一般的重构、改文档、退役、提交或部署授权不涵盖这些操作。待确认期间继续处理不受影响的工作。淘汰旧实现时如需迁移作者原话，也先给出保留位置和方案，不删除容器文件或图片绕过保护。

```ts
// THIS IS A GOOD COMMENT BEGIN
// POV: the author's original comment stays here.
// THIS IS A GOOD COMMENT END
```

```md
<!-- THIS IS A GOOD SECTION BEGIN -->
## The author's original section

Original prose and images stay here.
<!-- THIS IS A GOOD SECTION END -->
```

```md
<!-- THIS IS A GOOD DOCUMENT -->
# The author's original document
```

## 格式与代码复用

[ESLint](../../eslint.config.mjs) 使用 Antfu flat config，是项目唯一的格式化工具。用 `pnpm lint` 检查，用 `pnpm lint --fix` 修复。提交钩子通过 lint-staged 处理匹配的暂存文件，VS Code 可在保存时修复。只修需要变更的范围，不引入 Prettier。

- 两空格缩进、单引号、无分号、保留尾逗号。
- 一元运算符和展开／剩余运算符之后留空格，如 `! x`、`- x`、`typeof x`、`... value`。模板插值内部不留空格。
- Vue 模板 props 使用 kebab-case，SFC 块按 template、script、style 排列。props 和 emits 的 snake_case 写法有意保留。
- 对 import 排序，删除未用的导入和变量。有意保留的未用参数用 `_` 前缀。可推断的变量和函数返回类型无需注解，有意定义约束或契约时可以显式标注。
- 服务端允许 `process`、`Buffer` 和 `console` 日志，保留现有 ESLint 例外。Markdown 允许多个 H1，新手册优先使用一个明确标题。Markdown 专用例外只作用于 Markdown。
- 新增工具、共享模块、composable 或格式化与解析逻辑前先找现有实现，在原有模块中扩展。稳定限制和部署值放在所属配置中。[开发配置](../1_workflows/1_develop/AGENT-DESIGN.md#配置实际从哪里来)说明配置边界和生成方式。
- 测试代码遵循相同格式。修复 lint 时保留断言及文件覆盖范围，确实无法遵守的个别规则才用带 `-- reason` 的 `eslint-disable-next-line`。按 [测试补充](../1_workflows/2_test/AGENT-DESIGN.md)选择验证范围。

## 注释与说明

- 在所属代码旁解释难以看出的原因、不变量、兼容约束和失败边界。JSDoc 用来说明有用的 API 契约，普通注释说明局部取舍。避免复述代码、类型和明显动作。
- 行为变化时同步更新技术说明。TODO 写剩余工作及相关限制或问题，已完成记录放到相应 AGENT。保留原文语言及作者表达，新写内容沿用所在文档语言。
