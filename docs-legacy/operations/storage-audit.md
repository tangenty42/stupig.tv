# OSS 全桶对账

> 当前专项盘点和日常存储检查操作见 [SID#1.4.AGENT-DESIGN](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#oss-专项盘点)，核对基线与剩余事项见 [SID#1.4.AGENT](../../docs/1_workflows/4_maintain/AGENT.md)。本文保留对账／清理的领域机制、配置参考和历史盘点结果。

`storage_audit` 是现有 runner 的全桶对账适配器，占用一个 OSS 槽。默认 `app` 模式随应用启动，不配置 cron，也不另起重复消费者。扫描只读取 OSS 元数据，写入扫描和异常账本，不终止 multipart、不改业务引用或 ACL。另有默认关闭的孤立对象清理选项，通过已有退役通道执行。

## 覆盖范围

| 方向 | 检查 |
| --- | --- |
| 数据库 → OSS | 正式附件的主对象、归档原图、展示图／回退图及删减版两角色、用户头像、配置登记的静态图标；检查存在性、已知的主对象大小，以及是否存在公有对象 ACL |
| OSS → 数据库 | 无前缀限制、分批列举桶内当前对象；判断正式引用、上传和图片尝试、任务输入、迁移复制/pin、预热和退役归属 |
| 已有异常 → 当前事实 | 单独复查每个旧异常，不因分页中没再看见它就批量关闭 |

这是滚动元数据检查，不是跨 MySQL/OSS 的一致性快照，也不下载全量字节做 SHA-256 校验。新插入到已扫描排序位置之前的对象可在下轮发现。历史对象版本、删除标记与未完成 multipart 不在日常 ListObjectsV2 清单中：版本由 OSS 生命周期管理，已登记上传的 multipart 由上传生命周期账本处理；额外范围使用下述独立专项命令。

## 历史版本与 multipart 专项盘点

独立盘点用户、数据库只读连接及纯元数据模式见 [SID#1.4 准备权限](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#准备权限)，源码命令和续跑步骤见 [执行与续跑](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#执行与续跑)。该工具额外读取桶版本控制、生命周期、对象版本、删除标记和 multipart；不下载对象字节或计算文件 SHA，也不写日常扫描账本。

### 生产容器入口

容器命令、盘点凭据注入和宿主机输出挂载见 [SID#1.4 执行与续跑](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#执行与续跑)；精简镜像及 Compose 的交付边界见 [运维工具的交付范围](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#运维工具的交付范围)。

### 预算、输出与恢复

预算、超时、扫描范围、退出码及恢复参数见 [SID#1.4 执行与续跑](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#执行与续跑)，输出文件、完成范围和有效批次判断见 [查看报告](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#查看报告)。详细清单／断点还包含完整生命周期规则；终端汇总不含对象名、游标或签名 URL。

版本游标保留 key 与 version ID，multipart 游标保留 key 与 upload ID；版本 ID 不按字典序比较。记录先落盘再保存断点，中断重放覆盖同一批次文件，不追加重复记录。一个目录只允许一个进程，`run.lock` 存 PID；进程异常退出留下锁时，先证明对应进程已退出再手动移除该锁，不能覆盖活动扫描的锁。退出时只关闭本脚本的数据库连接，不停止应用或 Docker 服务。

### 与清理的衔接

专项清单中的每一项均为 `executable: false`。归属复核复用日常 catalog，检查正式附件各角色、头像、任务／尝试、迁移 pin、预热及退役责任。注册过的 multipart 按精确 key＋upload ID 保留；静态资源和归属不明的命名空间不自动处理。保护关系按 key 保守生效，受保护 key 的全部历史版本均保留，不宣称已逐版本证明“可删除”。

| 分类 | 后续处理 |
| --- | --- |
| `daily_audit_reobserve` | 当前 Content 不可变对象待复核；仍由日常扫描重新观察，满足连续周期和身份／发布互斥后，才可走已有退役、软删除及 ESA 刷新通道 |
| `review_history_retention` | 历史版本保留政策复核；当前不永久删除，后续要单独核对恢复窗口、pin、精确版本及权限 |
| `review_abort_multipart` | 未登记的旧 multipart 待复核；后续终止前需重读 key＋upload ID、分片及任务归属，不能复用当前对象软删除通道 |
| `retain_*`／`review_unmanaged_namespace`／`upload_disappeared` | 保留、人工确认或滚动观察期间已消失；均不构成清理完成证据 |

本轮不会把一次专项观察写成日常扫描的两个完整周期，不启用 `orphanCleanup`，也不使用 `DeleteObjectVersion` 或 `AbortMultipartUpload`。预热、冷回源和 ESA 共享额度仍需单独验收。

当前权限准备见 [SID#1.4 准备权限](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#准备权限)。历史盘点曾采用临时附挂策略，当时并未撤销应用身份原有权限；2026-11-09 已确认解绑，见 [RAM 核对记录](../../config/ram/CLOUD-AUDIT-2026-11-09.md#云端核对结果)。JSON 没有自动到期，临时授权须在完成后解除。API 口径见 [ListObjectVersions](https://www.alibabacloud.com/help/en/oss/developer-reference/listobjectversions)、[ListParts](https://www.alibabacloud.com/help/en/oss/developer-reference/listparts)。

2026-11-02 [脱敏验证](../reviews/oss-inventory-2026-11-02.json)：生产完成全桶元数据与只读 DB 核对，共 643 个当前版本（579,895,354 字节）、178 个历史版本（441,456,793 字节）、186 个删除标记，multipart 为 0；按本轮 30 天门槛没有复核清理候选。开发仅完成纯元数据范围，321 个当前版本、136 个历史版本、136 个删除标记，multipart 为 0，归属未核实。两环境提交的 1,007／593 条记录与汇总一致、无重复身份；分页、断点、分片续跑和拒绝响应另有测试，真实桶本轮没有可调用 ListParts 的上传任务。

2026-11-02 当次读回中，两桶版本控制均为 Enabled，全桶生命周期为非当前版本 7 天过期及过期删除标记清理，尚未配置 multipart 自动终止条件，当次未修改这些规则。后续 2026-11-09 已读回两桶均配置了 7 天 multipart 自动终止，见[云端核对记录](../../config/ram/CLOUD-AUDIT-2026-11-09.md#云端核对结果)。OSS 生命周期独立于应用 pin 执行；配置读回不等于对象字节恢复或长期备份窗口验收。

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

状态 CLI、管理员接口权限和 findings 分页见 [SID#1.4 后台任务与日常存储检查](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#后台任务与日常存储检查)。返回边界：`admin.getBackgroundStatus` 不返回对象 key；`admin.getStorageAuditFindings` 不返回对象内容、签名 URL、AES 材料或原始 SDK 诊断。

## 异常处理

异常分类及处理入口见 [SID#1.4 后台任务与日常存储检查](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#后台任务与日常存储检查)。`orphan_candidate` 可包括 Content 和头像的无归属对象；下节自动清理仅接收符合现有不可变 key 规则的 Content 对象。

## 可选自动清理

2026-10-25 的 `20261025-e9f50d4e` 发布回执记录当时生产只有扫描。自动清理实现已随 [PR #23](https://github.com/tangenty42/stupig.tv/pull/23) 合并并包含在当前源码中，仓库默认 `app.storageAudit.orphanCleanup.enabled=false`；截至 2026-11-01 的最新生产镜像、实际开关和扫描状态须按[发布信息及回执](../deployment/aliyun.md#2026-11-01-webp-维护发布与原生持久化权限)核验。启用前先保留一至两周扫描观察期，再按环境显式启用该开关并重启应用或 worker。

仅 `orphan_candidate` 且 key 符合现有 Content 不可变对象生成规则的对象可进入清理：UUID 主对象、staging/transfers/originals 的任务与尝试 key、images 的 WebP/JPEG key。头像、静态资源、未知路径、目录标记和其他异常均继续人工处理。它们没有同样的退役/发布互斥协议，不能只凭无引用就自动删除。

连续观察次数绑定前一个完整周期；中间恢复引用、异常关闭、对象大小或最后修改时间变化均重新计数。同一周期的重试不增加次数，未完成的扫描不触发清理。清理前重新读取 OSS 元数据，再在事务内锁定完成周期、写入退役墓碑，并重新核对所有附件角色、活动任务、尝试、迁移 pin/复制及预热归属；任何保护命中都会回滚入队。未来发布使用已有对象采用锁拒绝采用退役 key。

入队后由原退役 runner 再核对引用和任务归属，完成源站软删除、404 确认和 ESA 精确刷新，保留原有租约、重试和回执。关闭开关会阻止新的入队及尚未进入删除阶段的此类任务；已经删除或进入刷新阶段的任务继续收尾，避免丢失缓存刷新责任。不永久删除历史版本。修复与清理结果由后续扫描关闭异常，入队本身不伪造『已解决』。

应用 RAM 策略需要指定桶的 `oss:ListObjects`（无 prefix 条件），以及已有受控对象前缀的读取/ACL 权限。2026-10-25 的记录中，两环境 OSS 策略已按授权更新为 v3 并读回一致，只增加全桶元数据列举，没有放开任意前缀的对象内容读取或删除；当前云端绑定需另行核验。参见 [RAM](../deployment/ram.md) 和 [OSS](../deployment/oss.md)。

## 首次验收

2026-10-25 已随 `20261025-e9f50d4e` 部署生产，默认 app runner 自动启动。开发桶完成 22 个引用、318 个对象的扫描；生产桶完成 405 个引用、313 个对象的扫描，均无未关闭异常。隔离 MySQL 验证了 7 类异常的检出、修复后的关闭、并发消费者互斥与租约换主后的迟到结果拒绝；临时移除围栏守卫时测试失败，恢复后通过。候选与生产公开入口各 8 项交付冒烟通过。历史版本和未登记 multipart 仍属于上文明确的范围边界。
