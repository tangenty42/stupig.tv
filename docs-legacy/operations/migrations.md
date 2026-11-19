# SQL 与 TypeScript 迁移

> 当前迁移编写约定见 [SID#1.1.AGENT-DESIGN](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#编写数据库迁移)，执行、查询与失败恢复见 [SID#1.4.AGENT-DESIGN](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#迁移查询与失败恢复)。本文保留历史版本说明、具体迁移的退出合同和原始记录。

`pnpm migrate:dev`／`pnpm migrate:prod` 是对应环境的数据库结构与一次性数据迁移入口。版本位于 `migrations/`，SQL 和 TS 按完整文件名共同排序。日常后台 runner 不执行这些迁移。

## 目录和版本身份

| 路径 | 职责 |
| --- | --- |
| [migrations/](../../migrations/) | 当前结构由基线 SQL 及后续迁移描述，基线前的 SQL 保留原文件供核对 |
| `migrations/lib/content-v1/`（路径已删除） | 已冻结的 Content v1 迁移实现；2026-11-12 新基线后随旧 TS 迁移一并删除，仅作历史记录 |
| [scripts/migration/local.ts](../../scripts/migration/local.ts) | 本地迁移入口，存在 TS 迁移时先构建产物 |
| [scripts/migration/](../../scripts/migration/) | 执行器、契约、只读限制、打包及原生依赖交付 |
| [scripts/migration/frozen.test.ts](../../scripts/migration/frozen.test.ts) | SQL 与 TS 依赖闭包的冻结摘要 |
| [scripts/verify/](../../scripts/verify/) | 隔离数据库演练 |

已经应用的 SQL，包括注释和换行，不得修改；已经开始的 TS 及其依赖实现也不得修改。修复通过追加迁移实现。TS 身份来自确定性打包后的完整依赖闭包，修改被旧迁移导入的 helper 同样会改变版本身份。

## 选择环境

源码环境选择见 [SID#1.1 配置来源](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#配置实际从哪里来)，本地与生产容器的执行位置见 [SID#1.4](../../docs/1_workflows/4_maintain/DESIGN.md#在哪里执行)。以下保留冻结实现的历史身份说明。

历史 Content v1 产物用 `migrations/lib/content-v1/config-loader.ts.snapshot`、`config-schema.ts.snapshot` 和 `settings.generated.ts.snapshot` 保存当时的配置实现和生成设置。对应旧构建器在原模块身份下加载快照，以保持冻结摘要。重演时使用该历史版本的源码或已交付的冻结产物。

引用统一后，旧 Content v1 产物的 `content-markdown.ts`、`content-reference.ts`、`content-workspace.ts`、同步通道及同步类型同样固定到该目录的 `.snapshot` 文件，在原模块身份下加载；旧脚本摘要保持不变，新行为仅由新迁移及运行时代码采用。

历史 WebP v1 构建器以原在线模块身份加载 `migrations/lib/webp-v1/content-reference-definitions-live.ts.snapshot`，保持冻结产物的字节和摘要。当前基线承接结构变更，历史快照随入口退役，旧回执的摘要留在[基线清单](../../scripts/migration/baseline.ts)。

本地与生产的现行打包路径见[开发补充](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#迁移明细表)。历史 CI 空库重放曾用假 OSS 身份满足旧脚本的目标配置校验。现行 CI 空库步骤执行基线和后续 SQL。

## 命令语义

查询参数、只读边界与失败重试见 [SID#1.4 迁移查询与失败恢复](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#迁移查询与失败恢复)；在线／维护分类的编写规则见 [SID#1.1 新版本与在线声明](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#新版本与在线声明)。部署被拦截后按 [SID#1.3 授权维护计划](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#授权维护计划)操作。

## 单一账本与旧 SQL 的继承

`migration_runs` 是当前唯一账本，保存 filename、checksum、status、phase、checkpoint、attempts、错误码和完成时间。`status=completed` 且具有 `finished_at` 才是完成回执。

实际执行前，框架使用冻结的 `20261024020000_migration_runs.sql` 初始化元数据表。旧库的 `schema_migrations` 由退役迁移 `20261024030000_single_migration_ledger.sql` 检查冲突、迁入缺失记录并删除。当前版本按原摘要核对这条完成回执。仍有旧账本或缺少历史回执的库，先使用含该迁移的旧发布版本完成升级。新库直接使用当前基线。

存量库接管边界、空库执行和 baseline 限制见 [SID#1.4 先读状态](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#先读状态)。

## 执行、暂停与恢复

按 [SID#1.4 按失败阶段处理](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#按失败阶段处理)核对锁、SQL 部分执行、TS 检查点及 verify 回执；恢复后重新核对状态。没有通用 down，也没有跨 OSS 与 MySQL 的单一事务，镜像回退不撤销已提交的数据变化。

## 编写新 TS 迁移

### 2026-10-28 引用历史升级

历史升级顺序为 `20261028210000_reference_journal_entries.sql` → `20261028210100_reference_journal_entries.ts` → `20261028210200_reference_journal_contract.sql`。重演时先备份数据库并停止应用、worker 和旧引用清理定时器，再用包含这三步的历史版本运行 `pnpm migrate:dev --maintenance --through 20261028210200_reference_journal_contract.sql`。第一步展开表结构，第二步逐批转换 JSON 为 URI 事件行并按作用域保留 200 批，第三步删除旧 JSON 列及不再使用的反向索引列。

转换保持 scope/revision；每批转换在事务中完成，中断后按尚未转换的行继续。被裁剪历史通过 floor 明确失效，不能恢复已丢失历史，也不猜测修复历史上已漏改的 main。回滚需要恢复备份及旧应用，仅回退代码不足以恢复旧 schema。

隔离验证当时使用 `scripts/verify/reference-history.ts`（限定 development 与回环 MySQL，用本地 root 建随机库，覆盖空库完整迁移、存量批次转换、中断重跑、批次上限与事务回滚）。该脚本已随 2026-11-12 新基线删除；现行隔离演练入口见 [SID#1.2 专项数据库与迁移演练](../../docs/1_workflows/2_test/AGENT-DESIGN.md#专项数据库与迁移演练)。

### 新迁移约定

新版本声明、plan／apply／verify、检查点和冻结闭包统一见 [SID#1.1 编写数据库迁移](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#编写数据库迁移)。

## 迁移专用表必须有退出方案

新增明细表的设计要求见 [SID#1.1 迁移明细表](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#迁移明细表)；验收、保留、归档读回、责任交接及独立退役迁移见 [SID#1.4 迁移明细归档与退役](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#迁移明细归档与退役)。下列具体退出合同继续保留，通用步骤不能代替其中的前置条件。

### WebP 回执表（#64）的退出合同

`content_webp_migration_objects` 仅由 `20261101133000_content_webp.ts` 保存逐附件的源身份、目标所有权、结果与采用回执；迁移完成后应用不会继续写它。负责后续 WebP 维护发布的操作者负责验收与退出复核。

1. **起点与期限：** 该迁移 completed 且 finished_at 非空、生产 WebP／JPEG 读取和编辑／删减验收均通过。以完成与验收两者较晚时间为起点，至少保留 **30 个完整日**，起点和复核日期写入该次维护发布记录。开发演练时间、PR 合并时间不作为生产保留起点。
2. **归档：** 保留对应 1Panel 完整数据库备份，并将该表的结构、全部行及相应 `migration_runs` 完成记录导出到受保护的 `.migration-backups/<release>/webp-receipts/`。记录应用提交／镜像、迁移摘要、DB 身份、行数和归档 SHA-256；隔离导入核对 adopted 数及源／目标身份。该表是恢复材料，不是可以公开的诊断 JSON。
3. **退出核验：** 所有行 adopted=1，无待恢复、未知写入、未核验产物或未完成清理责任。正常更新后目标已被替换是合法情况，按对象回执／退役事实核对，不能要求所有旧目标仍是当前展示指针。遗留责任必须先交接到现有对象账本或保留清单，不能在删表时遗失其唯一身份。
4. **对象保护单独处理：** 旧源和历史版本仍按各自保留政策处理；归档／删除回执表不删除 OSS 对象，也不批量释放 `content_migration_pins`。需要退役旧源时，按归档中的精确身份确认无其他保护用途，登记既有退役队列并交接 pin；仍需保留的源继续由 pin 保护。元数据归档不等于对象字节已备份。
5. **最终退役：** 上述证据齐全、期限已到并明确授权后，在后续 PR 追加独立维护迁移删除该表，保留 `migration_runs` 及归档。**本次版本链不预排一个立即删表的后序版本，也不在编码迁移的 finally 或定时任务里清表。** 后续退役迁移必须在 plan 中检查完成回执、归档核验及责任交接证明，缺失即阻止执行。

### 五张旧 Content 表的退役

`20261101143000_retire_legacy_content.ts` 在 WebP 迁移之后退役 `content_task_items`、`content_tasks`、`content_locks`、`content_attachment_encryption_backup`、`content_attachment_storage_migrations`。它们的在线功能及旧 S3 盘点入口已删除；历史创建步骤与历史冻结预检保留，空库会先创建再按序删除。

维护发布前停止旧应用／worker 并核对 1Panel 备份。plan 返回五张表的现存行数；apply 在首条 DDL 前再次核对，**任何一张表非空都拒绝所有删表操作**，不能自动清空锁、任务或恢复材料来放行。非空时先查明归属、完成或归档相关责任，再单独处理。各条 `DROP TABLE IF EXISTS` 可重入，已删除表不重建；verify 要求五表均不存在。此步骤不删除上一轮 cutover 的 scopes／objects／references、对象 pin 或 WebP 回执。

隔离验证当时沿用 `scripts/verify/webp-migration.ts`，覆盖非空拒绝、DDL 中断重入、归档原图和 WebP 回执保留，以及删表后现行 OSS 对账查询。该脚本已随 2026-11-12 新基线删除；现行入口见 [SID#1.2 专项数据库与迁移演练](../../docs/1_workflows/2_test/AGENT-DESIGN.md#专项数据库与迁移演练)。

## 生产产物与维护容器

生产迁移查询命令见 [SID#1.4 迁移查询](../../docs/1_workflows/4_maintain/DESIGN.md#迁移查询)，构建产物、Compose 继承与一次性容器边界见 [运维工具的交付范围](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#运维工具的交付范围)。生产维护执行按 [SID#1.3 授权维护计划](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#授权维护计划)。

## checksum 不一致

### 共享云端草稿切换

`20261030120000_shared_content_drafts.sql` 新增独立当前草稿表，将所有 main 原文字节、namespace/title 基线及发布 revision 回填为一对一 draft，不导入浏览器数据。先在维护窗口停旧写者、核对目标库和完整备份，执行同版本 maintenance 包，再核对数量、BINARY 文本相等及基线；检查 `migration_runs` 的成功回执后才启动 cloud-v1 应用。旧客户端的 main 直写被拒绝，无双写回退。

原迁移及已开始 TS bundle 的 digest 保持冻结；历史 outbox 等依赖通过对应快照固定，不把当前运行时的草稿逻辑带进旧 bundle。隔离演练入口为 `pnpm exec tsx --tsconfig scripts/tsconfig.json scripts/verify/cloud-drafts.ts --mqtt --capacity`，生产执行不包含在开发验收授权内。首次跨协议失败停止应用并保留 draft/main，不能自动重启旧写者；恢复边界见[备份恢复](backup-recovery.md)。

### 摘要核对

冻结清单、账本、原始字节与产物的核对，以及有证据的 CRLF／LF 定点修正，统一见 [SID#1.4 摘要不一致](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#摘要不一致)。

具体 Content 维护步骤、源 pin 与恢复材料见 [Content 切换](./content-cutover.md)，隔离演练见 [SID#1.2 专项数据库与迁移演练](../../docs/1_workflows/2_test/AGENT-DESIGN.md#专项数据库与迁移演练)。
