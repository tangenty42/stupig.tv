# 对象生命周期、预热与回收

Content 使用不可变对象 key。数据库记录哪一版对象已经正式采用，OSS 保存字节，后台账本处理发布之外的工作。不能通过目录前缀或对象修改时间猜测是否可以删除。

## 从暂存到正式附件

浏览器上传输入位于 `content/att/staging/<session>/<attempt>`。普通文件以及 GIF／SVG 等原图直传类型可能直接把这个对象作为正式附件；因此 `staging` 不等于『一定可清理的临时文件』。

处理图片另建原图归档和 AVIF／JPEG；一组对象经过身份、权限和完整性验证后，由发布事务同时采用。发布前正式附件仍指向旧对象，失败尝试不改变旧内容。

替换、编辑覆盖、删除附件或删除删减版在同一业务事务中登记旧对象退役。正式引用、上传会话、图片尝试和迁移 pin 是回收判断依据，不能仅按一个附件行的当前 `object_key` 判断所有角色。

## 增量预热

当前预热针对新发布的正常／删减图片 AVIF 和 JPEG。它不是遍历全桶、每次启动全量预热，也不预热归档原图或任意普通附件。入队发生在图片发布事务中，按目的站点、交付域名和对象 key 去重；超过 `app.contentPreload.maxObjectBytes` 的对象不会入队。

`content_preload_sites` 管理目标和租约，`content_preload_jobs` 保存待办及云任务回执，`content_preload_budget` 记录本地提交预算。扫描前重新检查对象仍被该附件采用，且不处于退役中。

执行器先查询 ESA 配额，同时应用项目每日上限、预留额度和本地已提交计数。计算采取保守口径，云计数更新延迟或请求回执丢失时不假定额度未消耗。具体配置见[配置项](../../deployment/configuration.md)，官方额度与权限核对见 [ESA 部署](../../deployment/esa.md)。

云端提交前先保存本地意图。提交结果未知时，按精确对象与请求窗口对账，不立即再花一次额度。可确认失败才按次数预算重试；未知结果保留查询状态和错误码。

`enabled` 和 `deliveryVerified` 分别表达启用及交付链路验证门槛。仓库当前开发层两者为 true；共享层默认 false，生产层没有启用覆盖。配置值不证明生产控制台已经具备配额、权限或相同缓存键，生产启用前需要独立验收。

## 退役与缓存刷新

退役状态依次为 `queued → deleting → purging → completed`：

1. 认领时锁定 scope／对象并检查正式引用、在途预热和迁移 pin。
2. 确认对象当前源版本不可读取；需要时调用 OSS 软删除。
3. 对精确交付 URL 提交 ESA 刷新，保存任务回执并查询结果。
4. 确认刷新完成后记录 completed；错误和未知结果继续留在账本。

对象采用与退役通过数据库规则仲裁。完成退役的记录仍可作为禁止重新采用的墓碑，不能随意清空后再次使用同一个 key。目标桶、站点、域名等身份会被记录，配置变化不能让旧任务默默清理另一处对象。

OSS 开启版本控制时，软删除不等于历史版本已经永久回收；历史版本清理由桶生命周期策略负责。ESA 刷新完成也不等于能撤回用户已经下载的副本。读取撤权由[在线授权](access.md)独立保证。

## 取消、过期和迟到写入

上传生命周期扫描独立于图片处理开关，处理普通文件／图片会话过期、取消、被替代尝试和未知 multipart。图片尝试另有派生产物清理，精确跟踪原图归档及 AVIF／JPEG。

看到一次 404 不能证明远端再也不会写入。清理需要保留尝试身份和账本，以处理超时请求的迟到完成；不能先丢失记录，再用桶全量扫描猜测归属。

迁移源被 `content_migration_pins` 保护。迁移完成后的旧源退役是明确的独立操作，不由普通上传清理自动代办。旧 `storage:cleanup --delete` 不再执行写入；报告用途和源退役步骤见[Content 切换](../../operations/content-cutover.md)。

## 运维观察与恢复边界

通过 `pnpm background:status` 查看预热、退役及生命周期相关状态，结合错误码和目的身份排查。`pnpm content:preload:check` 用于预热相关核验，运行参数以[部署手册](../../deployment/esa.md)为准。不要把检查脚本误当作批量清理命令。

当前没有业务回收站或自助恢复 UI。对象历史版本只能提供恢复材料，完整恢复还需要附件元数据、引用和授权状态；见[备份恢复](../../operations/backup-recovery.md)。

## 源码与验证

- 采用：[`object-adoption.service.ts`](../../../server/services/content/object-adoption.service.ts)。
- 上传清理：[`upload-lifecycle.service.ts`](../../../server/services/content/upload-lifecycle.service.ts)。
- 图片清理：[`image-attempt-cleanup.service.ts`](../../../server/services/content/image-attempt-cleanup.service.ts)。
- 预热：[`preload.repository.ts`](../../../server/services/content/preload.repository.ts)、[`preload.service.ts`](../../../server/services/content/preload.service.ts)。
- 退役：[`object-retirement.service.ts`](../../../server/services/content/object-retirement.service.ts)。

自动测试覆盖引用保护、租约、迟到结果、配额不足、云回执丢失及恢复。云端验收分别核对新对象可读、预热实际生效、撤权、删除和刷新结果；数据库里的 completed 与浏览器当前可用性需要各自验证。
