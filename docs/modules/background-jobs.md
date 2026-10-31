# 后台 runner 与领域任务

当前 runner 是 Content 后台工作的统一调度外壳：管理周期扫描、资源槽、进程状态及协作退出。任务事实、租约、重试预算、提交和检查点仍由各领域账本负责，尚未建立通用 `job / attempt / step` 数据模型。

## 当前负责的工作

| 适配器 | 工作 | 占用资源槽 |
| --- | --- | --- |
| `images` | 图片尝试、编码、归档、发布准备与尝试清理 | `image` + `oss` |
| `uploads` | 上传过期、取消、替代尝试和暂存生命周期 | `oss` |
| `retirement` | 正式对象删除确认与 ESA 刷新确认 | `oss` + `esa` |
| `preload` | 已发布图片的增量 ESA 预热及结果对账 | `esa` |
| `receipts` | 过期工作区命令回执的结果压缩，保留去重身份 | 无外部资源槽 |
| `sync` | Content outbox 的 MQTT 确认发送与重试 | `notification` |
| `storage_audit` | 全桶当前对象、正式引用和历史异常对账；可选将经确认的 Content 孤立对象交给退役通道，默认关闭 | `oss` |

七个 Nitro 插件只登记适配器，共用同一 app 作用域 runner 和 close hook。每个适配器自己的 enabled 开关、扫描批量、租约和错误恢复仍然有效。全桶对账的覆盖范围、默认节奏和查看方式见[操作手册](../operations/storage-audit.md)。

引用历史在追加事务中按作用域保留最近 200 个完整批次并推进 floor，不使用后台定时器或 runner 适配器；规则见[草稿与引用基线](content/drafts.md)。

## 运行模式

`app.backgroundRunner.mode` 支持三种值：

- `app`：随应用启动，开发默认通过 `pnpm dev` 一起运行。
- `worker`：应用不登记消费者，使用 `pnpm background:worker` 启动独立进程；该命令会拒绝其他模式。
- `disabled`：停止扫描，领域账本和待处理事实保留。

独立 worker 命令当前在源码工作区运行。生产精简镜像没有打包 worker/status CLI，也没有相应 Compose 服务；现行生产交付保持 app 模式。要分离生产 worker，需先补齐运行产物和编排，再显式选择 production 配置并验收，不能只切换 YAML 开关。

模式切换需协调全部应用实例和 worker；配置开关本身没有数据库级排他性，多实例执行仍由各领域租约仲裁。部署方式见[服务端部署](../deployment/server.md)。

## 调度和退出

资源槽限制的是每进程同时执行的有界扫描批次，不是 HTTP QPS、Sharp 原生线程数、图片内存或整个集群容量。一个适配器的扫描不会重叠，多资源同时分配，排队时不阻塞无关资源。图片内部并发仍由 `app.contentImages.concurrency` 决定，ESA 预算仍由预热领域控制。

云端异步任务通过下一次执行时间等待查询，扫描结束释放槽。退出时取消定时器和待执行扫描，发出 AbortSignal；领域在下一项认领前停止，已经开始的工作保留当前检查点和回执。超过退出期限会记录超时，独立 worker 失败退出；已经发送的远程请求可能继续，重启后依靠账本对账。

因此『进程退出』不等于『远端任务撤销』，也不能为了快速退出提前删除租约事实或认为一次请求失败就没有写入 OSS。

## 状态与排障

源码工作区的 `pnpm background:status` 只读汇总领域账本：各状态数量、到期候选、有效租约、最老待办及安全错误码。`admin.getBackgroundStatus` 需要 `admin_access:readonly`，另外返回当前应用进程的扫描统计；当前生产应用可通过该 API 查看状态，不能在精简镜像中直接运行 pnpm 命令。

CLI 是另一个进程，`process: null` 正常；应用快照也不是集群视图。独立 worker 要结合数据库租约及进程日志判断。状态中的 due 是候选数量，真正认领前还会重验权限、版本和对象引用；浏览器正在传输字节不等于后台有可执行任务。

尚未实现统一任意入队／重试 API、通用任务步骤 UI、跨进程资源容量控制。不要把后续设计当成当前运维能力。

## 账本保留与压缩

`app.contentReceipts` 默认启用，每 60 秒最多扫描 100 条命令回执，按 `(actor_id, request_id)` 主键分页并循环。扫描与点更新遵循 runner 模式、取消信号及失败重试；仅依赖数据库，不受 OSS 配置或上传／图片开关控制。

完整命令结果按现有 `receiptHours` 保留（当前 24 小时）；到期仅将 `result` 压缩为 `{}`，永久保留身份、fingerprint、作用域及时间。已压缩回执始终拒绝旧请求，即使时钟回拨也不重新执行。关闭扫描不延长回放窗口。2026-11-01 生产只读 EXPLAIN 中，首批使用 PRIMARY 顺序读取，后续同 actor／跨 actor 使用 PRIMARY range，无 filesort；该计划不作为大规模扫描性能承诺。压缩减少结果负载，行数仍随历史请求增长；永久删除身份须先建立服务端可验证的请求有效期协议。

| 账本 | 当前保留边界 |
| --- | --- |
| 引用历史 | 每作用域 200 个完整批次，追加事务内推进 floor |
| Content outbox | 确认送达且 lease 有效后删除；未确认记录继续重试 |
| 上传／传输会话、图片任务及尝试 | 保留发布幂等、对象归属与迟到写入清理事实；终态不等于可以删除 |
| 预热任务及预算 | 终态任务仍负责去重；历史预算的审计保留期限尚待决定 |
| 退役墓碑 | 保留禁止重新采用对象的身份，不按年龄删除 |
| OSS 对账 | 保留未解决异常、周期／观察次数和租约；已解决异常的保留期限尚待决定 |
| 迁移账本、对象 pin、共享草稿 | 执行／恢复证据或业务数据，不纳入通用 TTL 清理 |

状态 API／CLI 中 `receipts` 汇总 replayable、expired、compacted 数量；due 表示已过期且尚未压缩。2026-11-01 生产只读计数为 30 条命令回执（均过期，JSON 合计 7,781 字节）、37 条 completed 传输会话、96 行引用历史、outbox 0 条；该快照不构成持续容量承诺。

## 源码与验证

- 调度器：[`server/services/background/runner.ts`](../../server/services/background/runner.ts)。
- 领域装配：[`content/background.service.ts`](../../server/services/content/background.service.ts)。
- 状态：[`background/status.service.ts`](../../server/services/background/status.service.ts)。
- 独立进程：[`scripts/background/worker.ts`](../../scripts/background/worker.ts)。

同目录测试覆盖槽分配、公平排队、扫描不重叠、失败、取消、退出期限和迟到完成；领域测试验证停止认领与保存检查点。完整业务验证还应覆盖真实上传、图片处理、outbox、预热和回收，空队列扫描不能代替这些验证。
