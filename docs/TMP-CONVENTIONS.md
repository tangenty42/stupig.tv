# TMP：实现传统迁入 AGENT 文档的计划

- 本文档状态：PENDING
- 覆盖范围：`.github/copilot-instructions.md`、`.github/instructions/*.instructions.md`、`AGENTS.md` 中的工程约定，以及承接这些约定的 Swordoc 文档

## 目标

- DESIGN 只记录架构层面的设计与取舍，不承载底层实现细节；
- 底层实现约定（以下称『传统』）集中记录在 AGENT 文档的「传统」一节，由 Agent 维护，增删改须经人类同意；
- `*.instructions.md` 不再承载约定正文，只保留指向 Swordoc 的入口，以维持编辑器按路径自动加载的能力。

## 宪章补充（候选，须人类写入 SID#README）

AGENT 文档一节补充：

> AGENT 文档可包含「传统」一节，记录实现层面的约定。Agent 应遵守这些传统；增、删、改任何一条前须向人类说明理由并得到明确同意，并在条目中注明批准依据。「传统」与 LAW、DESIGN 冲突时，以 LAW、DESIGN 为准。

AGENT 文档建议结构补充：

```markdown
## 传统

<!-- 实现层面的约定；增删改须经人类同意，并注明依据 -->

| 传统 | 原因 | 依据 |
| --- | --- | --- |
| <!-- 约定内容 --> | <!-- 为什么这样做 --> | <!-- 人类同意的日期与方式 --> |
```

## 传统的维护规则

- 每条传统写明内容、原因与依据；依据为人类同意的日期及方式（如对话确认、PR 评审）；
- Agent 发现需要增删改传统时，先向人类提出：改什么、为什么、影响哪些代码；得到同意后再修改，并在同一次改动中更新依据；
- PR 描述的 `Changes` 中单列传统的增删改；评审时核对每条改动均有对应依据；
- 传统只写可执行的约定，不写架构取舍；涉及架构的内容提交人类决定是否写入 DESIGN。

## 放置位置

| 内容 | 去处 |
| --- | --- |
| 全站通用的实现传统，如 UTC、`tinyint(1)` 转换、别名、`ApiError`、`server/shared` 浏览器安全、注释与受保护内容标记 | `SID#0.AGENT`（`docs/0_overall/AGENT.md`，新建）「传统」 |
| 工作流程传统，如 pnpm、开发服务、测试分层、迁移、Git 与 PR | `SID#1.AGENT`（`docs/1_workflows/AGENT.md`，新建）「传统」 |
| 某一业务专用的传统，如蠢猪档案写入入 outbox | 对应 `2_domains` 业务目录的 AGENT「传统」；业务目录建立前暂存于 `SID#2.AGENT` |
| 架构层面的设计与取舍 | 对应 DESIGN；由 Agent 起草候选，人类决定是否采用 |
| Agent 踩坑记录，如沙箱回环限制、PowerShell 管道破坏中文编码 | 对应 AGENT「工作经验」 |

按宪章，祖先目录的文档自动适用于子目录，`SID#0.AGENT` 的传统对全项目生效。`docs/AGENT.md` 继续只记录文档迁移进度，不承载传统。

## 自动加载入口

编辑器只自动加载 `.github/copilot-instructions.md`、`AGENTS.md` 及按 `applyTo` 匹配的 `*.instructions.md`，不会自动加载 `docs/`。迁移后：

| 文件 | 保留内容 |
| --- | --- |
| `AGENTS.md` | 指向 `.github/copilot-instructions.md` |
| `.github/copilot-instructions.md` | 必读入口：SID#README、`SID#0.AGENT`、`SID#1.AGENT` 的「传统」，以及权威文档优先的提示 |
| `.github/instructions/*.instructions.md` | 保留 `applyTo`，正文只有指向对应「传统」小节及相关 DESIGN 的链接 |

示例：

```markdown
---
applyTo: "server/**/*.ts"
---
编辑前阅读 [SID#0.AGENT 传统：后端](../../docs/0_overall/AGENT.md#后端) 与相关领域 DESIGN、AGENT。
```

## 现有约定的去向

| 来源 | 章节 | 去向 |
| --- | --- | --- |
| `copilot-instructions.md` | Entry points | 精简为入口 |
| | Workflow and runtime | `SID#1.AGENT`；其中授权、保留工作区、提问等协作原则与 SID#README「尊重权威，勇于提问」核对，重复部分删除 |
| | Protected author content | `SID#0.AGENT`；与 SID#README「THIS IS A GOOD 标记」核对，标记语法以宪章为准 |
| | Configuration and secrets | 配置分层已在 `SID#0.1.DESIGN`「配置系统」；具体操作规则进 `SID#0.AGENT` |
| | Data integrity and synchronization | UTC、`tinyint(1)` 进 `SID#0.AGENT`；迁移进 `SID#1.AGENT`；outbox 与后台任务的架构部分对照 `SID#0.1.DESIGN` 后续章节，实现细节进 `SID#2.AGENT` |
| | Testing | `SID#1.AGENT` |
| | Development test accounts | `SID#1.AGENT` |
| | Git and review | `SID#1.AGENT` |
| `backend-api.instructions.md` | Boundaries and types | 分区职责与依赖已在 `SID#0.1.DESIGN`「后端」；别名、schema 位置等进 `SID#0.AGENT` |
| | Authorization and data | 通用部分进 `SID#0.AGENT`；资料读取、`operate_for` 等账号细节进 `SID#2.AGENT` |
| | Verification | `SID#1.AGENT` |
| `frontend.instructions.md` | Components and presentation | `SID#0.AGENT` |
| | APIs, ownership and injection | 分区职责与依赖已在 `SID#0.1.DESIGN`「前端」；`useApi`、注入、身份来源等实现规则进 `SID#0.AGENT` |
| | Synchronization and hydration | 规则层面对照 `SID#0.1.DESIGN` 后续「数据更新」「SSR 水合」；实现细节进 `SID#0.AGENT` |
| | Verification | `SID#1.AGENT` |
| `code-style.instructions.md` | Enforced syntax、Reuse and configuration、Comments and prose | `SID#0.AGENT` |
| | Protected content markers | `SID#0.AGENT`；示例中的标记须原样迁移 |
| | Verification | `SID#1.AGENT` |
| `migrations.instructions.md` | 全部 | `SID#1.AGENT`；冻结摘要等不可变约定逐条保留 |

## 实施步骤

1. 人类核定本计划，并将宪章补充写入 SID#README；
2. Agent 新建 `SID#0.AGENT`、`SID#1.AGENT`（如需，`SID#2.AGENT` 加「传统」），按上表逐条迁移，每条依据记为「迁自 `<原文件>`，人类 <日期> 核定迁移计划」；
3. Agent 生成逐条对照清单：每条原约定 → 新位置，或「已由 DESIGN／宪章覆盖」「重复删除」及理由；人类核对；
4. 涉及架构的条目由 Agent 起草 DESIGN 候选正文，写入对应 TMP，由人类决定是否采用；
5. 将 `*.instructions.md`、`copilot-instructions.md`、`AGENTS.md` 精简为入口；
6. 验证：分别编辑 `server/`、`app/`、`migrations/` 下的文件，确认 Agent 能经入口读到对应传统；
7. 更新 `docs/AGENT.md` 的迁移进度。

## 完成条件

- 原有每条约定都在对照清单中有明确去向，无遗漏、无未经说明的删除；
- 每条传统都有原因与依据；
- `*.instructions.md` 只剩入口链接，所有链接与锚点有效；
- DESIGN 中没有新增实现细节，架构类条目均由人类决定是否采用；
- `pnpm lint` 通过。

## 待人类决定

- 宪章补充的措辞；
- 「传统」小节在 `SID#0.AGENT` 内的分组方式：按前端／后端／共享／通用，或按主题；
- 业务目录建立前，领域传统是否暂存于 `SID#2.AGENT`；
- 迁移时是否保持英文原文，或统一改写为中文。
