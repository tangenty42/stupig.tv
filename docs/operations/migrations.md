# SQL 与 TypeScript 迁移

`pnpm migrate` 是数据库结构与一次性数据迁移的统一入口。版本位于 `migrations/`，SQL 和 TS 按完整文件名共同排序。日常后台 runner 不执行这些迁移。

## 目录和版本身份

| 路径 | 职责 |
| --- | --- |
| [migrations/](../../migrations/) | 时间戳 SQL／TS 入口；理解当前结构时按文件顺序读取 |
| [migrations/lib/content-v1/](../../migrations/lib/content-v1/) | 已冻结的 Content v1 迁移实现 |
| [scripts/migration/local.ts](../../scripts/migration/local.ts) | 本地编译脚本产物后运行迁移 |
| [scripts/migration/](../../scripts/migration/) | 执行器、契约、只读限制、打包及原生依赖交付 |
| [scripts/migration/frozen.test.ts](../../scripts/migration/frozen.test.ts) | SQL 与 TS 依赖闭包的冻结摘要 |
| [scripts/verify/](../../scripts/verify/) | 隔离数据库演练 |

已经应用的 SQL，包括注释和换行，不得修改；已经开始的 TS 及其依赖实现也不得修改。修复通过追加迁移实现。TS 身份来自确定性打包后的完整依赖闭包，修改被旧迁移导入的 helper 同样会改变版本身份。

## 选择环境

配置加载器按 `NODE_ENV=development` 或 `production` 同时选择 YAML 与 `.env.dev` / `.env.prod`。本地迁移入口默认 development，可用 `--env=prod` 明确选择生产；生产容器由 Compose 注入环境变量。

开发 PowerShell：

```powershell
$env:NODE_ENV = 'development'
pnpm migrate --status
pnpm migrate --dry-run
```

本地检查生产目标可执行 `pnpm migrate --env=prod --status`；它加载 `.env.prod`，仍需核对有效主机与库名，进程中显式注入的同名值优先。SQL-only 路径只校验 `db` 子树；脚本按需读取存储配置，不要求短信等无关密钥。

已冻结的 Content v1 产物使用 `migrations/lib/content-v1/config-loader.ts.snapshot`、`config-schema.ts.snapshot` 和 `settings.generated.ts.snapshot` 保留旧配置实现及生成设置，构建器在原模块身份下加载快照，确保既有摘要不变。当前迁移入口先加载所选环境再运行这些产物；不得修改快照或冻结清单来适配新环境。运行时公共设置可以继续由当前 YAML 生成，不改变历史迁移的依赖产物。

引用统一后，旧 Content v1 产物的 `content-markdown.ts`、`content-reference.ts`、`content-workspace.ts`、同步通道及同步类型同样固定到该目录的 `.snapshot` 文件，在原模块身份下加载；旧脚本摘要保持不变，新行为仅由新迁移及运行时代码采用。

开发源码入口将脚本产物放在 `.nuxt/migration-scripts/`；生产源码入口使用 `.nuxt/migration-runtime/`，同时打包 Sharp 原生依赖及 `native-manifest.json`，执行与生产镜像相同的版本/文件摘要校验。仅设置 `NODE_ENV=production` 而缺少该清单会被拒绝。CI 空库重放使用专用假 OSS 身份满足历史脚本的目标配置校验，不使用真实云密钥或复制对象。

## 命令语义

| 命令／参数 | 行为 |
| --- | --- |
| `--status` | 读取版本、阶段、次数和安全错误码，不导入执行脚本 |
| `--dry-run` | 只读运行当前可执行的首个待办脚本的 plan；前置未完成时报告 `blocked_by` |
| `--preflight` | 只读分类完整待办链，输出 JSON、数据库身份、账本和内容指纹；不执行脚本 plan/apply/verify |
| 无执行参数 | 写入前检查整个待办链；全部允许在线执行时才执行，否则在任何 DDL／回执写入前停止 |
| `--maintenance` | 允许维护脚本执行；不会自动停止应用、worker 或旧 cron |
| `--through <完整文件名>` | 包含目标及全部前置版本，不跳过中间步骤 |
| `--retry-sql <完整文件名>` | 核对过部分执行结果后，允许重放该失败／运行中 SQL |
| `--baseline --through <历史边界>` | 仅登记已确认具备的历史结构；不能用于跳过脚本或失败步骤 |

只读命令不会初始化账本或执行 apply，但本地入口仍会编译校验迁移产物，也需要连接数据库并获取迁移锁。`--dry-run` 不代表所有后序迁移均已预演，必须根据 `blocked_by` 分阶段推进。

部署准入使用 `--preflight`，不从 `--status` 或 `--dry-run` 猜测后续迁移类型。历史 SQL 至自动接管边界及账本初始化／合并步骤保留 automatic；其他 SQL 默认 maintenance。经过审核、对当前旧应用向后兼容的在线 SQL，须在 `migrations/deployment.json` 的 `automatic_sql` 中按完整文件名声明精确 SHA-256；摘要不符即拒绝。声明与迁移一同审核，不能借声明修改冻结 SQL 或把破坏性操作默认为在线。TS 类型仍由其冻结产物的 `execution` 决定。

日常部署发现维护要求会保留旧服务并输出计划 ID；通过 [Maintenance Deploy](../deployment/github-acr.md#授权维护发布) 批准具体计划后执行停写、验证备份和迁移。计划同时绑定提交、镜像／配置、原运行版本、DB UUID 与账本状态，发生变化须重新预检。可能部分执行的 SQL 仍需人工核对并明确 `--retry-sql`，维护入口不会自动重试它。

## 单一账本与旧 SQL 的继承

`migration_runs` 是当前唯一账本，保存 filename、checksum、status、phase、checkpoint、attempts、错误码和完成时间。`status=completed` 且具有 `finished_at` 才是完成回执。

实际执行前，框架使用冻结的 `20261024020000_migration_runs.sql` 初始化元数据表；业务版本仍按原顺序登记。旧库的 `schema_migrations` 只作为升级输入：`20261024030000_single_migration_ledger.sql` 检查冲突、迁入缺失记录、验证一致性后删除旧表。新库不创建旧表。历史完成时间保留，未知的旧执行次数记为 0。

没有账本但已有业务表的存量库，自动接管只覆盖历史 SQL 至 `20261024010000_content_preload.sql`。这不是结构完整性的证明，操作者仍应核对旧库来源。较新的 SQL 和所有 TS 必须实际执行；新空库正常执行全链。不能通过删账本或改 checksum 让失败步骤看起来成功。

## 执行、暂停与恢复

迁移通过 MySQL 命名锁 `stupig_tv_migrate` 与其他执行者互斥。上下文操作前复核连接与锁归属；连接丢失、SIGINT 或 SIGTERM 会阻止新的操作。已经发出的云端请求可能继续，需要按回执对账。

TS 流程为 `plan → apply → verify → completed`：

- plan 和 verify 使用只读上下文；verify 必须明确返回 true。
- apply 中断后从持久检查点重入；各段操作必须可重复并能识别已经提交的外部结果。
- apply 完成后先记录 verify 阶段；验证失败或中断，重跑只做 verify，不盲目重做 apply。
- SQL 可能在部分 DDL 执行后失败。默认阻止重放；先核对实际结构和原文件的可重入性，再使用 `--retry-sql` 指定确切文件。

重试完成后重新运行 `--status`，核对阶段和回执。没有通用 `down` 命令，也没有跨 OSS 与 MySQL 的单一事务。恢复旧镜像不能撤回已经提交的数据变化。

## 编写新 TS 迁移

### 2026-10-28 引用历史升级

升级顺序为 `20261028210000_reference_journal_entries.sql` → `20261028210100_reference_journal_entries.ts` → `20261028210200_reference_journal_contract.sql`。先备份数据库并停止应用、worker 和旧引用清理定时器，再运行 `pnpm migrate --maintenance`；全部完成后启动新代码。第一步展开表结构，第二步逐批转换 JSON 为 URI 事件行并按作用域保留 200 批，第三步删除旧 JSON 列及不再使用的反向索引列。不可让旧应用与转换步骤并行写入。

转换保持 scope/revision；每批转换在事务中完成，中断后按尚未转换的行继续。被裁剪历史通过 floor 明确失效，不能恢复已丢失历史，也不猜测修复历史上已漏改的 main。回滚需要恢复备份及旧应用，仅回退代码不足以恢复旧 schema。

隔离验证：`pnpm exec tsx --tsconfig scripts/tsconfig.json scripts/verify/reference-history.ts`。此命令限定 development 与回环 MySQL，使用本地 root 创建随机测试库，验证空库完整迁移、存量批次转换、中断重跑、批次上限与事务回滚，最后清理自己创建的库；不对业务库执行迁移。

### 新迁移约定

入口调用 [define_migration](../../scripts/migration/contract.ts)，提供 `plan`、`apply`、`verify`。execution 默认 maintenance；只有短小且与在线版本兼容的步骤才显式标为 automatic。

- 模块顶层无副作用。plan／verify 只查询，返回安全的计数、问题码及摘要，不泄露正文、密钥、签名 URL 或检查点内容。
- 只读上下文仅允许单条 SELECT／SHOW／EXPLAIN，且在只读事务中执行；它不是对 Node 或任意 SDK 调用的沙箱。
- `ctx.transaction` 将业务修改与 `ctx.checkpoint.save` 原子提交。事务不可嵌套，不要手动管理事务或在其内执行 DDL／远程 OSS 操作。
- 检查点上限 64 KiB；逐对象身份、目标版本、摘要、分片等信息使用领域迁移明细表。
- `ctx.oss()` 按需构造受执行权检查的 SDK；其他外部客户端需要显式检查 `ctx.assert_active()` 和 signal。
- 有界分页，在批次边界检查停止请求。不可变对象 key、持久回执和重入校验共同处理云端提交结果未知的情况。
- 新版本排在所有已完成或已开始版本之后，并更新冻结测试。不能修改历史依赖闭包来修复新行为。

## 迁移专用表必须有退出方案

**迁移完成不等于恢复责任结束，也不等于明细表永久保留。新增迁移专用表的同一个 PR 必须说明用途、使用者、保留起点／期限、归档证据、未完成责任和删除条件。没有退出方案，不新增这类表。** 小量进度使用现有 `migration_runs.checkpoint`；确实超出 64 KiB 或需要逐对象持久身份时才新增明细表。不要为每次格式变更复制一套永久业务表。

- `migration_runs` 是永久的版本完成事实，不随明细归档删除。仍供运行时去重、迟到副作用仲裁、对象保护使用的账本不按临时表处理，也不套用通用 TTL。
- 迁移明细退出分为验收、保留、归档核验、责任交接、独立退役迁移。保留期限到达只是允许复核，不触发后台自动删表。遇到恢复需求、失败／未知结果、未交接保护责任，记录原因并延后复核。
- 归档要保存匹配版本的完整数据库备份、迁移身份及明细，并记录 SHA-256、行数、保管位置和访问权限；在隔离库读回核对，不能仅确认“文件存在”。沿用 1Panel 数据库备份职责，不新增应用层备份系统。含源快照或历史密钥的材料按生产秘密保护，不放 Git、PR 正文或公开日志。
- 删除通过新的维护迁移完成，前置核对指定迁移的 completed／finished_at、归档及责任交接证据，支持 DDL 部分执行后重入。同步移除在线查询、CLI、打包入口、过时测试和文档；保留冻结历史迁移及其依赖，验证空库全链仍能重放。不能用手改旧迁移、清空 `migration_runs` 或直接在管理界面删表代替。

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

隔离验证沿用 `pnpm exec tsx --tsconfig scripts/tsconfig.json scripts/verify/webp-migration.ts`，覆盖非空拒绝、DDL 中断重入、归档原图和 WebP 回执保留，以及删表后现行 OSS 对账查询。

## 生产产物与维护容器

[maintenance:build](../../scripts/migration/maintenance-build.ts) 将入口打包到 `.output/server/maintenance/`，TS 清单和 `.mjs` 位于 `migration-scripts/`。生产不依赖 tsx 或工作区源码加载器。Sharp 原生依赖单独交付，`native-manifest.json` 校验文件摘要；镜像必须在目标平台构建。

在已经核对新镜像、生产 Compose、环境和备份，并停止所有业务写入后，可以使用一次性容器执行：

```sh
docker compose --env-file .env.prod run --rm --no-deps app node .output/server/maintenance/migrate.mjs --status
docker compose --env-file .env.prod run --rm --no-deps app node .output/server/maintenance/migrate.mjs --dry-run
docker compose --env-file .env.prod run --rm --no-deps app node .output/server/maintenance/migrate.mjs --maintenance
docker compose --env-file .env.prod run --rm --no-deps app node .output/server/maintenance/migrate.mjs --status
```

`compose run` 使用服务配置运行一次性命令且默认不发布服务端口；`--rm` 清理退出的临时容器，`--no-deps` 不额外启动依赖。见 [Docker 官方说明](https://docs.docker.com/reference/cli/docker/compose/run/)。命令本身不会拉取指定新镜像或冻结其他实例，执行前仍要核对实际 image ID、网络与目标数据库。

普通容器启动会先 migrate 再启动应用。维护门禁是预期行为，遇到它应安排维护步骤，不能删除门禁或改成 baseline。

## checksum 不一致

### 共享云端草稿切换

`20261030120000_shared_content_drafts.sql` 新增独立当前草稿表，将所有 main 原文字节、namespace/title 基线及发布 revision 回填为一对一 draft，不导入浏览器数据。先在维护窗口停旧写者、核对目标库和完整备份，执行同版本 maintenance 包，再核对数量、BINARY 文本相等及基线；检查 `migration_runs` 的成功回执后才启动 cloud-v1 应用。旧客户端的 main 直写被拒绝，无双写回退。

原迁移及已开始 TS bundle 的 digest 保持冻结；历史 outbox 等依赖通过对应快照固定，不把当前运行时的草稿逻辑带进旧 bundle。隔离演练入口为 `pnpm exec tsx --tsconfig scripts/tsconfig.json scripts/verify/cloud-drafts.ts --mqtt --capacity`，生产执行不包含在开发验收授权内。首次跨协议失败停止应用并保留 draft/main，不能自动重启旧写者；恢复边界见[备份恢复](backup-recovery.md)。

### 摘要核对

先比较冻结清单、数据库回执、部署产物和原始文件，不直接更新账本。

- 真正的历史编辑：恢复原始字节及历史依赖实现；功能修复追加新版本。
- 历史 Windows CRLF/LF 差异：只有能证明已记录摘要正好对应同一文件的 CRLF 字节、内容没有变化时，才可定点修正实际账本并规范化工作副本。保留核对证据，不批量重写 checksum。
- TS 变化：同时检查依赖闭包、构建工具、Sharp 包身份及 native manifest。不能只恢复入口文件就宣称版本相同。

行尾修复时先记录原始回执、工作副本／Git 中 LF 版本的 SHA-256，以及同一内容转换为 CRLF 后的 SHA-256。只有旧回执恰好匹配后者才属于已证实的行尾问题。升级前若回执仍只存在 `schema_migrations`，修正实际来源行；升级完成后只处理 `migration_runs`，不要重建旧表。更正后还要检查工作副本确实为 LF，否则下一次本机执行可能再次记录 CRLF 摘要。文件恢复使用能保留字节的方式，并重新计算摘要，不用可能改写编码的 PowerShell 文本重定向代替。

具体 Content 维护步骤、源 pin 与恢复材料见 [Content 切换](./content-cutover.md)，隔离演练见[测试说明](../development/testing.md)。
