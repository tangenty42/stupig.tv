# OSS 全桶对账

`storage_audit` 是现有 runner 的全桶对账适配器，占用一个 OSS 槽。默认 `app` 模式随应用启动，不配置 cron，也不另起重复消费者。扫描只读取 OSS 元数据，写入扫描和异常账本，不终止 multipart、不改业务引用或 ACL。另有默认关闭的孤立对象清理选项，通过已有退役通道执行。

## 覆盖范围

| 方向 | 检查 |
| --- | --- |
| 数据库 → OSS | 正式附件的主对象、归档原图、展示图／回退图及删减版两角色、用户头像、配置登记的静态图标；检查存在性、已知的主对象大小，以及是否存在公有对象 ACL |
| OSS → 数据库 | 无前缀限制、分批列举桶内当前对象；判断正式引用、上传和图片尝试、任务输入、迁移复制/pin、预热和退役归属 |
| 已有异常 → 当前事实 | 单独复查每个旧异常，不因分页中没再看见它就批量关闭 |

这是滚动元数据检查，不是跨 MySQL/OSS 的一致性快照，也不下载全量字节做 SHA-256 校验。新插入到已扫描排序位置之前的对象可在下轮发现。历史对象版本、删除标记与未完成 multipart 不在日常 ListObjectsV2 清单中：版本由 OSS 生命周期管理，已登记上传的 multipart 由上传生命周期账本处理；额外范围使用下述独立专项命令。

## 历史版本与 multipart 专项盘点

在具备目标配置和 MySQL 连接的源码工作区运行：

```sh
pnpm storage:inventory --env=prod --parts --output .data/oss-inventory-prod-20261102
pnpm storage:inventory --env=dev --parts --output .data/oss-inventory-dev-20261102
pnpm storage:inventory --env=dev --metadata-only --parts --output .data/oss-inventory-dev-metadata-20261102
pnpm storage:inventory --help
```

该命令仅发 OSS `GET` 和业务库 `SELECT`，数据库连接先设置 session read-only；不下载对象内容、不计算文件 SHA、不修改云端配置、业务行或日常盘点账本。额外读取桶版本控制、生命周期、全部版本／删除标记、multipart 和可选分片元数据。没有 `--apply`、删除、abort 或清理入队选项；不另设 cron 或 runner。

`--metadata-only` 可在数据库不可达或版本不足时，仅盘点 OSS 配置、版本和分片元数据；不加载或连接数据库，所有对象归属均为 `unverified`，不产生清理候选，`protection_checks_complete=false`。这是显式缩小范围，不会在 DB 查询失败后自动降级；需使用独立 output，不能混用默认模式的断点。此模式退出 0 仅表示所选元数据范围完成。

`--env` 复用现有环境选择；数据库和 OSS 使用对应配置。生产源码命令需要可达的 MySQL；精简应用镜像不包含此 pnpm 入口。需要 SSH 转发时，另建仅本地监听的连接，例如 `ssh -N -L 127.0.0.1:13347:127.0.0.1:3306 <SSH别名>`，在运行命令的终端临时将 `MYSQL_HOST=127.0.0.1`、`MYSQL_PORT=13347` 指向转发，完成后还原变量并关闭隧道。只读会话不要求修改业务数据库结构；开发库版本不足时返回 `database_schema_mismatch`，不会把查不到保护关系当成无归属。

默认每次最多 50 次 OSS 逻辑请求、每页 25 项、请求间隔 100ms、时间预算 60 秒；可用 `--max-requests`、`--page-size`、`--pause-ms`、`--max-seconds` 调整。时间预算在 OSS 操作间检查，已开始的请求和当前页归属复核可以超出预算；OSS 单次 timeout 不超过 30 秒，SQL 设置 5 秒查询执行上限。默认全桶；`--prefix content/att/` 可缩小范围。候选年龄默认 30 天，`--min-age-days` 最低 7 天；年龄只是复核条件，不是删除授权。`--parts` 额外逐任务分页统计已上传分片字节，不加该参数时大小标记为未核实，不能当成 0 占用或实际账单。

输出目录保留 `checkpoint.json`、脱敏汇总 `report.json` 和分批的 `records-*.json`。详细清单／断点含对象 key、版本号、upload ID 和完整生命周期规则，放在 Git 忽略的 `.data` 并按本机敏感运维材料保管；终端汇总不含对象名、游标或签名 URL。汇总按固定命名空间、类型、存储类型、年龄及保护关系分组；`totals` 同时提供对象类型和动作分类，不能将两类 subtotal 相加当总量。分片大小是已观察部分，`multipart_bytes_complete` 才表示该轮所有列举到的 multipart 已完整统计；它不等于计费存储。

版本年龄使用 OSS `LastModified`，multipart 使用 `Initiated`；旧版本的修改时间不等于它成为非当前版本的时间，不能据此复刻生命周期的 noncurrent-days 删除条件。

退出 `0` 表示配置、版本和 multipart 各部分已完成；`2` 表示权限、请求／时间预算或某部分查询失败导致未完成；`1` 为参数、连接、断点或落盘失败。403 明确保留为 `access_denied`，不会伪造“空桶／无异常”。恢复时重复同一 output、prefix、页大小、年龄和 parts 参数，可单独增加本次运行预算；桶、环境、实际 MySQL server UUID 或库名变化会拒绝复用断点，SSH 本地端口变化不影响恢复。新的一轮应使用新的 output，完成的旧断点不会自动重新全扫。

版本游标保留 key 与 version ID，multipart 游标保留 key 与 upload ID；版本 ID 不按字典序比较。记录先落盘再保存断点，中断重放覆盖同一批次文件，不追加重复记录。一个目录只允许一个进程，`run.lock` 存 PID；进程异常退出留下锁时，先证明对应进程已退出再手动移除该锁，不能覆盖活动扫描的锁。退出时只关闭本脚本的数据库连接，不停止应用或 Docker 服务。

消费详细记录时只接受同一 target 且 revision 不超过 `report.json` 的 `committed_revision` 的文件；异常中断可能留下尚未提交断点的下一批文件，不能把它作为有效观察。

### 与清理的衔接

专项清单中的每一项均为 `executable: false`。归属复核复用日常 catalog，检查正式附件各角色、头像、任务／尝试、迁移 pin、预热及退役责任。注册过的 multipart 按精确 key＋upload ID 保留；静态资源和归属不明的命名空间不自动处理。保护关系按 key 保守生效，受保护 key 的全部历史版本均保留，不宣称已逐版本证明“可删除”。

| 分类 | 后续处理 |
| --- | --- |
| `daily_audit_reobserve` | 当前 Content 不可变对象待复核；仍由日常扫描重新观察，满足连续周期和身份／发布互斥后，才可走已有退役、软删除及 ESA 刷新通道 |
| `review_history_retention` | 历史版本保留政策复核；当前不永久删除，后续要单独核对恢复窗口、pin、精确版本及权限 |
| `review_abort_multipart` | 未登记的旧 multipart 待复核；后续终止前需重读 key＋upload ID、分片及任务归属，不能复用当前对象软删除通道 |
| `retain_*`／`review_unmanaged_namespace`／`upload_disappeared` | 保留、人工确认或滚动观察期间已消失；均不构成清理完成证据 |

本轮不会把一次专项观察写成日常扫描的两个完整周期，不启用 `orphanCleanup`，也不使用 `DeleteObjectVersion` 或 `AbortMultipartUpload`。预热、冷回源和 ESA 共享额度仍需单独验收。

权限采用独立的[开发只读补充策略](../../config/ram/stupig-oss-inventory-dev-readonly.json)和[生产只读补充策略](../../config/ram/stupig-oss-inventory-prod-readonly.json)。本轮按临时绑定处理，验收后手动解除；JSON 没有自动到期。未来频繁运行时可使用独立只读身份，并通过现有 `ALIYUN_OSS_*` 变量注入；绑定到现有应用身份不会撤销该身份原本的其他权限。见 [RAM](../deployment/ram.md)。API 口径见 [ListObjectVersions](https://www.alibabacloud.com/help/en/oss/developer-reference/listobjectversions)、[ListParts](https://www.alibabacloud.com/help/en/oss/developer-reference/listparts)。

2026-11-02 [脱敏验证](../reviews/oss-inventory-2026-11-02.json)：生产完成全桶元数据与只读 DB 核对，共 643 个当前版本（579,895,354 字节）、178 个历史版本（441,456,793 字节）、186 个删除标记，multipart 为 0；按本轮 30 天门槛没有复核清理候选。开发仅完成纯元数据范围，321 个当前版本、136 个历史版本、136 个删除标记，multipart 为 0，归属未核实。两环境提交的 1,007／593 条记录与汇总一致、无重复身份；分页、断点、分片续跑和拒绝响应另有测试，真实桶本轮没有可调用 ListParts 的上传任务。

两桶均读回版本控制 Enabled，现有全桶生命周期为非当前版本 7 天过期及过期删除标记清理，未配置 multipart 自动终止条件。本轮未修改这些规则。OSS 生命周期独立于应用 pin 执行；这份读回不等于对象字节恢复或长期备份窗口验收。

## 默认配置

配置位于 `config/shared.yaml` 的 `app.storageAudit`，dev/prod 可以按层覆盖；不会下发给浏览器。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| enabled | true | 登记消费者后允许执行 |
| sweepIntervalSeconds | 30 | 未完成周期的扫描间隔 |
| cycleIntervalSeconds | 86400 | 成功完成后，24 小时再开始新周期 |
| batchSize | 25 | 每批最多处理的引用角色、对象或旧异常数 |
| batchBudgetMs | 15000 | 批次在操作之间检查的时间预算；单次 SDK 请求仍受 OSS timeout 约束 |
| leaseSeconds | 300 | 同一 endpoint/bucket 的跨进程扫描租约 |
| retrySeconds | 300 | 失败后重试间隔 |
| orphanGraceSeconds | 604800 | 无引用对象至少 7 天未修改后才报告候选，按周期开始时间计算 |
| orphanCleanup.enabled | false | 是否将符合条件的 Content 孤立候选交给退役通道 |
| orphanCleanup.minAgeSeconds | 604800 | 清理前对象至少未修改 7 天，配置不能低于此值 |
| orphanCleanup.minObservations | 2 | 至少连续两个完整扫描周期观察到同一对象身份，不能低于 2 |
| staticKeys | 11 个当前图标 key | 静态资源没有数据库行，明确登记才检查缺失；新增图标同步更新清单 |

`storage_audit_targets` 持久化周期、阶段、游标、计数、错误码和租约；`storage_audit_findings` 保存异常和复查状态。阶段为 attachments → avatars → static → objects → findings → completed。每项观察与断点在同一受租约围栏保护的数据库事务中保存；远端请求期间不持有数据库事务。退出只停在操作边界，租约失效或换主后的迟到结果不能写入进度。

目标身份由 endpoint origin 和 bucket 计算，修改目标会建立独立扫描记录，不沿用旧桶游标。中途失败保留进度；403、签名错误、超时和 5xx 不算对象不存在，只有确认的 404 才报告缺失。

## 如何查看

```sh
pnpm background:status
pnpm background:status --storage-findings
```

前者显示本地进程统计、阶段、计数、最近完成时间、下次执行时间、安全错误码及异常分类数量。CLI 是独立进程，`process: null` 正常；后者额外返回当前目标前 100 个未关闭异常。生产精简镜像不含该 CLI，使用 API：

- `admin.getBackgroundStatus`：需要 `admin_access:readonly`，不返回对象 key。
- `admin.getStorageAuditFindings({ after_id: 0, limit: 50 })`：需要 `admin_access:full`；按返回的最后一个 id 翻页，最多 100 条，只列当前目标未关闭异常。不会返回对象内容、签名 URL、AES 材料或原始 SDK 诊断。

## 异常处理

| kind | 含义与处理 |
| --- | --- |
| missing_object | 正式引用的对象缺失；先核对备份、版本和业务指针 |
| size_mismatch | 主对象大小与文件行不一致；核对发布与对象身份 |
| public_object | 对象显式公有 ACL；核对并恢复 private，不能用缓存检查代替源权限检查 |
| invalid_reference | 对象引用不在支持的命名空间或 key 无效；人工核对数据来源 |
| orphan_candidate | 宽限期后的无归属 Content/头像对象；只是候选，不构成删除授权 |
| unregistered_static | 未登记的 `imgs/` 对象；确认合法后补静态清单 |
| unmanaged_object | 桶内其他前缀；先明确所属业务，不能直接当垃圾 |
| retired_object_present | 已完成退役的 key 又出现在桶里；核对迟到写入和退役回执 |

修复对象或引用后，由下一轮完整扫描和异常复查更新状态。不手改 completed、游标或迁移回执来消除提示。

## 可选自动清理

2026-10-25 的 `20261025-e9f50d4e` 发布回执记录当时生产只有扫描。自动清理实现已随 [PR #23](https://github.com/tangenty42/stupig.tv/pull/23) 合并并包含在当前源码中，仓库默认 `app.storageAudit.orphanCleanup.enabled=false`；截至 2026-11-01 的最新生产镜像、实际开关和扫描状态须按[发布信息及回执](../deployment/aliyun.md#截至-2026-11-01-的发布信息)核验。启用前先保留一至两周扫描观察期，再按环境显式启用该开关并重启应用或 worker。

仅 `orphan_candidate` 且 key 符合现有 Content 不可变对象生成规则的对象可进入清理：UUID 主对象、staging/transfers/originals 的任务与尝试 key、images 的 WebP/JPEG key。头像、静态资源、未知路径、目录标记和其他异常均继续人工处理。它们没有同样的退役/发布互斥协议，不能只凭无引用就自动删除。

连续观察次数绑定前一个完整周期；中间恢复引用、异常关闭、对象大小或最后修改时间变化均重新计数。同一周期的重试不增加次数，未完成的扫描不触发清理。清理前重新读取 OSS 元数据，再在事务内锁定完成周期、写入退役墓碑，并重新核对所有附件角色、活动任务、尝试、迁移 pin/复制及预热归属；任何保护命中都会回滚入队。未来发布使用已有对象采用锁拒绝采用退役 key。

入队后由原退役 runner 再核对引用和任务归属，完成源站软删除、404 确认和 ESA 精确刷新，保留原有租约、重试和回执。关闭开关会阻止新的入队及尚未进入删除阶段的此类任务；已经删除或进入刷新阶段的任务继续收尾，避免丢失缓存刷新责任。不永久删除历史版本。修复与清理结果由后续扫描关闭异常，入队本身不伪造『已解决』。

应用 RAM 策略需要指定桶的 `oss:ListObjects`（无 prefix 条件），以及已有受控对象前缀的读取/ACL 权限。2026-10-25 的记录中，两环境 OSS 策略已按授权更新为 v3 并读回一致，只增加全桶元数据列举，没有放开任意前缀的对象内容读取或删除；当前云端绑定需另行核验。参见 [RAM](../deployment/ram.md) 和 [OSS](../deployment/oss.md)。

## 首次验收

2026-10-25 已随 `20261025-e9f50d4e` 部署生产，默认 app runner 自动启动。开发桶完成 22 个引用、318 个对象的扫描；生产桶完成 405 个引用、313 个对象的扫描，均无未关闭异常。隔离 MySQL 验证了 7 类异常的检出、修复后的关闭、并发消费者互斥与租约换主后的迟到结果拒绝；临时移除围栏守卫时测试失败，恢复后通过。候选与生产公开入口各 8 项交付冒烟通过。历史版本和未登记 multipart 仍属于上文明确的范围边界。
