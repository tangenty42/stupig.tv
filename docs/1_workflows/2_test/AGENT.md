# AGENT：测试文档迁移与验证边界

- 本文档状态：DONE（操作迁移与去重完成；领域合同和历史证据按下文归属保留）
- 覆盖范围：SID#1.2 的实现核对、历史验收边界与旧手册迁移
- 旧文档：`docs-legacy/` 已于 2026-11-19 删除；本文提到的旧手册、旧台账以及“留在原文”的内容，原文都在 git tag `docs-legacy-final`
- 基线：2026-11-11 00:16:22 +08:00（Asia/Shanghai）起；提交 `722c1cd3392cb4cdb5c8b051f3354c8e3905e355` 及本轮未提交工作区
- 依据：[SID#1.2.DESIGN](DESIGN.md)、[SID#0.1.DESIGN](../../0_overall/1_architecture/DESIGN.md)、[SID#README](../../README.md)
- 实现说明：[SID#1.2.AGENT-DESIGN](AGENT-DESIGN.md)

## 本轮核对

本轮只读取旧测试手册、命令清单、package recipes、Vitest／Playwright 配置、浏览器启动器、专项验证脚本和 Check 工作流，编写两份补充文档。没有运行应用构建、浏览器、MySQL／MQTT 演练或真实云端调用，也没有复验历史测试结果；文档 lint 与链接检查由本次整体整理统一记录。

确认日常命令与 DESIGN 一致；补充了下列容易被旧说明混淆的执行边界：

- E2E 会为本轮启动临时 EMQX，并覆盖应用 MQTT 连接；随机库之外还存在容器、匿名卷、进程和临时配置的清理责任。
- production CSS／legacy profile 只改变编译模式；应用仍使用开发隔离库和供应商替身，不是生产服务验收。
- `migration-runtime.ts` 要求 development，但未强制 MySQL 回环地址；执行前须按操作说明核对本机目标。
- 一次性 Content／WebP 转换验证随旧入口退役。现行专项的覆盖范围见[专项数据库与迁移演练](AGENT-DESIGN.md#专项数据库与迁移演练)。
- MQTT 生产镜像测试需显式设置 `STUPIG_EMQX_IMAGE`；未设置时该项跳过。CI 单独构建镜像并启用该测试。
- `verified-tree-<tree>` 是 `check` 内部的成功步骤标记；不是独立必需 job。

## 已知边界与既有决定

| 事项 | 当前记录与后续条件 |
| --- | --- |
| 历史浏览器验收 | 长期问题记录（`docs-legacy/reviews/long-term-issues-2026-11-01.md`） 明确按用户要求暂停正式 Chrome／Edge 80、Safari 13.1 及完整旧引擎业务覆盖。保留可运行入口与既有证据，不把扩展覆盖重新列为当前迁移阻塞；涉及新的兼容改动仍按 DESIGN 选择相关检查 |
| 历史通过范围 | CSS 当前证据（`docs-legacy/reviews/css-official-apis-validation-2026-10-29.md`） 和旧引擎报告（`docs-legacy/reviews/css-legacy-engines-2026-10-29.md`） 只证明各自版本与场景；Chromium snapshot 不能代替正式 Chrome／Edge，现代 WebKit 不能代替 Safari 13.1 |
| 跨发布旧标签页 | 长期问题记录（`docs-legacy/reviews/long-term-issues-2026-11-01.md`） 已记录本阶段接受旧资源缺失风险，暂不做旧资源保留或跨发布验证。此决定保留；自动重载与未保存编辑的配合不记为已验证，出现需求或故障时再评估 |
| 真实云端、系统与容量 | 供应商替身、回环 broker 和有界 QA 负载不证明真实 OSS／ESA／短信、操作系统权限或生产 P95。按本次变更选择真实验收范围，不把未运行项写成通过 |

这些记录保留历史决定的原范围；本轮没有扩大风险接受范围，也没有重新启动暂停的验收。

## 旧资料迁移表

| 来源章节 | 新位置 | 清理与保留理由 |
| --- | --- | --- |
| testing：命令与环境（`docs-legacy/development/testing.md`） | 日常命令与文件命名已有 DESIGN；环境、别名、定向运行进 [编写与定向运行](AGENT-DESIGN.md#编写与定向运行) | 重复正文已改新入口，原标题保留作兼容链接 |
| testing：应该断言什么 | 同上；浏览器辅助约定进 [E2E 隔离](AGENT-DESIGN.md#e2e-隔离与失败排查) | 通用约定已改链接，具体领域断言仍留原文 |
| testing：浏览器测试的隔离 | E2E、[CSS 与历史浏览器](AGENT-DESIGN.md#css-与历史浏览器)、[CI 汇总](AGENT-DESIGN.md#mqtt-镜像与-ci-汇总) | 已按当前源码修正后承接；历史报告继续保留 |
| testing：SSR、身份与时间 | 测试选择进“编写与定向运行”；运行合同归 `SID#0.1.DESIGN` 及领域文档 | 旧文继续保留详细运行合同，待所属领域整理时承接 |
| testing：迁移演练 | [专项数据库与迁移演练](AGENT-DESIGN.md#专项数据库与迁移演练) | 已承接，并补充真实存储副作用与主机检查差异 |
| testing：浏览器验收矩阵、验收记录写法 | [真实验收矩阵](AGENT-DESIGN.md#真实云端与系统验收)、[验收记录](AGENT-DESIGN.md#验收记录) | 工作流内容已承接；业务状态机仍归所属领域 |
| commands：验证命令、verify 脚本与 CSS 入口（`docs-legacy/development/commands.md`） | DESIGN 的日常入口；本文配套说明的专项演练、CSS 探针与 MQTT 镜像验证 | 仅迁验证部分，开发、部署和运维部分由其他阶段承接，不能整份删除 |
| CSS／草稿的历史 review、designs 记录 | 本文保留已接受边界和证据链接 | 保留历史证据，不把报告内容或旧测试总数搬成当前操作要求 |

## 收尾结果与保留边界

1. README、工程规则、scripts 索引及旧手册头已切换到现行入口；旧 `testing.md` 的重复操作已精简为链接，本阶段 TMP 已删除。保留原章节锚点以兼容旧引用，统一结果见 [流程整理记录](../../AGENT.md#流程草稿与索引退役记录)。
2. 历史浏览器报告仍承担二进制来源与原始结果的证据职责，不随操作手册迁移删除。
3. 若以后启动被暂停的验收，使用当时的源码、浏览器及部署身份重新记录结果，不沿用本轮文档核对时间作为实测时间。
