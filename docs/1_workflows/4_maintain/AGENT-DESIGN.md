# AGENT-DESIGN：维护操作说明

- 本文档状态：DONE
- 覆盖范围：运维工具交付、迁移恢复、存储审计、备份恢复、EMQX 维护与故障排查
- 上位文档：[SID#1.4.DESIGN](DESIGN.md)、[SID#1.3.DESIGN](../3_deliver/DESIGN.md)
- 被权威文档引用：[SID#1.4.DESIGN](DESIGN.md)（OSS 权限配置、备份恢复与故障排查）；本文仍为非权威文档
- 核对记录：本次源码基线、历史验收边界和旧资料去向见 [SID#1.4.AGENT](AGENT.md)

日常命令入口与停写要求见 `SID#1.4.DESIGN`；本文补充专项操作。涉及生产写入、维护发布或代码回退时，按 `SID#1.3.DESIGN` 的流程执行。

## 运维工具的交付范围

[Dockerfile](../../../Dockerfile) 将构建产物交付到镜像的 `/app`；[维护工具构建器](../../../scripts/migration/build.ts) 额外打包以下入口，均位于 `/app/.output/server/maintenance/`：

| 工具 | 镜像内入口 | 用途 |
| --- | --- | --- |
| 数据库迁移 | `migrate.mjs` | 查询、预演及执行 SQL／TS 迁移；生产维护执行由 Maintenance Deploy 编排 |
| OSS 专项盘点 | `storage-inventory.mjs` | 只读盘点配置、对象版本、删除标记及 multipart |
| 发布检查 | `release.mjs` | 部署流程内部的计划核对、数据与公网验收、回退判定及回执生成 |

后台状态、独立 worker、样本导出和预热检查尚无独立的镜像内 CLI，使用具备源码、依赖和目标连接的环境运行对应 pnpm 命令。ESA 发布在源码环境或 CI 执行，见 `SID#1.3.DESIGN`。

服务器上的 Compose 命令在部署目录执行。先核对 Compose 的镜像版本与目标库；容器内工具继承服务环境，示例无需再追加 `:prod`。源码 pnpm 命令中，进程已注入的同名变量优先于 `.env.prod`；Compose 容器临时覆盖须用 `-e` 显式传入。使用 SSH 转发时也要核对实际连接目标。

## 迁移查询与失败恢复

迁移编写与冻结产物见[开发补充](../1_develop/AGENT-DESIGN.md)，隔离重放见[测试补充](../2_test/AGENT-DESIGN.md)。本节处理已有版本的执行状态；生产维护先按 [SID#1.3.DESIGN](../3_deliver/DESIGN.md) 停写、备份及授权具体计划。

### 接管历史 Content 数据

接管旧档案、附件或存储时，使用与历史数据匹配且仍包含对应迁移的发布版本。保留冻结产物、源 YAML、旧源读取凭据和 AES 恢复材料。目标使用新 OSS 配置，重演时核对源和目标各自的身份。

先在隔离的生产副本完整预演，再在同一个停写窗口内完成最终备份、迁移、新应用与 ESA 发布及业务验收。2026-10 那次切换的对象复制、图片角色、分阶段命令和放行清单是历史记录，原文在 git tag `docs-legacy-final` 的 `docs-legacy/operations/content-cutover.md`；切换留下的明细表见本文[迁移明细归档与退役](#迁移明细归档与退役)，恢复材料的保管与恢复核对见[备份与恢复](#备份与恢复)。

### 先读状态

| 参数 | 用来判断什么 |
| --- | --- |
| `--status` | 版本、阶段、尝试次数与安全错误码；不导入执行脚本 |
| `--dry-run` | 预演当前可执行的首个待办脚本；出现 `blocked_by` 时，后序脚本还没有得到预演 |
| `--preflight` | 分类完整待办链，取得数据库身份、账本与内容指纹；不执行脚本的 plan／apply／verify |
| `--through <完整文件名>` | 限定到当前基线或其后的版本，仍包含该目标之前的全部待办。执行更早的目标须使用定基线前的发布版本 |

只读入口仍会连接数据库并获取 `stupig_tv_migrate` 命名锁。目录包含 TS 迁移时，源码入口也会构建、校验产物。只读不会初始化账本或执行 apply。查询参数互斥，且不能与 `--maintenance`、`--retry-sql` 混用。

`migration_runs` 中 `status=completed` 且 `finished_at` 非空才构成完成回执。空库执行 [基线 SQL](../../../migrations/20261112150000_baseline.sql)（预检显示 `action: initialize`），基线和它覆盖的 SQL 回执一起提交，再执行基线之后的迁移。存量库首次升级时，预检逐项核对基线所需的历史回执，包含已退役迁移的原摘要，并把登记基线列为维护操作（`action: record`）。已有业务表但没有账本、仍有旧账本或缺少所需回执的库，须先用定基线前的发布版本完成迁移并核对数据。

`legacy_ledger` 表示发现旧账本 `schema_migrations`。`baseline_prerequisites` 表示存量库尚未达到基线要求，日志中的 `missing_receipts` 列出缺失版本。`baseline_catalog` 表示基线前的 SQL 与冻结清单不同，按下文核对摘要。`--baseline` 已废弃，历史目标须用匹配的旧版本执行，当前版本的 `--through` 和 `--retry-sql` 均从当前基线起算。

保留这份唯一账本和失败事实，不伪造完成记录。涉及破坏性操作时取得明确授权，尽可能准备备份与可行的恢复方案。当前工具没有通用 `down`，回退代码不会自动撤销数据变更。

### 按失败阶段处理

1. 保存目标 DB 身份、应用／工具镜像身份、原命令、日志和账本状态。维护失败期间保持停写。
2. 遇到 `lock_busy`，先定位另一执行者；等待其正常退出，不并行启动更多迁移。连接中断或进程收到停止信号后，已经发出的 OSS 请求可能继续，须按持久回执核对结果。
3. **SQL 为 running／failed**：先检查哪些 DDL 已落地，确认原文件可安全重入。只有核对完成后，才在恢复方案中使用 `--retry-sql <完整文件名>` 明确允许重试；用 `--through` 限定本次恢复范围。Maintenance Deploy 不会自动替你重试可能部分执行的 SQL。
   空库基线包含不可重复执行的 DDL。若基线中断，先检查原本为空的目标库和已落地结构，再选择恢复到初始化前或使用经核对的修复方案。
4. **TS 停在 apply**：使用同一冻结版本和依赖、同一目标重跑，从持久检查点恢复；外部结果未知时先对账。**停在 verify**：修复验证发现的问题后重跑，会重新 plan／verify，不再重做 apply。
5. 重试后再查 `--status`，确认预期版本及完成回执，再按发布流程做数据、服务和业务验收。不删除失败记录或把 completed 改回 pending 来强迫重跑。

执行边界见[迁移 CLI](../../../scripts/migration/cli.ts)和[执行器](../../../scripts/migration/runner.ts)。未带 `--maintenance` 时，整个待办链先通过在线执行分类才开始写入；维护标志本身不会停止任何写入者。

### 摘要不一致

先比较冻结测试、数据库回执、实际部署产物与原文件。若确有历史文件被改动，恢复原始字节，修复另加新版本。TS 迁移执行完应定新基线并删除，避免依赖演进导致的摘要变化（见 [开发补充](../1_develop/AGENT-DESIGN.md#ts-迁移生命周期管理)）。

只有证明旧回执精确匹配同一内容的 CRLF 字节、与规范 LF 版本没有其他差异，才可定点修正实际账本并规范工作副本。修正前保留原回执及两种字节的 SHA-256。用保留字节的方式恢复文件，完成后重新计算摘要；不通过批量改 checksum 绕过冻结校验。

## OSS 专项盘点

### 准备权限

按 [SID#1.0 的 RAM 配置](../0_setup/AGENT-DESIGN.md#4-建-ram-用户并填各自的密钥)，盘点使用独立用户；OSS 应用用户保持各自的 app 策略。

| 环境 | 独立 RAM 用户 | 自定义策略 JSON（策略名为文件名去掉 `.json`） |
| --- | --- | --- |
| 开发 | `stupig-oss-inventory-dev` | [stupig-oss-inventory-dev-readonly.json](../../../config/ram/stupig-oss-inventory-dev-readonly.json) |
| 生产 | `stupig-oss-inventory-prod` | [stupig-oss-inventory-prod-readonly.json](../../../config/ram/stupig-oss-inventory-prod-readonly.json) |

1. 在 RAM 的自定义权限策略中按 JSON 核对或创建同名策略，确认默认版本内容及资源桶与目标环境一致。
2. 在 RAM 用户中创建或选中上表的独立盘点用户，为其添加对应的自定义策略。接手已有用户时核对直接授权和用户组，保持该用户仅具备盘点权限。
3. 创建或取得该盘点用户的 AccessKey，通过受控方式将 `ALIYUN_OSS_ACCESS_KEY_ID`、`ALIYUN_OSS_ACCESS_KEY_SECRET` 注入运行命令的终端环境；源码命令会优先使用进程中的值，容器命令须用 `-e` 显式传入。

策略允许读取桶版本控制、生命周期、对象版本、multipart 和分片信息。盘点凭据只用于本次执行环境，业务 `.env.dev`／`.env.prod` 保持应用身份；JSON 没有自动到期，临时授权须在完成后解除。创建与绑定的初次配置以 `SID#1.0` 为准，本节不假定这些用户或云端绑定已经存在。

默认模式还需连接目标数据库，以只读会话核对对象归属。数据库不可达时不会自动降级；只查 OSS 元数据须显式使用 `--metadata-only`。该模式不加载数据库配置或连接数据库，归属为 `unverified`，不产生清理候选，`protection_checks_complete=false`。

从本地连接生产 MySQL 可使用仅监听回环的 SSH 转发，再在执行终端临时覆盖 `MYSQL_HOST`／`MYSQL_PORT`；结束后还原变量并关闭隧道。库版本不足会报 `database_schema_mismatch`，不会将无法查询归属解释为无引用对象。

### 执行与续跑

以下命令均在已注入对应环境盘点用户凭据的终端执行。在源码仓库执行：

```sh
pnpm storage:inventory:prod --parts --output .data/oss-inventory-prod
```

仅查看开发桶元数据时使用独立目录：

```sh
pnpm storage:inventory:dev --metadata-only --parts --output .data/oss-inventory-dev-metadata
```

在生产服务器上，将报告和断点挂载到宿主机：

```sh
: "${ALIYUN_OSS_ACCESS_KEY_ID:?请先注入盘点用户的 AccessKey ID}"
: "${ALIYUN_OSS_ACCESS_KEY_SECRET:?请先注入盘点用户的 AccessKey Secret}"
mkdir -p .data/oss-inventory-prod
docker compose --env-file .env.prod run --rm --no-deps \
  -e ALIYUN_OSS_ACCESS_KEY_ID -e ALIYUN_OSS_ACCESS_KEY_SECRET \
  -v "$PWD/.data/oss-inventory-prod:/inventory" \
  app node /app/.output/server/maintenance/storage-inventory.mjs --parts --output /inventory
```

默认每次最多 50 次 OSS 逻辑请求、60 秒预算，每页 25 项。预算耗尽时重复原命令续跑，也可增加 `--max-requests` 或 `--max-seconds`。单次请求可能超出剩余预算，命令不会在预算到点时强制中断请求。

请求间隔默认 100 毫秒，可用 `--pause-ms` 调整；OSS 单次超时取配置值与 30 秒中的较小值，数据库 SELECT 最长执行时间为 5 秒。增大整轮预算不会同时放宽这些单次限制。

默认扫描全桶，`--prefix` 可缩小范围；候选年龄默认 30 天，`--min-age-days` 最低 7 天。`--parts` 逐任务统计分片字节，不加时大小为未核实。版本年龄取 `LastModified`，multipart 年龄取 `Initiated`；前者不是成为历史版本的时间，不能拿它代替生命周期的非当前版本保留天数。

续跑保持同一目标及 `--prefix`、`--page-size`、`--min-age-days`、`--parts`、`--metadata-only` 等扫描参数。更换目标、模式或扫描参数，以及开始新一轮完整盘点时，使用新的输出目录；已完成的旧断点不会自动重新全扫。

| 退出码 | 含义与处理 |
| --- | --- |
| `0` | 所选范围完成；仍须查看报告中的归属核对和分片统计是否完整 |
| `2` | 未完成；查看报告中的权限或查询错误，预算耗尽则续跑 |
| `1` | 参数、连接、断点或文件写入失败；修复具体错误后重试 |

### 查看报告

输出目录中的 `report.json` 是汇总，`checkpoint.json` 用于续跑，`records-*.json` 是详细清单。先看 `complete`，再看 `protection_checks_complete` 和 `multipart_bytes_complete`；纯元数据模式完成不表示已核对数据库归属。

详细清单含对象 key、版本号和 upload ID，按运维资料保存，不提交仓库。汇总对象记录时，只读取同一 `target`、且批次 `revision` 不超过报告 `committed_revision` 的文件，避免计入异常中断留下的未提交批次。

对象类型和动作分类是同一总量的两种分组，不能相加；multipart 大小是已观察到的分片字节，不是账单。目标绑定环境、桶、endpoint、实际 MySQL UUID 和库名；仅改变 SSH 转发的本地端口不改变目标身份。

盘点工具只发 OSS GET 和数据库 SELECT，不删除对象、终止分片或提交清理任务。清单中的 `executable: false` 表示观察结果，候选年龄或分类不能直接作为删除依据。实现见[盘点入口](../../../scripts/storage/inventory.ts)和[扫描执行器](../../../scripts/storage/inventory-run.ts)。

## 后台任务与日常存储审计

先用 DESIGN 中的 `background:status:<env>` 查询持久状态，再结合目标应用／worker 日志。CLI 的 `process: null` 正常；它拿不到另一个进程的内存统计，应用状态也不是集群总览。加 `--storage-findings` 返回当前目标前 100 个未关闭异常。

『控制台·只读』（`admin_access:readonly`）可调用 `admin.getBackgroundStatus` 查看运行状态。异常数汇总所有存储桶。`admin.getStorageAuditFindings({ page: 1, page_size: 10 })` 读取当前配置桶的明细，可传入 `kinds` 匹配其中任一类型。接口返回该页的 `rows`、匹配总数 `total` 和实际页码 `page`。页码从 1 开始，每页最多 154800 条。见[控制台路由](../../../server/trpc/routers/admin.ts)。

控制台的「运行状态」（`/admin?view=status`）集中显示任务与存储异常。旧地址 `?view=tasks` 也进入此页，`?view=storage` 会滚动并聚焦「存储审计」标题。在「异常明细」区按「读取异常明细」，或在 TODO 区的存储异常行按「查看明细」，可查询当前桶的对象记录。按下表核对和处置异常。[控制台说明](../../2_domains/3_admin/AGENT-DESIGN.md#视图切换)

日常 `storage_audit` 随 runner 滚动扫描当前对象并写检查账本；专项盘点额外读历史版本、删除标记和 multipart，两者范围不同。先按异常类型处理：

| 异常 | 操作 |
| --- | --- |
| `missing_object`、`size_mismatch` | 核对业务指针、发布回执、备份与精确对象版本 |
| `public_object` | 核对对象 ACL 并恢复 private，随后复查真实读取权限 |
| `invalid_reference` | 查明 key／命名空间及引用来源，不猜测改写 |
| `orphan_candidate` | 核对任务、尝试、迁移 pin 和其他归属，候选不等于获准删除 |
| `unregistered_static`、`unmanaged_object` | 确认所属业务；合法静态图标补 `app.storageAudit.staticKeys`，其他命名空间交原业务处理 |
| `retired_object_present` | 查迟到写入及退役回执，保留精确对象身份 |

修复后由完整扫描和异常复查更新状态，不手改游标或完成标志。403、超时等不按对象缺失处理。默认关闭的 `orphanCleanup` 仅对符合规则的 Content 不可变对象工作，启用前保留一至两周观察期，核对至少两个连续完整周期及对象身份；通过既有退役通道软删除并完成 ESA 刷新，不永久清除历史版本。详细保护与清理机制见 [SID#2.5.AGENT-DESIGN 的存储审计](../../2_domains/5_operations/AGENT-DESIGN.md#存储审计)。

源码独立 worker 只接受 `mode=worker`；`disabled` 保留待办但不消费。切换需协调全部实例，不能仅改生产 YAML 就得到尚未交付的 worker 服务。退出时允许已有任务保存检查点；生产 Compose 的 45 秒宽限覆盖默认 30 秒收尾预算，已发出的云请求仍可能继续。预热停滞时先查开关、`deliveryVerified`、共享站点额度与安全错误码，再决定是否恢复；检查命令本身不提交预热。

## 开发样本与重置

`db:dump:dev`／`db:dump:prod` 的后缀表示来源数据库，输出都用于开发样本。工具替换手机号、用户密码列和 IPv4。所有样本账号使用同一个开发密码，包括原本未设置密码的账号。正文、对象信息与历史恢复材料仍可能敏感，须受控保存。导出参数及容器选择见 DESIGN，实现见[样本导出](../../../scripts/db/export-sample.ts)。

`content:reset:dev` 默认只盘点。核对数据库和开发桶，停止应用及其他写入者，保存需要的开发数据后再加 `--apply`。工具限定 development、本机数据库和独立开发桶。

默认只根据数据库记录推导对象。重建数据库后记录已经丢失，要加 `--all-content-objects`，额外扫描 `content/` 和 `content-upload/` 下的当前对象与未完成上传：

```powershell
pnpm content:reset:dev --all-content-objects
pnpm content:reset:dev --apply --all-content-objects
```

`--apply` 会清掉开发库的档案、草稿、任务等 `content_` 表数据，并推进标题命名空间的版本。工具先把记录写入 `.nuxt/content-reset/`，提交数据库事务后才清理对象。看到 `database-cleared` 后若对象清理中断或失败，用输出中的记录续跑：

```powershell
pnpm content:reset:dev '--manifest=.nuxt/content-reset/替换为记录文件名.json'
```

阿里云对象走软删除，历史版本按桶策略保留。清理完成后，重复同范围的只读盘点，确认 `tracked_objects` 为 `0`。[开发重置](../../../scripts/content/reset-dev.ts)

## 备份与恢复

### 日常备份

在 1Panel 查看生产数据库的备份任务，核对最近成功时间、保存位置和保留期，并确认备份文件可读取。定期备份由现有运维计划负责；维护发布前的临时备份单独保存。

`pnpm db:dump:<env>` 会改写手机号、密码哈希和 IPv4，仅用于开发样本。数据库备份也不包含 OSS 对象内容或 ESA 控制台设置，恢复前须分别确认对象版本与对应配置仍可取得。

按同一恢复窗口保存以下材料，记录位置、访问权限、摘要与保留期；新备份不要覆盖唯一旧副本：

| 材料 | 至少保留 |
| --- | --- |
| 数据库 | 一致性快照、迁移账本、对象生命周期和通知账本；需要时间点恢复时还须核对实际日志能力 |
| 对象 | 桶、精确 key／version ID、大小和摘要，以及可读取的对象字节；生命周期不受应用迁移 pin 约束 |
| 发布与配置 | commit、app／broker 镜像身份、Compose、env 密文及可用密钥版本，ESA 函数／路由／变量／缓存规则 |
| 外部设施 | RAM、反代／TLS、EMQX ACL／认证、数据库及其他服务的持久化配置 |
| 历史迁移 | 源快照、旧 AES 恢复材料、对象回执和 pin；按生产敏感资料保存 |

密文与解密口令分别保管。发布回执和 `.bak` 的保留边界见[交付补充](../3_deliver/AGENT-DESIGN.md)，定期备份的频率、异地副本和实际恢复目标由现有运维计划确认。

### 维护发布前备份

按 `SID#1.3.DESIGN` 停止外部 worker、cron，并授权具体的 Maintenance Deploy 计划。记录已经发出的云端任务，停写不会撤销这些请求，未知结果按回执核对。工作流会停止受控应用，导出数据库，再导入同一 MySQL 实例中新建的临时 QA 库，比对全部表的数据导出。验证结束后删除 QA 库；通过验证后才执行生产迁移。

当前自动备份适配同主机的 Docker MySQL。默认容器名取应用 DB host；若它是网络别名，通过仓库 Variable `MYSQL_BACKUP_CONTAINER` 指定真实容器名。容器须提供 `MYSQL_ROOT_PASSWORD`，实际 MySQL UUID 须与计划一致，目标库须没有其他连接。当前适配器只接受 InnoDB 基表，且没有视图、触发器、存储程序、事件或跨库外键；远程数据库或其他结构需要专用方案。

备份位于服务器部署目录的 `.release-plans/<plan_id>/recovery-*`：

| 文件 | 用途 |
| --- | --- |
| `database.sql`、`database.sha256` | 数据库备份及摘要 |
| `restore-verification.txt` | 临时库恢复后，全部表数据比对成功的记录 |
| 旧环境文件、`docker-compose.yml` | 备份时的运行配置 |
| `candidate.env` | 此次计划的新运行配置 |

计划目录还保存 `backup-verification.log`、`maintenance.log`、`data-verification.log` 等阶段日志。备份与环境文件含敏感数据，保存在受控位置；工作流不会把原始 SQL 备份上传到 CI artifact。

备份阶段失败、尚未执行生产迁移时，工作流可恢复此前运行的旧应用；生产维护命令一旦开始，后续失败保持停写并保留现场，按故障排查处理。对应实现见[服务器部署脚本](../../../scripts/deploy/remote.sh)。

### 误操作后的恢复

1. 在服务器部署目录执行 `docker compose --env-file .env.prod stop app`，同时停止独立 worker、cron，暂停其他发布，保留当前日志与账本。
2. 记录误操作时间及受影响的数据、对象 key 和版本号，选择误操作之前的 1Panel 备份或维护发布备份。
3. 先将备份导入新建的测试数据库，核对受影响正文、附件引用和账号权限。涉及附件时，确认对应 OSS 对象版本仍在，并在隔离环境验证读取。
4. 根据核对结果制定局部修复或整库恢复方案，核对应用版本与迁移账本兼容性，并处理恢复点之后的合法更新，再实施生产恢复与服务验收。

恢复 cloud-v1 数据时，main、draft、引用历史、对象指针与读取 revision 须协调恢复，不能只还原 main 或一个对象 key 后开放读取。验证 ESA 授权、缓存及后台生命周期后再恢复服务；租约自然到期，不导入浏览器凭证或伪造命令回执。首次跨协议失败不启动旧的无租约写入者，优先修复兼容应用或制定整套备份恢复方案。

项目没有通用的一键恢复命令；回退镜像不会撤销数据库或外部对象变更。恢复须保留 completed 回执和 migration pin，不通过改账本或解除对象保护绕过校验。历史 Content 数据的源快照、复制回执和对象角色在本文[迁移明细归档与退役](#迁移明细归档与退役)列出的表里，历史恢复演练及未覆盖范围见 [SID#1.4.AGENT](AGENT.md)。

### 迁移明细归档与退役

迁移完成后先确认恢复、对象保护和清理责任是否已结束。一般流程为验收 → 保留 → 归档读回 → 责任交接 → 新增独立维护迁移；到期只允许复核，不触发自动删表。`migration_runs` 永久保留，运行时去重、迟到结果仲裁或对象保护账本也不能套用临时表 TTL。

归档保存匹配的完整数据库备份、迁移身份及全部明细，记录 SHA-256、行数、位置和权限，并在隔离库读回核对。存在未知外部结果、待恢复数据或未交接 pin 时延后退役。删除迁移须检查归档和责任证据，支持 DDL 部分执行后重入；同步移除在线消费者，保留冻结历史迁移和空库重放能力。

现存的迁移明细表及其退出条件：

| 表 | 保存什么 | 退出条件 |
| --- | --- | --- |
| `content_migration_references` | 旧 Content 切换时的原始正文和引用转换备份 | 与下面三张一起，按旧源退役处理 |
| `content_migration_scopes` | 源行快照、档案切换状态与结果指纹；可能含历史 AES 恢复材料 | 同上 |
| `content_migration_objects` | 逐角色的源／目标身份、分片、大小、摘要与对象回执 | 同上 |
| `content_migration_pins` | 阻止旧源对象被日常退役提前回收 | 同上；对象退役和存储审计会读它 |
| `content_webp_migration_objects` | WebP 维护迁移（`20261101133000_content_webp.ts`）逐附件的源身份、目标所有权、结果与采用回执；迁移完成后应用不再写 | 见下 |

旧源退役是独立的显式阶段：确认保留窗口结束、没有回滚需求后，按精确对象清单处理并释放 pin；不能清空迁移表或递归删除桶前缀。日常退役只负责正式替换和删除的对象，不是回收站。

WebP 回执表：新基线创建空表，存量库保留已有回执。

1. 起点与期限：生产迁移 completed 且 `finished_at` 非空，WebP／JPEG 读取和编辑、删减验收都已通过，以两者较晚的时间为起点保留至少 30 个完整日，起点和复核日期写进该次维护发布记录。开发演练时间、PR 合并时间不算起点。
2. 归档：保留对应的 1Panel 完整备份，把表结构、全部行和相应 `migration_runs` 完成记录导出到受保护的 `.migration-backups/<release>/webp-receipts/`，记下应用提交／镜像、迁移摘要、数据库身份、行数和归档 SHA-256，并在隔离库导入核对 adopted 数及源／目标身份。归档是恢复材料，不能公开。
3. 退出核验：所有行 `adopted = 1`，没有待恢复、未知写入、未核验产物或未完成的清理责任。目标后来被正常更新替换是合法的，按对象回执和退役记录核对，不要求旧目标仍是当前展示对象。遗留责任先交接到现有对象账本或保留清单。
4. 对象保护分开处理：归档或删除回执表不删 OSS 对象，也不批量释放 `content_migration_pins`。
5. 最终退役：证据齐全、期限已到并明确授权后，在后续 PR 追加独立维护迁移删表，保留 `migration_runs` 和归档。版本链里不预排立即删表的版本，也不在迁移的 finally 或定时任务里清表；删表迁移的 plan 要检查完成回执、归档核验和责任交接证明，缺一不可。

## EMQX 升级与凭据轮换

### 保留数据与节点身份

升级前核对当前／目标版本的支持路径、`durable_sessions.enable`、节点身份和实际卷挂载，保存逻辑导出；停 broker 后备份数据与配置，在隔离副本验证。生产使用 `mqtt-data`／`mqtt-log` 命名卷和固定节点 `stupig@127.0.0.1`；开发镜像的数据／日志使用匿名卷，重建前后也要核对挂载身份。升级保留原卷；旧镜像不能直接读取新版本已经改写的数据，回退需要匹配版本的备份。

开发环境确认备份后，可按顺序执行 `docker compose --env-file .env.dev -f docker-compose.dev.yml pull emqx` 和同前缀的 `up -d --no-deps emqx`；生产版本、ACL 和 Compose 配置通过正常发布交付。避免 `down -v`、更换空卷或清空 Mnesia 排错。版本升级限制按选定版本的官方说明复核，历史本机升级结果见 AGENT。

### 轮换发布账号

bootstrap 只初始化缺失用户，不覆盖内置库中已有用户；只改 `.env.prod` 后重启会造成凭据不匹配。轮换步骤：

1. 在隔离实例验证受控 CLI／API 的账号管理方式，然后在生产保留旧账号并创建第二个超级发布账号。
2. 从获准内网验证新账号，再更新应用与 broker 共用的 `MQTT_USERNAME/PASSWORD`，重新加密环境文件并部署。
3. 确认健康检查、新连接发布和实际收消息成功后，撤销旧账号并断开旧连接。Dashboard 保持关闭，凭据不进入日志或仓库。

生产诊断通过包装入口使用一致的节点 Cookie：

```sh
docker compose --env-file .env.prod logs --tail 80 emqx
docker compose --env-file .env.prod exec emqx /bin/sh /opt/emqx/etc/production-entrypoint.sh --cli ctl status
docker compose --env-file .env.prod exec emqx /bin/sh /opt/emqx/etc/production-entrypoint.sh --cli ctl conf show authorization
```

配置和 ACL 由镜像及 Compose 管理；手动修改 Dashboard 可能在重启后被覆盖，变更后要重连验收。应用使用可信项目网络内的 TCP；改端口不会自动启用 TLS。当前超级发布账号及全局 deny 以专用 broker 为前提，共享 broker 需要另行设计 listener、认证与授权隔离。

两条公网 WSS 的反代及权限验收见[测试补充](../2_test/AGENT-DESIGN.md)。公开连接应匿名订阅但不能发布；草稿连接需要动态票据。区分 HTTP 101、MQTT CONNECT、SUBACK 和真实收发结果，不能把任一步单独当完整验收。broker 恢复后检查 Content outbox 积压，不清空待办掩盖故障。接线依据：[Compose](../../../docker-compose.yml)、[CLI 包装](../../../scripts/deploy/emqx-entrypoint.sh)、[凭据健康检查](../../../scripts/deploy/emqx-healthcheck.sh)。

## 故障排查

服务器状态、应用／broker 日志和迁移查询命令见 [SID#1.4.DESIGN 的迁移查询](DESIGN.md#迁移查询)。先核对失败阶段、实际镜像与目标库，再按下表处理。

| 现象 | 处理 |
| --- | --- |
| 镜像内找不到运维工具 | 对照本文的交付范围，核对 Compose 使用的镜像是否包含对应产物；源码专用入口在源码环境执行 |
| `maintenance_required` | 生产按 `SID#1.3.DESIGN` 走 Maintenance Deploy；`--maintenance` 本身不会停止应用或其他写入 |
| 迁移摘要不一致或 SQL 可能部分执行 | 按本文[迁移查询与失败恢复](#迁移查询与失败恢复)核对，不靠改摘要、删除回执或重复执行掩盖问题 |
| 维护备份失败 | 查看计划目录的 `backup-verification.log`，核对 MySQL 容器、UUID、其他连接和结构限制；确认仍未进入生产迁移阶段 |
| 应用已停止，部署进入维护恢复状态 | 保留计划目录、备份和新旧配置，检查 `maintenance.log`、`data-verification.log`、`rollback-check.log` 中已产生的日志，再决定修复或恢复；此时不直接启动旧写入者 |
| 容器健康但公网验收失败 | 查看计划目录的 `public-verification.log`，检查域名、反向代理及公开／草稿 WSS 的路由与认证；仅检查 `/api/hooks/healthz` 不足以覆盖这些链路 |
| ESA 发布失败 | 按[交付补充](../3_deliver/AGENT-DESIGN.md)查本次回执、失败阶段和线上版本；已部署应用不会因此自动回退 |
| OSS `access_denied` | 核对实际执行身份、环境、桶资源范围和 RAM 策略绑定，修复后续跑；拒绝响应不表示空桶 |
| 盘点断点不匹配或目录被锁定 | 目标、模式或扫描参数改变时换新目录；只有确认对应进程或容器已退出后，才移除遗留的 `run.lock` |
| 本机找不到 `mysqldump` | 直连模式安装本机工具；容器模式设置 `MYSQL_CONTAINER`，并核对当前 Docker 上下文中的目标 MySQL 容器 |
| 授权回调 404／403、附件交付拒绝 | 按[开发隧道诊断](../1_develop/AGENT-DESIGN.md)或生产反代逐段定位；空 JSON 的 403 是拒绝路径，合法请求还须核对证明响应头、GET／HEAD／Range 和完整字节 |
| 浏览器分片上传失败 | 核对签名有效期、分片身份／MD5、CORS origin、PUT、请求头与 ETag 暴露；AccessDenied 先区分实际 RAM、签名上传与 ESA 回源身份 |
| MQTT 有连接但无通知 | 核对实际 broker、公开／草稿 listener、订阅主题、TCP 发布、反代超时和 outbox；用户名／Client ID 前缀不能证明发布权限 |
| 容器 unhealthy 但没有重启 | `restart: unless-stopped` 处理进程退出；仅健康状态改变不会自动使进程重启，先查探针失败层 |

`GET /api/hooks/healthz` 只查询数据库及迁移账本是否可读；tRPC `system.health` 仅返回 `{ online: true }`，连数据库就绪也不检查。应用部署失败后的恢复条件和代码回退流程以 `SID#1.3.DESIGN` 为准。
