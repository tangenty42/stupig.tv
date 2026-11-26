# AGENT-DESIGN：存储与后台任务的实现

- 本文档状态：PENDING（初稿，待人类审阅）
- 覆盖范围：附件对象的存放、删除流程、档案各后台任务对档案意味着什么
- 对应 LAW：[SID#2.4.7.LAW](LAW.md)；后台执行器、扫描登记和存储审计的查法见 [SID#2.5.AGENT-DESIGN](../../5_operations/AGENT-DESIGN.md)；控制台的展示见 `3_admin`；云端初配见 `SID#1.0`

## 入口

| 位置 | 内容 |
| --- | --- |
| `server/lib/aliyun-oss.ts` | OSS 读写；`soft_delete_object` 只加删除标记 |
| `server/lib/esa-purge.ts`、`server/lib/esa-preload.ts` | ESA 清缓存与预热 |
| `server/services/content/object-retirement.repository.ts` | `enqueue_object_retirement` 登记待删 |
| `server/services/content/object-retirement.service.ts` | 对象退役 `retirement` 扫描 |
| `server/services/content/upload-lifecycle.service.ts`、`image-attempt-cleanup.service.ts` | 上传收尾、失败的图片处理尝试清理 |
| `server/services/content/preload.service.ts`、`preload.repository.ts` | 边缘预热 `preload` 扫描 |
| `server/services/content/command-receipts.service.ts` | 回执压缩 `receipts` 扫描 |
| `server/services/storage-audit/` | 存储审计与孤儿清理 |

## 存放

- 每个环境一个私有 OSS 桶，开启版本控制和阻止公共访问；档案附件放在 `content/att/` 下，站点静态图片在 `imgs/`，头像在 `avatar/`；
- OSS 中的站点静态图片按完整对象键登记到 [shared.yaml](../../../../config/shared.yaml) 的 `app.storageAudit.staticKeys`。存储审计用这份配置识别已登记的静态图片。
- 浏览器只经 ESA 读取，见 [SID#2.4.6.AGENT-DESIGN](../6_access/AGENT-DESIGN.md)；上传是浏览器用签名 URL 直接向 OSS 分片 PUT；
- 对象不加密，机密只影响读取鉴权；
- 新写的对象键不可变，删过的键不再复用；
- 上传先写到 `content/att/staging/<会话>/<尝试>`。普通文件和不做处理的图片直接把这个对象采用为正式对象，所以 `staging/` 下的对象不一定能删，清理只按账本里的确切对象键，从不按前缀删（`upload-lifecycle.service.ts`、`upload-publication.service.ts`）；
- 两个桶的生命周期规则：非当前版本满 7 天清除、过期删除标记清除、未完成的分片上传满 7 天终止（`SID#1.0` 的 OSS 初配）。

## 删除流程

删除附件或档案、替换文件、覆盖图片、图片处理用完的上传原件、放弃的上传和处理尝试，都只在同一事务里调用 `enqueue_object_retirement` 登记一行 `content_object_retirements`，由 `retirement` 扫描处理。登记时记下原因（如 `delete`、`story-delete`、`replacement`、`image-input`、`image-overwrite`、`storage_audit_orphan`）以及当时的桶、endpoint、ESA 站点和读取地址。

对象退役会读取 `content_migration_pins` 保护迁移源对象。五张迁移明细表的用途和退出条件见[迁移明细归档与退役](../../../1_workflows/4_maintain/AGENT-DESIGN.md#迁移明细归档与退役)。

`retirement` 每 5 秒扫一次，逐行加锁认领：

| 阶段 | 动作 |
| --- | --- |
| `queued` → `deleting` | 认领时再检查，下表任一条成立就记下原因、30 秒后再试 |
| `deleting` → `purging` | OSS 上不存在就跳过，否则加删除标记，再 HEAD 确认 |
| `purging` → `completed` | 提交 ESA 单文件清缓存任务并轮询；失败或超过 600 秒重新提交 |

| 暂缓原因 | 条件 |
| --- | --- |
| `destination_changed` | 当前桶、endpoint、ESA 站点或读取地址与登记时不同。永不处理，须人工到旧桶处理，以免按同一路径误删新桶里的文件 |
| `object_referenced` | 还有附件行的任一对象键、或未结束的图片任务用着它 |
| `preload_in_progress` | 正在预热 |
| `migration_source_pinned` | 数据迁移钉住了它 |
| `audit_cleanup_disabled`、`audit_object_tracked` | 孤儿清理已关闭，或该对象已有记录认领 |
| `invalid_object_key` | 对象键不合法 |

- 没有回收站，也没有恢复功能；删除标记期间可在 OSS 控制台手动恢复；
- 上传或图片尝试晚到的写入，可把已完成的行重新排回 `queued`（`requeue_late_object`）。

## 各后台任务

| 扫描 | 周期 | 要点 |
| --- | --- | --- |
| 图片处理 `images` | 5 s | 见 [SID#2.4.5.AGENT-DESIGN](../5_images/AGENT-DESIGN.md) |
| 上传收尾 `uploads` | 5 s | 按上传会话和尝试账本处理取消、过期、失败或被替换的上传：按已知 UploadId 终止分片上传，已写的对象登记待删。只凭路径不删 |
| 对象退役 `retirement` | 5 s | 见上节 |
| 边缘预热 `preload` | 30 s | 图片处理完成后把显示版和备用版排进预热；不做处理的图片预热原文件，限 20 MiB。每日最多 500 次提交，另留 1000 次额度余量，日界按北京时间；每个对象最多提交 3 次。提交前先记下提交意图；回复丢失时按对象和原请求的时间窗口去查任务，不盲目再提交（`preload.service.ts`）。当前关闭（`contentPreload.enabled: false`），交付验收后再开 |
| 回执压缩 `receipts` | 60 s | 附件操作回执 24 小时内重复提交返回原结果（`receiptHours`）；过期后清空结果但保留身份，同一请求再交只得 409，不会重复执行，数据库时钟回拨也一样。每轮最多处理 `scanLimit`（100）条，按主键游标续扫（`command-receipts.service.ts`） |
| 存储审计 `storage_audit` | 30 s，一轮间隔 1 天 | 只读，发现写进 `storage_audit_findings`，种类见 SID#2.5。疑似无主指不归任何记录、且最近 7 天没改过的对象 |

- 孤儿清理默认关闭（`storageAudit.orphanCleanup.enabled: false`）。开启后，疑似无主的对象至少被查到 2 次、最后修改满 7 天，删前再查一次大小和修改时间都没变，才以 `storage_audit_orphan` 登记待删；
- 任何扫描停用或缺凭据时待办留在表里，恢复后接着处理；对象退役和边缘预热的停摆原因（`object_retirement_blocker`、`preload_blocker`）在控制台的后台任务卡片上标红。
