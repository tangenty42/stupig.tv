# AGENT：维护实现与历史验收记录

- 本文档状态：DONE（本轮文档核对完成；外部验收边界见下文）
- 覆盖范围：SID#1.4 的实现对应、历史恢复与盘点证据、待办和旧资料去向
- 旧文档：`docs-legacy/` 已于 2026-11-19 删除；本文提到的旧手册、旧台账以及“留在原文”的内容，原文都在 git tag `docs-legacy-final`
- 核对基线：2026-11-11 00:15:00 +08:00（Asia/Shanghai）；提交 `722c1cd3392cb4cdb5c8b051f3354c8e3905e355` 及核对时的未提交工作区
- 依据：[SID#1.4.DESIGN](DESIGN.md)、[维护操作说明](AGENT-DESIGN.md)、[SID#README](../../README.md)
- 核对范围：文档、脚本、配置与策略文件；未连接生产、执行迁移、恢复、盘点、轮换或启停服务

## 实现对应

| 要求 | 当前实现 |
| --- | --- |
| 区分源码工具与生产产物 | [package.json](../../../package.json)、[Dockerfile](../../../Dockerfile)、[维护构建器](../../../scripts/migration/build.ts)；镜像交付迁移、盘点和 release 三个入口，其余命令需要源码环境 |
| 查询、维护准入和失败恢复 | [CLI](../../../scripts/migration/cli.ts)、[runner](../../../scripts/migration/runner.ts)区分只读、维护与显式 SQL 重试，使用单一账本和冻结版本；标志本身不停止写入者 |
| 只读专项盘点 | [inventory.ts](../../../scripts/storage/inventory.ts)、[inventory-run.ts](../../../scripts/storage/inventory-run.ts)绑定目标和扫描参数，保存有界断点；[盘点 RAM 策略](../../../config/ram/stupig-oss-inventory-prod-readonly.json)提供所需元数据只读权限 |
| 后台状态与日常检查 | [状态 CLI](../../../scripts/background/status.ts)、[worker](../../../scripts/background/worker.ts)及[管理员路由](../../../server/trpc/routers/admin.ts)；CLI 读持久账本，运行时进程统计有各自边界 |
| 维护前备份及隔离恢复验证 | [remote.sh](../../../scripts/deploy/remote.sh)停写后检查目标身份、会话与结构，备份并在随机 QA 库导入比对；生产维护开始后的失败保留停写 |
| EMQX 持久化与诊断 | [生产 Compose](../../../docker-compose.yml)、[包装入口](../../../scripts/deploy/emqx-entrypoint.sh)、[凭据健康检查](../../../scripts/deploy/emqx-healthcheck.sh)共同提供固定节点、持久卷、初始化和真实凭据探针 |

本轮未发现上述实现与 SID#1.4.DESIGN 的实质冲突；源码核对不表示本工作区已部署。

## 历史证据及其边界

| 日期与来源 | 已记录的结果 | 未覆盖或后续变化 |
| --- | --- | --- |
| 2026-10-24 开发 EMQX 升级（`docs-legacy/development/README.md`） | 本机 5.10.5 → 6.2.2，durable sessions 关闭，保留原卷与节点；MQTT 3.1.1／5 各 10 项权限测试通过 | 仅当时本机结果。备份在本机忽略目录 `.data/emqx-upgrade-20261024-6.2.2/`，新检出不包含它 |
| 2026-11-01 隔离恢复演练（`docs-legacy/operations/backup-recovery.md`） | 实际 1Panel 备份恢复至隔离 MySQL 8.4.13；34 表、1,085 行、30 项完成迁移，真实服务层的草稿、权限、引用及去重检查通过 | 未启动完整 Nuxt HTTP／SSR，未执行生产停写或整套流量恢复；本机阶段耗时不能作为生产恢复时限 |
| 同次演练的 OSS 核对 | 398 个对象当前元数据可读；395 个附件的当前 version ID 与备份一致，3 个头像基线不齐 | 未下载对象字节或重新计算 SHA-256；应用身份读取历史 versionId 返回 403，须独立恢复身份。盘点只读策略不提供对象内容恢复能力 |
| 2026-11-02 专项盘点摘要（`docs-legacy/reviews/oss-inventory-2026-11-02.json`） | 生产完成元数据及只读 DB 归属核对；开发仅完成元数据；两桶当时 multipart 为 0 | 无真实 ListParts 任务可验，不将当时计数当当前存量，也未授权清理 |
| 2026-11-09 [RAM 与生命周期读回](../../../config/ram/CLOUD-AUDIT-2026-11-09.md#云端核对结果) | 独立盘点方案已确定，应用身份已解绑临时盘点策略；两桶版本控制开启，非当前版本 7 天、过期删除标记清理及 multipart 7 天终止规则已读回 | 覆盖了 11/02 当时尚无 multipart 终止规则的旧状态；生命周期独立于应用 pin，仍未证明完整备份窗口或对象字节恢复 |
| 2026-11-01 WebP 维护发布（`docs-legacy/deployment/aliyun.md`） | 当时的迁移、恢复核对及抽样读取有记录，详细版本身份保留原台账 | WebP 回执退役还需明确业务编辑／删减验收时间和责任交接，不能仅从发布日期计算 30 天后自动删表 |

原文件保留输入身份、摘要、范围与脱敏结果，表格只提供索引。本次没有重新运行这些验收。

## 2026-11-13 本地开发重置

本机开发库 `stupig_tv` 重建后执行基线和权限迁移，`--status` 无待办。随后对开发 OSS 的 `content/` 和 `content-upload/` 执行重置，清理 308 个当前对象，失败 0 个。复查时当前对象与未完成上传均为 0。结果仅对应当日本机与开发桶，历史对象版本按桶生命周期保留。[开发样本与重置](AGENT-DESIGN.md#开发样本与重置)

## 待核对与既有决定

| 事项 | 处理时机与完成条件 |
| --- | --- |
| 独立盘点用户的实际配置 | 本轮未核对用户是否已创建、策略是否绑定；下次盘点前按初次配置核对实际身份，不沿用业务凭据 |
| 完整恢复能力 | 实际需要恢复或另行安排演练时，核对独立恢复身份、精确对象版本和字节、密钥及发布材料；1Panel 频率、保留、加密／异地副本、日志恢复能力与允许的数据丢失／恢复时限仍需结合现有运维计划确认 |
| 自动恢复与定期演练 | 用户在 11/01 演练后决定短期不新增自动化；保留上述缺口作为验收边界，未重新列为本轮必须实现的任务 |
| 自动清理与预热 | 仓库默认关闭相关开关，外部现状未在本轮核对。需要启用时先完成观察、交付、权限和额度验收；文档迁移不授权启用 |
| 独立 worker 交付 | 源码有入口，生产镜像／Compose 尚无独立服务；确有容量或部署需要时再补交付与多实例验证，不靠单改 mode 切换 |
| 预热策略输出简化（可选） | `content:preload:check:<env> --policy` 目前仍加载完整配置及 DB 模块；后续可让策略分支只加载所需 ESA 配置，保持无云端写入 |
| 样本导出体验（可选） | 当前通过 stdout 输出；旧命令清单建议补显式输出文件参数和真实入口的跨平台验证，尚未实施 |

## 旧章节迁移对照

| 旧来源 | 新位置 | 继续保留的内容 |
| --- | --- | --- |
| 迁移手册（`docs-legacy/operations/migrations.md`）：查询、执行、暂停、checksum、容器产物 | AGENT-DESIGN「迁移查询与失败恢复」「运维工具的交付范围」；编写归 SID#1.1，演练归 SID#1.2 | 2026-11-19 起，现存迁移明细表和 WebP 回执表的退出条件已迁入 AGENT-DESIGN「迁移明细归档与退役」；引用历史／共享草稿切换和五张旧表退役是已完成的历史 |
| 备份恢复（`docs-legacy/operations/backup-recovery.md`）：材料、维护前备份、误操作处理 | AGENT-DESIGN「备份与恢复」；历史证据和边界见上表 | 带日期的演练输入、摘要与逐项结果保留，后续可独立归档；本轮不删除 |
| 存储审计（`docs-legacy/operations/storage-audit.md`）：专项盘点、查看、异常处理 | AGENT-DESIGN「OSS 专项盘点」「后台任务与日常存储检查」 | 日常扫描、保护关系、并发清理机制属于领域；历史验收和完整摘要仍留原处 |
| MQTT 手册（`docs-legacy/deployment/mqtt.md`）：升级、持久化、账号轮换与诊断 | AGENT-DESIGN「EMQX 升级与凭据轮换」；验收归 SID#1.2 | 服务器反代配置归 SID#1.0，草稿票据和通知协议归领域；完整示例继续保留 |
| 本地开发（`docs-legacy/development/README.md`）：EMQX 升级、样本与重置 | 上述 EMQX 一节及「开发样本与重置」；历史升级记录见上表 | 重复操作已改链接，原始本机升级证据继续保留，旧锚点仍可用 |
| 命令清单（`docs-legacy/development/commands.md`）：维护工具与未实施建议 | DESIGN、AGENT-DESIGN 及本文件待办 | 逐脚本清单 2026-11-19 核对时已过时，不再承接；目录职责见 `scripts/README.md` |
| 故障排查（`docs-legacy/operations/troubleshooting.md`） | AGENT-DESIGN「故障排查」；开发隧道归 SID#1.1，部署／ESA 归 SID#1.3 | 领域症状及其原实现链接仍需领域迁移时核对 |
| Content 切换（`docs-legacy/operations/content-cutover.md`） | 通用操作已在上述流程承接；切换留下的四张明细表及旧源退役规则已迁入 AGENT-DESIGN「迁移明细归档与退役」 | 分阶段命令和放行清单是历史，不复制为通用新库步骤 |
| 原 1.4 `TMP-DESIGN.md` | DESIGN、AGENT-DESIGN 与本文件 | 无独有待迁操作，已删除并清理引用 |

文档收尾已删除本阶段 TMP；旧手册保留领域机制与原始证据，重复操作改指现行入口。统一清理结果见 [流程整理记录](../../AGENT.md#流程草稿与索引退役记录)。
