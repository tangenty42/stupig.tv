# AGENT：Swordoc 文档迁移与编写进度

- 基线：核对时间 2026-11-05 14:49:53 +08:00（Asia/Shanghai）；代码提交 `67f8dad0a15c76acdb079c1334b143fcc146b935`，文档采用本次核对时的未提交工作区内容
- 任务状态：PENDING（旧文档已归档，新的权威文档正在编写）
- 覆盖范围：`docs/` 的编写进度、旧资料归档及新旧文档的衔接

前端重构主题状态另于 2026-11-05 17:09:22 +08:00 独立补验收尾更新；本文件其他迁移核对结论沿用上述基线。

本次核对文档机制、ID 引用、现行权威文档、编写进度及链接；归档完整性、历史锚点及总体代码入口的核对沿用 2026-11-03 的记录，未重新执行完整的业务实现调查或生产验收。基线时间表示本次核对时间，不是原归档时间或历史业务调查时间。

## 引经据典

- [SID#README](README.md)：人类编写的 Swordoc 机制与传统，定义目录、权威边界和四种文档类型。
- [SID#0.0.LAW](0_overall/0_background/LAW.md)：项目背景与成员权限边界，当前文档状态为 PENDING，保留领域文档引用的 TODO。
- [SID#0.1.LAW](0_overall/1_architecture/LAW.md)：六个功能板块、功能关系图与板块交界，人类已将文档状态标为 DONE，仍保留各板块文档引用的 TODO。
- [SID#0.1.DESIGN](0_overall/1_architecture/DESIGN.md)：人类正在编写总体实现架构，状态为 PENDING；已有基础设施总览图、生产与开发授权回调对照图，以及代码产物结构表。
- 人类先前要求归档旧资料，随后明确将总体架构与领域业务细节分开，并继续将运行与维护设施合并为一个板块。
- 人类要求将总体 DESIGN 草案中的领域实现与工程流程细节下放，随后将授权回调的环境差异独立成图，采用简洁的 flowchart 表达。
- `SID#README` 为 Swordoc ID 增加 `SID#` 前缀，明确机制入口的标识为 `SID#README`；模板正文采用二级标题，AGENT 基线仍要求时间精确到秒并注明时区。

## 目前实现

| 引经据典 | 实现产物 | 现状 |
| --- | --- | --- |
| `SID#README` 的三个固定顶层分区 | `0_overall/`、`1_workflows/`、`2_domains/` | overall 已有背景和架构权威文档及草案；domains 已有业务与实现调查材料；workflows 已有工程流程调查材料 |
| `SID#README` 的人类权威文档分工 | [SID#README](README.md)、`SID#0.0.LAW`、`SID#0.1.LAW`、`SID#0.1.DESIGN` | 宪章、两份 LAW 和一份 DESIGN 均由人类维护；领域及流程的权威文档尚未建立。AGENT 基线注明精确到秒的时间及时区，TODO 同时允许 HTML 注释及直接书写形式 |
| `SID#README` 的标识规则与建议结构 | 本文件及 8 份 TMP 文档 | 旧数字 ID 和机制入口引用已统一为 `SID#` 格式；本文件保留一级标题，正文四个章节改为二级标题。相对链接路径及调查材料的历史基线保留 |
| 人类关于总体与领域分工的要求 | [SID#0.1.TMP-LAW](0_overall/1_architecture/TMP-LAW.md)、[SID#0.1.TMP-DESIGN](0_overall/1_architecture/TMP-DESIGN.md) | LAW 草案保留职责和协作；DESIGN 草案已收拢为总体运行形式、代码结构、主要依赖与共享边界，基础设施图直接引用人类 DESIGN |
| `SID#0.1.DESIGN` 及人类关于链路对照的要求 | [SID#0.1.TMP-AUTH-CALLBACK](0_overall/1_architecture/TMP-AUTH-CALLBACK.md)、[SID#0.1.TMP-INFRASTRUCTURE-BLOCK](0_overall/1_architecture/TMP-INFRASTRUCTURE-BLOCK.md) | DESIGN 已采用独立的普通 flowchart 对照图，开发接入框包含 FRP 反向代理、FRP 隧道和本机专用代理；主图也已补入 WebSocket 通知经反代转发。block-beta 方案已放弃并标明仅保留试排记录；TMP 图稿不作为现行权威图 |
| 人类关于总体与领域分工的要求 | [SID#2.TMP-DOMAIN-NOTES](2_domains/TMP-DOMAIN-NOTES.md)、[SID#2.TMP-IMPLEMENTATION-NOTES](2_domains/TMP-IMPLEMENTATION-NOTES.md)、[SID#1.TMP-ENGINEERING-NOTES](1_workflows/TMP-ENGINEERING-NOTES.md) | 业务细节、领域实现及工程流程分别保存为临时调查材料；原调查基线与未验证范围保留，本轮整理不代表重新完成业务验收或批准技术取舍 |
| `SID#0.1.LAW` 的六板块划分及弹窗归属 | [SID#0.1.TMP-CHART](0_overall/1_architecture/TMP-CHART.md)、`SID#2.TMP-DOMAIN-NOTES` | 临时图仍保留运行与维护拆分为两个板块的旧方案；领域材料仍把登录／注册弹窗列入公共框架。现行 LAW 保留合并板块，并将弹窗、业务逻辑及状态管理归账号与权限；临时材料需要同步或标明旧方案已被取代 |
| 人类的归档要求 | [旧文档归档](../docs-legacy/README.md) | 2026-11-03 已确认基线提交中原 `docs/` 的 55 个文件均有对应归档，其中原 README 对应 `README-DRAFT.md`，其余为 54 份手册、设计、审查及报告；另有新建归档索引，共 56 个文件。内容原样迁移的记录见归档说明；归档材料不自动成为新权威规范 |
| 人类的归档要求及 `SID#README` 的权威边界 | [.github 工程入口](../.github/copilot-instructions.md) | 现有工程规则继续作为协作入口，文档链接已指向新机制和旧参考 |
| 人类批准的前端业务模块重构 | [SID#0.1.AGENT](0_overall/1_architecture/AGENT.md)、[SID#0.1.TMP-GOOD-REFACTOR](0_overall/1_architecture/TMP-GOOD-REFACTOR.md) | 三阶段代码重构已验收收尾；第三阶段跨 SSR 请求 401 隔离问题独立补验通过，按人类授权关闭；具体验证范围及待人类同步的总体 DESIGN 偏差由该主题记录 |
| 归档过程中的链接核对 | 旧 OSS 对账、故障排查手册到云端台账的链接 | 2026-11-03 核对时两处历史锚点失效；替代入口已记于归档说明，本次未重新核对归档正文 |

## 待办

| 事项 | 引经据典 | 现状 | 怎么办 | 完成条件 |
| --- | --- | --- | --- | --- |
| 展开各领域与工作流程文档 | `SID#README`、`SID#0.1.LAW` 及人类的分工要求 | 总体板块及交界已明确，领域与流程权威文档尚未建立 | 人类按板块编写、核对；Agent 提供 TMP 调查、建议和校对 | 各主题按适用范围明确业务、状态、操作、入口及验收；总体 LAW 不重复领域细节 |
| 完善并核定总体 DESIGN | `SID#README` 的 DESIGN 分工 | 基础设施总览、授权回调环境对照和代码产物表已写入，文档仍为 PENDING；`SID#0.1.TMP-DESIGN` 提供其余候选补充 | 人类确认总体实现选择与所需补充，Agent 辅助核对依据和表述 | 总体实现选择与业务分工对应，领域内部细节由所属文档展开，并由人类确认文档状态 |
| 回填总体 LAW 的文档引用 | `SID#0.0.LAW`、`SID#0.1.LAW` 中的 TODO | 两份文档仍有待补 Swordoc ID | 对应领域文档建立后，由人类补充权威文档引用并确认文档状态 | 引用指向实际存在的所属文档，相关 TODO 得到处理 |
| 同步临时材料与现行 LAW | `SID#0.1.LAW` 的板块划分及交界规范 | 临时图的拆分方案、领域材料的弹窗归属仍是旧表述 | Agent 更新非权威材料或明确标记已被取代的方案，保留原调查的时间与事实边界 | 读者不会将旧提案或历史实现调查误认为当前业务归属 |
| 建立主题 AGENT 文档 | `SID#README` 的 AGENT 分工 | 架构目录已有前端业务模块重构记录；其他领域与流程仍未建立主题实现核对记录 | 按实际任务继续建立主题记录，基线写明提交或产物及精确到秒的核对时间与时区 | 依据可追溯，已核对、未核对和偏差分明，不将 TMP 调查当成完成验收 |

## 工作经验

归档目录与 `docs/` 同级，可以在不改写历史文件的情况下保留原有内部链接和多数源码相对链接。历史正文中的绝对仓库路径与行号仍需按归档说明核对。

更新 AGENT 基线时应同时复核状态内容；现有文档从“尚未建立”变为“正在编写”后，不能仅更换日期而沿用旧记录。历史记录缺少时分秒时不猜补，使用本次实际核对时间，并注明时区。
