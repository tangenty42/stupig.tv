# OSS 全桶对账

`storage_audit` 是现有 runner 的全桶对账适配器，占用一个 OSS 槽。默认 `app` 模式随应用启动，不配置 cron，也不另起重复消费者。扫描只读取 OSS 元数据，写入扫描和异常账本，不终止 multipart、不改业务引用或 ACL。另有默认关闭的孤立对象清理选项，通过已有退役通道执行。

## 覆盖范围

| 方向 | 检查 |
| --- | --- |
| 数据库 → OSS | 正式附件的 object/original/AVIF/JPEG/删减版两角色、用户头像、配置登记的静态图标；检查存在性、已知的主对象大小，以及是否存在公有对象 ACL |
| OSS → 数据库 | 无前缀限制、分批列举桶内当前对象；判断正式引用、上传和图片尝试、任务输入、迁移复制/pin、预热和退役归属 |
| 已有异常 → 当前事实 | 单独复查每个旧异常，不因分页中没再看见它就批量关闭 |

这是滚动元数据检查，不是跨 MySQL/OSS 的一致性快照，也不下载全量字节做 SHA-256 校验。新插入到已扫描排序位置之前的对象可在下轮发现。历史对象版本、删除标记与未完成 multipart 不在本轮 ListObjectsV2 清单中：版本由 OSS 生命周期管理，已登记上传的 multipart 由上传生命周期账本处理；未登记 multipart 的全桶专项盘点尚未实现。

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

仅 `orphan_candidate` 且 key 符合现有 Content 不可变对象生成规则的对象可进入清理：UUID 主对象、staging/transfers/originals 的任务与尝试 key、images 的 AVIF/JPEG key。头像、静态资源、未知路径、目录标记和其他异常均继续人工处理。它们没有同样的退役/发布互斥协议，不能只凭无引用就自动删除。

连续观察次数绑定前一个完整周期；中间恢复引用、异常关闭、对象大小或最后修改时间变化均重新计数。同一周期的重试不增加次数，未完成的扫描不触发清理。清理前重新读取 OSS 元数据，再在事务内锁定完成周期、写入退役墓碑，并重新核对所有附件角色、活动任务、尝试、迁移 pin/复制及预热归属；任何保护命中都会回滚入队。未来发布使用已有对象采用锁拒绝采用退役 key。

入队后由原退役 runner 再核对引用和任务归属，完成源站软删除、404 确认和 ESA 精确刷新，保留原有租约、重试和回执。关闭开关会阻止新的入队及尚未进入删除阶段的此类任务；已经删除或进入刷新阶段的任务继续收尾，避免丢失缓存刷新责任。不永久删除历史版本。修复与清理结果由后续扫描关闭异常，入队本身不伪造『已解决』。

应用 RAM 策略需要指定桶的 `oss:ListObjects`（无 prefix 条件），以及已有受控对象前缀的读取/ACL 权限。2026-10-25 的记录中，两环境 OSS 策略已按授权更新为 v3 并读回一致，只增加全桶元数据列举，没有放开任意前缀的对象内容读取或删除；当前云端绑定需另行核验。参见 [RAM](../deployment/ram.md) 和 [OSS](../deployment/oss.md)。

## 首次验收

2026-10-25 已随 `20261025-e9f50d4e` 部署生产，默认 app runner 自动启动。开发桶完成 22 个引用、318 个对象的扫描；生产桶完成 405 个引用、313 个对象的扫描，均无未关闭异常。隔离 MySQL 验证了 7 类异常的检出、修复后的关闭、并发消费者互斥与租约换主后的迟到结果拒绝；临时移除围栏守卫时测试失败，恢复后通过。候选与生产公开入口各 8 项交付冒烟通过。历史版本和未登记 multipart 仍属于上文明确的范围边界。
