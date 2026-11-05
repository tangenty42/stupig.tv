# 架构与文档一致性审查

审查日期：2026-10-28。基线：`348ae2a`，开始审查时工作区干净。本报告按用户要求独立保存，记录发现和待决策事项；不是替代现有模块手册的新规范。最初审查只新增报告和导航；后续用户选定 A01 的统一引用方案，工作区实现进展单独标注。未标注解决的发现仍指审查基线，不代表本轮全部修复；生产状态未核验。

## 结论与证据范围

**2026-10-31 状态核对：** 引用与共享云端草稿改造已随 [PR #48](https://github.com/tangenty42/stupig.tv/pull/48) 合并，A03 的重复扫描优化、A09 的发布身份及 A10 的 store 分工已有实现；迁移预检与维护发布入口已随 [PR #49](https://github.com/tangenty42/stupig.tv/pull/49) 合并。下文逐项的原始证据和早期“未实现”描述属于审查基线，后续落点见文末实施汇总和[草稿实施记录](../designs/shared-cloud-draft-implementation-2026-10-30.md)，不把全部 A03–A10 视为已关闭。本次仅核对代码与合并状态，生产另行验收。

**2026-11-01 收尾：** D04／D05 已分别随 #50／#54 合并。当前工作区已纠正 D07、D10–D12、D18–D20 的手册／注释，清理 A07、D08／D09 的公开旧附件类型和数据库全量配置依赖。A06 首先治理过期命令回执的结果负载，保留阻止旧请求重新执行的身份墓碑；其余领域保留策略见[后台账本](../modules/background-jobs.md)。代码交付以实际 PR 为准。#54 的生产运行镜像、30 项迁移完成及 cloud-v1 回执已只读核对；真实业务验收和恢复保障缺口由[云端台账](../deployment/aliyun.md)及[恢复手册](../operations/backup-recovery.md)维护。旧浏览器验证按用户要求暂停，既有结果不扩大为全站完成。

项目适合继续沿用 **Nuxt 模块化单体 + MySQL 事实源 + OSS 字节存储 + MQTT 失效通知**。可取之处主要在数据一致性和权限边界：上传与发布分离、Content 事务 outbox、不可变对象、退役墓碑、租约围栏、迁移冻结及服务端权限投影，已经覆盖许多常被忽略的失败场景。

长期问题集中在三处：**story 引用的反向索引不完整、前端草稿的身份及异步生命周期边界不足、运行时仍混有历史兼容逻辑**。其次才是规模扩大后的整 scope 扫描、全局标题锁、后台与在线服务争用，以及交付可复现性。没有证据支持现在拆成微服务或整体更换前端状态方案；先收紧现有合同更有收益。

本次交叉阅读了项目指令、架构及各模块手册、开发/部署/运维文档，并沿以下实现链路核对：tRPC/认证/会话、正文与引用、工作区事务、上传与图片发布、授权交付、后台调度和账本、草稿/同步/渲染、配置加载、迁移及 CI/CD。重点是合同和边界，未逐行证明所有源码，也未连接生产数据库或云控制台。

证据分三类：

- **行为已核验**：运行现有测试，或在内存中运行真实模块、替换数据库/认证等基础设施边界的探针。
- **静态确认**：可由当前源码、SQL、配置或调用关系直接确定。
- **风险推演**：从上述事实推导的并发、规模或生命周期风险；没有冒充真实生产故障。

优先级：P1 为应先处理的正确性或合同问题；P2 为维护与扩展成本；P3 为说明性偏差。云端历史记录只作为仓库中的记录审阅，不代表本轮重新验收了线上状态。

## 架构中值得保留的设计

| 设计 | 可取之处与适用边界 | 实现依据 |
| --- | --- | --- |
| 模块化单体和薄 API 入口 | 前后端同仓类型协作方便，事务不必跨服务；router 基本负责校验/认证/调用，业务在 service。静态显式 import 扫描未发现 lib 反向依赖 service，也未发现 app/server 文件间的显式 import 环；这不等同于证明 Nuxt 自动导入的全部依赖无环 | [router](../../server/trpc/router.ts)、[Content router](../../server/trpc/routers/content.ts)、[API facade](../../app/composables/useApi.ts) |
| 业务提交与 Content 通知同事务 | 业务已提交、进程在通知前崩溃的窗口有持久化补偿；重复消息只导致重新读取，不重复业务写入 | [outbox repository](../../server/services/content/sync-outbox.repository.ts)、[dispatcher](../../server/services/content/sync-outbox.service.ts) |
| 短事务与长上传分离 | 上传预约、分片、核验、图片处理、采用有各自事实；网络请求不长期占住工作区事务，取消和迟到完成有明确仲裁 | [上传会话](../../server/services/content/upload-session.service.ts)、[发布](../../server/services/content/upload-publication.service.ts) |
| 不可变对象及退役账本 | 逻辑改名不搬字节，发布新版本不覆盖旧 key；回收和采用协调，避免“刚清理又发布”及未知外部结果被盲目重试 | [对象采用](../../server/services/content/object-adoption.service.ts)、[退役](../../server/services/content/object-retirement.service.ts)、[对账清理](../../server/services/storage-audit/cleanup.ts) |
| 访问控制落在服务端和交付边界 | 正文先删减，附件按角色投影；缓存命中仍做在线授权，撤权不等待物理删除。代价是授权服务成为读取可用性的依赖 | [正文](../../server/services/content/story.service.ts)、[在线授权](../../server/services/content/edge-read.service.ts)、[边缘函数](../../config/esa/content-auth.mjs) |
| 多种版本承担不同责任 | 正文 revision、namespace/title revision、对象身份和 viewer_key 分开，避免把所有变化都当正文覆盖；引用重放检查完整客户端快照 | [引用历史](../../server/services/content/reference-history.service.ts)、[草稿桥接](../../app/utils/content/draft-reference-bridge.ts) |
| SSR 状态与浏览器副作用分开 | payload、hydration 提交时机、时区/时钟、身份变化有专门机制；复杂度虽高，但不是可随意删除的冗余 | [useSyncedData](../../app/composables/useSyncedData.ts)、[时间插件](../../app/plugins/timezone.ts) |
| 配置公开边界和迁移冻结 | settings 与部署秘密分开；数据库工具可只验证所需配置；迁移冻结完整依赖闭包，避免历史迁移随当前 helper 改变 | [loader](../../config/lib/loader.ts)、[公开配置守卫](../../server/plugins/public-config-guard.ts)、[冻结测试](../../scripts/migration/frozen.test.ts) |
| 按验证层级组织测试 | 纯逻辑、服务边界、真实组件、浏览器和迁移演练各有入口；文档明确云 SDK 夹具不证明真实云端行为 | [测试指南](../development/testing.md)、[Vitest](../../vitest.config.ts)、[CI](../../.github/workflows/check.yml) |

## 长期维护与扩展问题

### A01 · P1 · story 反向索引不完整，可能漏掉已保存正文的改名同步和删除保护

**后续状态：已按用户的新合同实现，尚未部署。** 以下问题与原建议保留为基线审查证据；现行规则见本项末尾及[草稿手册](../modules/content/drafts.md)。

**本项指向引用者发现的缺口，不是否定 namespace/title 历史重放机制。** 当前实现已经分别覆盖附件 namespace 和全局 story title 的历史；需要区分以下三条路径：

| 路径 | 当前机制 | 与本项的关系 |
| --- | --- | --- |
| 旧草稿追赶附件/标题变化，保存前校正引用 | [replay_locked_references](../../server/services/content/reference-history.service.ts#L142) 按两种 baseline 读取各自 journal，再调用共享 replay；保存正文也调用它 | 不依赖 `related_story_ids`，没有这里的 200 项截断；保留这一机制 |
| 附件改名/移动后同步已保存正文 | [finish_namespace_change](../../server/services/content/reference-history.service.ts#L63) 已知所属 story，直接改写该正文/封面并写入 journal | 无须跨 story 查找引用者，不属于本项指出的索引问题 |
| story 改名同步其他已保存正文，或删除前检查引用者 | [改名](../../server/services/content/story.service.ts)和[删除](../../server/services/content/story.service.ts)通过 `JSON_CONTAINS(related_story_ids, ...)` 找引用者 | 依赖索引完整性；本项的缺口在这里 |

**索引行为静态确认，完整失败场景待真实数据库复现。** [resolve_related_story_ids](../../server/services/content/story.service.ts) 将引用标题截断到前 200 项，只把当时存在的目标解析为 ID；[创建档案](../../server/services/content/story.service.ts)只计算新档案自身的索引，没有回填既有正文。

具体场景：A 先保存 `[](content://B)`，当时 B 不存在，索引为空；后来创建 B，渲染按当前标题可以解析到 B，但 A 的索引仍为空。若 A 没有重新保存，此后 B 改名为 C，标题 journal 会正常记录 `B → C`，但改名事务按反向索引找不到 A，因此漏改其已保存正文；若此时直接删除 B，引用保护同样可能漏掉 A。第 201 个不同引用有类似遗漏。这与[草稿合同](../modules/content/drafts.md#L23)允许悬空引用以后按同名目标解析的规则衔接不完整。

持有改名前 baseline 的旧草稿，在历史仍可用时可以通过 replay 把 `content://B` 改为 `content://C`；这不等于数据库中遗漏的 A 会自动修复。[get_story_body](../../server/services/content/story.service.ts)返回存储正文和当前 title revision，没有在读取时重放这篇正文。因此，改名后首次打开 A、没有旧本地草稿时，也不能依赖旧 journal 自动补救。保存前 replay 校正的是本次提交，不能替代对所有已保存引用者的发现和删除保护。

- 选项 A：保留按名称引用和现有 replay，补齐已保存正文的引用者发现；可在相关操作中扫描解析正文，或维护覆盖未解析名称、可回填的完整依赖索引，并明确超限策略。
- 选项 B：改为稳定 ID 引用，名称只用于展示；需重新决策悬空引用/同名替换的产品语义，并迁移正文、编辑器及引用历史，改动更大。
- **建议 A**：无需重做 namespace/title replay。先取消静默截断，或将上限变为服务端可见的校验错误；补“先引用后创建再改名/删除、旧草稿重放与首次打开已保存正文的区别、改名后补齐悬空目标、超过 200 项”的数据库场景，再决定扫描或索引方案。不要只改文档来弱化删除保护。

**后续用户决策与实现（2026-10-28）**：统一附件 namespace 与 story title 的处理路径，main 和客户端草稿都使用同一重放模块。删除目标后允许保留悬空引用，编辑器显示 warning；上述保留删除保护的建议被此产品决策取代。统一历史表逐行记录，以归一化后的 `att://…` / `content://…` 为匹配依据，不在每个 story JSON 列复制标题历史。

- 原存储（审查基线）：[迁移定义](../../migrations/20261014180000_content_reference_journals.sql)按 `(scope_id, revision)` 存储 JSON 变更批次；正数 scope 为附件所属 story，0 为全局标题。story 行保存附件 revision/floor，`content_title_namespace` 单行保存全局标题 revision/floor。原配置保留 30 天，没有 200 批上限。
- 新存储：[统一 repository](../../server/services/content/reference-journal.repository.ts)一行记录一个目标变化，包含作用域、批次 revision、批次内序号、原/新引用及其归一化键、目录标记和时间。创建/删除以 from/to 的 null 表达；两者均为 null 表示无名称映射的版本批次。同批次的名称交换同时解释，批次间按 revision 顺序重放。对象 ID 留作追踪信息，不作为名称引用的匹配依据。
- 作用域：附件归属具体 story，标题归属全局；匹配键是“作用域 + 归一化链接”，不能只用链接。`story 1 / att://a.png` 与 `story 2 / att://a.png` 相互独立，标题事件只在全局记录一次。统一的是模块、事件格式、重放/裁剪协议；客户端仍需携带所消费作用域各自的 baseline，不能直接把独立序列的版本号混为一个数。
- 归一化：[解析器](../../server/shared/content-reference.ts)先分离原始 query/fragment，再解码目标、做 NFC 和大小写归一化；目录尾斜线按既有语义统一。query/fragment 不参与匹配，重放保留参数和新目标实际大小写，未变化链接不顺手格式化。路径分隔、扩展名和 `.good` 等仍有业务意义。解析、引用目标查询、重放、渲染及 warning 已采用一致名称比较；数据库键使用 binary collation。
- 统一事务流程：生成变更批次 → 追加历史 → 对 main 执行同一重放函数并保存结果/基线 → 同事务写 outbox。草稿收到通知后以自身 baseline 拉取并重放，保存时服务端再次校正；保持正文并发版本与引用版本职责分离。
- 标题变更在事务中按确定顺序检查所有已保存正文并应用同一重放，只写回实际变化的正文；已移除 `related_story_ids` 的运行时依赖，收紧迁移删除该列。历史只存一份并不消除 main 立即更新所需的检查成本。附件事件只处理所属 story。
- 删除语义：保留原引用文本，目标不存在时显示 warning，并允许保存；附件工作区和 story 两处引用阻删检查均已移除。目标恢复同名时沿用当前按名称解析的行为，不自动清空正文链接。
- 保留上限已由用户确定为 **200 个完整批次／作用域**；附件按各 story、标题按全局分别计算，不限制正文引用数量。追加事务中整批裁剪并推进 floor，已移除 30 天 TTL 和独立清理插件。
- 历史裁剪：baseline 早于 floor 时保留“历史不足，人工核对后继续保存”的流程；等于 floor 可正常重放。缺失目标 warning 与历史不足是两种状态，裁剪不撤销已写入 main 的结果。
- 新建草稿已接入全局标题 baseline、重放和创建前校正；没有可用 baseline 时提示核对，不猜测起点。
- 三个新增维护迁移保持既有 scope/revision，把 JSON 批次转为事件行。旧 Content v1 的解析器依赖固定到基线快照，原冻结摘要验证通过。已完成隔离 MySQL 的空库全链、存量升级、中断恢复、大批次保留及裁剪回滚验证；没有对业务库或生产执行迁移。

### A02 · P1 · 草稿没有账号归属，保存回调也未统一做会话围栏

**2026-10-29 后续决策：改为评审共享云端草稿与服务端编辑租约，见[详细设计](../designs/shared-cloud-draft-2026-10-29.md)。** 用户已确定单份 main/draft、输入节流与现有轮询复用，以及 `M + 2T + 余量` 的租约上界；具体存储、权限和旧本地数据处理仍列为设计决策，尚未实现或关闭本项。下列 A/B 为原审查选项，保留原始问题依据。

**2026-10-30 实施安排：** [实现方案](../designs/shared-cloud-draft-implementation-2026-10-30.md)逐项对应 A01–A10、D01–D20，并区分云端草稿必需改动、容量验收和独立清理。工作区已将保存/引用状态收进 store，并补页面代次和身份检查；localStorage 仍没有账号归属，服务端草稿/租约尚未实现，不能因此关闭 A02 或将全部 D15 场景视为通过。原设计补充了锁后 token generation 核验和 MQTT 通知可见性选择；本次只形成方案，未执行迁移或部署。

**键和调用路径静态确认；跨账号及迟到保存的完整浏览器场景待复现。** [contentDraft](../../app/stores/contentDraft.ts#L40) 的 Pinia ID、localStorage key 和草稿记录均只有档案 ID/`new`，没有 actor ID；[编辑会话](../../app/composables/useStoryEditSession.ts#L235)的 Web Lock 也相同。[登出](../../app/composables/useAuth.ts)清除用户状态并重载，没有处理草稿归属。

因此同一浏览器配置中，后登录且有编辑权限的另一账号可能恢复前一账号的未提交内容；新建页的 `new` 草稿尤其没有服务端正文权限可用于区分。这不是仅靠服务端保存权限就能解决的本地数据隔离问题。

另一个独立边界是 `do_save()`、`do_create()` 和舍弃草稿的请求：引用 bridge 有快照/generation 保护，但这些保存流程没有统一检查 `page_disposed` 或操作开始时的账号/页面代次。同档案 store 又会按 ID 复用，离开后返回时，旧回调存在作用于复用状态的风险。现有“不同档案之间不串草稿”测试不能证明该场景。

- 选项 A：草稿明确作为同浏览器共享资产，展示归属提示并允许显式接管；仍补异步操作围栏。
- 选项 B：按账号和档案隔离持久化、锁及 store；旧无归属草稿经明确导入，所有写回核对账号、档案和操作代次。
- **建议 B**。不要直接删除旧草稿；补账号 A→B、新建页、同档案离开再返回、保存中撤权/登出的验收。

### A03 · P2 · 工作区读取是全量快照，存在二次复杂度

[get_attachment_workspace](../../server/services/content/attachment-workspace.service.ts#L18)先读全部节点，再读全部文件；为每个文件/节点反复 `find()`，并调用会重新过滤全量 rows 的 [node_version](../../server/services/content/workspace.repository.ts#L49)。平坦目录也会产生二次扫描；深目录还要多次遍历子树。响应同时包含 `nodes[].attachment` 和 `attachments`，文件数据重复序列化。[list_stories](../../server/services/content/story.service.ts)也全量返回，无分页。

- 选项 A：保留快照合同，先建立 ID/path 索引，单次构造树和版本，减少重复查询/序列化。
- 选项 B：目录分页和增量变更协议，客户端按 revision 合并；扩展性更好，但同步复杂度更高。
- **建议先 A**。用 100/1,000/10,000 节点、平坦/深层目录记录 API 时间、payload 大小和锁持有时间；实际规模超出预算后再做 B。本次未压测，不能把复杂度推导写成线上超时结论。

### A04 · P2 · scope 串行与全局标题锁构成明确扩展上限

[workspace_transaction](../../server/services/content/workspace.repository.ts#L104)锁整篇档案；[begin_namespace_change](../../server/services/content/reference-history.service.ts#L46)锁该档案全部附件。正文读取/保存取得全局标题命名空间共享锁；创建、改名、删除及历史清理取得排他锁，改名还在事务内改写引用者正文。

这使正确性容易推理，却让同一档案的无关路径操作排队，也让跨档案的标题维护可能阻塞正文读写。UI 显示“无关文件仍可操作”不等于数据库会并行提交。

- 选项 A：维持当前锁协议，给事务规模、批次和耗时设预算，先优化 A03。
- 选项 B：按路径/节点锁定，并设计跨目录操作的锁顺序和版本协议。
- **建议 A**。没有测量前不拆锁；如果做 B，须覆盖移动、删除子树、上传预约、标题改写和死锁重试，不能单独删掉 `FOR UPDATE`。

### A05 · P2 · 静态交付依赖在线应用，后台重任务又与其共享资源

[authorize_edge_read](../../server/services/content/edge-read.service.ts#L37)每次读取都开启数据库事务；授权与业务、后台扫描共用 [10 连接、无限等待队列的池](../../server/lib/db.ts#L12)。生产采用 app runner，图片处理也在应用进程内。每张图的首次同源入口加 ESA 回调会产生额外应用请求；缓存只能省字节回源，不能消除这些授权依赖。

- 选项 A：保留每请求撤权语义，补池等待/授权延迟/队列年龄监控和有界背压，完成生产 worker 打包后隔离重任务。
- 选项 B：允许短时间撤权延迟，缓存授权决定；这是产品和安全合同变更。
- **建议 A**。先明确授权延迟和可用性目标，再测容量；不能为性能直接改成“验签通过即永久放行”。worker 只隔离进程资源，也需要独立规划数据库连接预算。

### A06 · P2 · 后台生命周期与账本保留尚未统一

审查基线的 `server/plugins/reference-journals.ts` 绕过 runner 模式、资源槽和统一退出；close hook 只清定时器，不等待正在执行的清理。原清理实现一次处理全部过期 scope，并取得全局标题排他锁。**此引用清理部分已随 A01 解决：改为追加事务内按批次裁剪，独立插件已删除。** 以下其他账本的保留问题仍未处理。

此外，`content_command_receipts` 有 `expires_at` 和 24 小时重放窗口，但当前运行代码未发现删除过期回执的路径；上传/图片/预热等终态账本也需要明确保留策略。**退役墓碑、迁移回执和仍保护未知外部结果的记录不能按相同 TTL 清空。**

- 选项 A：把引用清理接入现有 runner，按有界批次推进；为可清理回执和不可删除安全事实分别定义保留策略。
- 选项 B：保留独立维护进程，明确部署、租约、退出、监控和数据归档职责。
- **建议 A**。这不要求建立通用 job/attempt/step 平台。先补模式切换、运行中退出和过期回执增长的观测，再设计清理迁移。

### A07 · P2 · 历史兼容、宽类型与全量配置加载扩大了变更面

以下为审查基线：草稿旧引用转换、同名封面回退及祖先原图追溯已有后续处理，分别见实施记录和 D04、D05；旧附件 DTO 与全量配置加载仍需单独处理。

公共 [Content 类型](../../server/shared/types/content.ts)仍有旧加密材料、旧上传合同及可选身份字段；在线代码仍能走祖先原图、同名封面和草稿旧引用转换（D03–D05、D08）。服务中多个行类型分别维护对象角色和历史字段。[db.ts](../../server/lib/db.ts)在导入时取完整 `runtime_config()`，普通诊断也可能被无关凭据阻塞；专用迁移 loader 已证明可以缩小配置范围。

- 选项 A：保留兼容，但给类型/函数标出适用版本、调用方、退出条件，并隔离到明确的兼容模块。
- 选项 B：先盘点存量数据，再迁移或确认不存在，随后去掉当前运行时的兼容入口和可选字段。
- **建议先 A、再有证据地做 B**。公共 DTO 应只描述可返回的当前状态；DB 历史行另建内部类型。不要修改已冻结迁移副本，也不要为统一类型让浏览器导入服务端配置。

### A08 · P2 · 两种通知保证使相似功能具有不同失效模式

Content 使用 outbox；账号/资料使用 [publish_refresh](../../server/lib/sync.ts) 和 [进程内 MQTT 队列](../../server/lib/mqtt.ts#L95)，队列达到上限会丢弃旧项，重启也不持久化。现有重连刷新和部分页面轮询有补偿，但不构成所有账号资源的事务通知保证。

- 选项 A：接受不同保证，明确账号资源的最终重读触发和最大陈旧时间。
- 选项 B：将有可靠通知需求的账号变更也纳入事务 outbox，复用传输和确认机制。
- **建议按业务选择 B**，先覆盖权限/会话状态和重要资料，勿为普通在线心跳逐条持久入队；保留派生在线状态的轮询。服务端授权仍有效，通知丢失不应被误报成“服务端撤权失效”。

### A09 · P2 · 部署产物缺少永久版本身份，应用与边缘函数分步切换

[Compose](../../docker-compose.yml)及 [Deploy](../../.github/workflows/deploy.yml)使用可变 `latest`/`mqtt`；成功后清理悬空镜像。[远端脚本](../../scripts/deploy/remote.sh)能恢复上一镜像与配置，但不回滚数据库，也不覆盖应用健康之后的 ESA 发布失败。历史手工发布有不可变 tag，不能推导成日常 CI 已有相同保证。

- 选项 A：保留现流程，追加不可变 commit tag/digest、交付清单、保留窗口及应用/函数协议兼容检查。
- 选项 B：蓝绿应用与函数版本协调切换；仍需处理前向迁移和客户端旧链接。
- **建议 A**。先使“某次版本可以重新取得并准确部署”可验证，再投入完整蓝绿方案。记录 runtime 配置与 schema 身份，不把 `/healthz` 当全链路验收。

### A10 · P2 · 自研同步和编辑编排的复杂度需要明确的内部合同

`useDataSync` 同时管理连接、跨标签协调、订阅、身份和事件；`useStoryEditSession` 组合草稿、锁、保存和引用同步；Markdown 由共享扫描器、markdown-it、CodeMirror、HTML lint/sanitize 多套机制协作。已存在有价值的模块拆分和测试，但仍有较大的集中模块；扩展语法或生命周期时需要同时理解多个实现，D03 和 D15 已显示边界容易遗漏。

- 选项 A：围绕现有行为继续拆分纯状态机、浏览器适配器和页面协调器，共享一套语法样例/合同测试。
- 选项 B：替换同步库或统一到一个 AST；迁移 SSR、权限投影、引用位置补丁和历史行为的成本很高。
- **建议 A**。优先抽离草稿归属/操作代次、标签锁和保存流程；保留统一 facade，避免每个组件直接订阅 MQTT。解析器不必强行合并，但新增语法要在解析、渲染、改写和诊断之间做同一组样例核验。

## 文档、注释与实现不一致的决策清单

以下 20 项均保持“当前说法—实际证据—选项—建议”分开。修改文档可以消除误导，不能代替对实现风险的处理。

### D01 · P2 · 生产拓扑仍称只部署应用容器

- **说法**：[架构第 59 行](../architecture.md#L59)称 MySQL、Redis、EMQX 都是外部服务。
- **实际**：[Compose](../../docker-compose.yml)已有 `app` 和 `emqx`，应用加入外部网络和项目 mqtt 网络，broker 只加入 mqtt 网络；[服务器手册](../deployment/server.md)已是新模型。
- **选项**：A 更新架构图及说明；B 恢复外部 broker 方案并调整部署。
- **建议 A**。按仓库声明描述“当前交付拓扑”，另标线上反代切换是否验收；本轮不能证明生产已运行这一 Compose。

### D02 · P2 · 架构仍将 Redis 描述为在用业务缓存

- **说法**：[架构图及依赖表](../architecture.md#L34)有 `App → Redis` 和“外部信息等缓存”；[redis.ts 注释](../../server/lib/redis.ts#L7)仍描述调用者缓存失败后回源。
- **实际**：Bilibili 元数据已移除。[Redis 手册](../deployment/mysql-redis.md)已说明无其他业务读写；当前搜索仅见连接模块、worker 导入/退出及配置/测试接线，没有业务命令调用。
- **选项**：A 标为保留基础设施，无当前业务消费者；B 完整退役依赖、schema、env 和 Compose/CI 接线。
- **建议先 A**，再作为独立环境变更评估 B。不要只删连接模块而让启动仍要求 Redis 配置。

### D03 · P1 · “旧引用只在离线迁移转换”与草稿行为冲突

- **说法**：[Markdown 手册](../modules/content/markdown.md#L44)称旧相对附件及 `@标题` 不再在线推断，历史转换属于离线迁移。
- **实际**：[store](../../app/stores/contentDraft.ts#L182)在 `initialize`、`restore`、`advance_base`、`mark_saved` 中都调用 `upgrade_legacy_refs`，不只升级 v2 草稿。真实函数探针把 `[text](relative.pdf)` 转成 `[text](att://relative.pdf)`；v2 草稿升级也有[通过的现有测试](../../app/stores/contentDraft.test.ts#L137)。用户输入的普通相对链接可能在后续载入/保存回读时改变语义。
- **选项**：A 文档承认并详细约定在线自动转换；B 只在明确旧 schema 草稿导入时转换，当前内容不猜测。
- **建议 B**，保留 v2 恢复能力；增加“当前正文相对链接、当前 schema 草稿、保存后回读均不被改写”的验证，再同步文档。

### D04 · P1 · 封面仍按去掉 `.good` 的同名公开附件回退

**2026-10-31 后续修复：** 用户确认退出旧同名配对逻辑。封面读取及事务变更检测只选择指定附件本身的公开／删减表示，没有表示时返回空封面。回归覆盖独立同名公开附件、改名、目标缺失及删除删减版；下列内容保留为修复前证据。生产发布另行核验。

- **说法**：[图片手册](../modules/content/images.md#L54)描述同 row 删减版，不再按同名文件配对；封面段也以本附件表示解释输出。
- **实际**：[cover_attachment](../../server/services/content-attachments.service.ts#L145)在未找到同 row 删减版时，仍尝试去掉 `.good` 查找另一公开文件。探针用机密行 ID 1 和公开同名行 ID 2，得到 `/api/content/attachments/2?...`。
- **选项**：A 明确封面是例外，继续允许跨附件回退；B 封面遵守稳定附件身份，只读取本 row 允许的表示，否则占位。
- **建议 B**。这不证明机密字节泄漏，但会展示不同身份的内容，也让删除删减版后的封面语义难以预测。补删除删减版、创建同名公开文件、重命名三组测试。

### D05 · P2 · “原图只来自本行独立归档”遗漏在线祖先兼容

**2026-11-01 后续修复：** 生产库只读统计发现 136 个附件、121 个已处理图片，`archive_source_id` 和 `archive_source_key` 均为零。运行时已移除跨附件原图追溯及祖先 key 校验；仅使用本行原图，缺失时返回不可用。旧元数据不会参与原图选择，编辑来源版本校验和冻结迁移保持不变。下列内容保留为审查基线，代码交付状态以实际 PR 和发布回执为准。

- **说法**：[图片模型](../modules/content/images.md)及[读取操作](../modules/content/access.md)把原图解释为本行归档、独立副本不依赖源附件。
- **实际**：[resolve_attachment_role](../../server/services/content/attachment-access.service.ts#L71)仍可按 `archive_source_id` 追溯同 scope 祖先，校验 `archive_source_key`；[现有测试](../../server/services/content/attachment-access.service.test.ts#L68)明确保留该行为且通过。新副本独立归档的描述成立，但并非唯一可读模型。
- **选项**：A 文档增加“仅历史行”的兼容例外及删除/权限依赖；B 盘点并补齐独立归档后移除追溯。
- **建议先 A，后 B**。没有数据盘点前不删除该分支，也不把它说成当前新副本创建方式。

### D06 · P1 · CAPTCHA 的 503 到 tRPC 边界变成了 500

- **说法**：[短信/CAPTCHA](../deployment/sms-captcha.md#L23)承诺上游不可用返回 503；后端规则也要求保留传输状态。
- **实际**：[captcha.ts](../../server/lib/captcha.ts#L54)抛 `ApiError(503)`，但 [tRPC 转换](../../server/trpc/init.ts#L34)未覆盖 503，落到 `INTERNAL_SERVER_ERROR`。真实 router/错误格式化探针得到 `httpStatus: 500`。失败关闭仍有效，偏差在错误分类。
- **选项**：A 补 503→`SERVICE_UNAVAILABLE` 映射；B 文档明确 tRPC 统一返回 500。
- **建议 A**。同时核对其他实际使用的 `ApiError` 状态，补传输层断言；只测试 service 抛出 503 不够。

### D07 · P2 · 预热范围不止 AVIF/JPEG

- **说法**：[对象生命周期](../modules/content/object-lifecycle.md#L15)称当前预热针对正常/删减 AVIF 与 JPEG。
- **实际**：[发布流程](../../server/services/content/upload-publication.service.ts#L60)也为 `!image && mime.startsWith('image/')` 的原样图片入队，覆盖 GIF/SVG 等；[入队器](../../server/services/content/preload.repository.ts)按大小筛选，[执行器](../../server/services/content/preload.service.ts)也承认当前 `object_key`。[现有 GIF 发布预热测试](../../server/services/content/upload-publication.service.test.ts#L114)已在本轮通过。
- **选项**：A 文档改为“可交付图片表示，含原样图片”；B 收紧入队到 AVIF/JPEG，并处理已有任务。
- **建议 A**，保留大小、开关、配额限制及已有原样图片入队验证；若产品希望限制成本，再选择 B。

### D08 · P2 · 共享类型仍承诺 AES 密文、密钥和独立私有桶

- **说法**：[ContentStoryAttachment](../../server/shared/types/content.ts#L52)注释仍称 `.good` 对象是 AES-GCM 密文、授权用户会得到 base64 key，`is_private` 为“Release A”的独立桶模型。
- **实际**：当前上传用 private OSS 明文字节和在线 ACL；[格式化](../../server/services/content-attachments.service.ts#L72)不返回 key，[读取守卫](../../server/services/content/attachment-access.service.ts#L34)拒绝未迁移加密行。`.good` 与加密已经不是同一概念。
- **选项**：A 将旧字段标为仅历史兼容，订正注释；B 盘点调用方后从当前 DTO 去掉旧字段，历史类型单列。
- **建议先 A、再 B**，全链路核对后再收窄类型。冻结迁移里的旧加密说明仍是历史事实，不应随之改写。

### D09 · P2 · URL 和 version 注释混淆 ETag、读取身份与静态域名

- **说法**：[共享类型](../../server/shared/types/content.ts#L48)称把 ETag 直接放进 `?version=`，并要求给 `url` 加 static base。
- **实际**：[attachment_access_version](../../server/services/content-attachments.service.ts#L56)是对象/权限/提供方等身份的 SHA-256；返回的 `version` 字段仍是 row ETag，URL 则是同源 API 入口。[useStaticUrl](../../app/composables/useStaticUrl.ts)特意保留 Content API 路径。若按注释实现新消费方，可能签错版本或请求错域名。
- **选项**：A 订正并列出 ETag、访问版本、node version、read revision 的责任；B 同时重命名公共字段，消除歧义。
- **建议先 A**，再在有类型/API 迁移计划时评估 B，不因注释错误修改现有正确 URL。

### D10 · P3 · 当前引用函数注释仍以旧语法举例

- **说法**：[story.service](../../server/services/content/story.service.ts)、[共享解析器](../../server/shared/content-markdown.ts#L1215)及[编辑页](../../app/pages/content/[id]/edit.vue)仍使用 `@ref`、`[](@title)`、裸 `file.jpg` 说明当前补全/解析/改写。
- **实际**：当前业务引用使用 `content://` / `att://`；旧语法的显式转换在另一个函数中，D03 已揭示它的实际调用范围。
- **选项**：A 当前函数注释换用当前语法，迁移函数说明保留旧语法；B 在线重新支持两种业务语法。
- **建议 A**。不要全仓替换 `@title`，冻结迁移、旧输入测试和历史说明必须保留各自语义。

### D11 · P3 · 正文增量读取注释仍称回传 base_viewer_key

- **说法**：[story_viewer_key 前的注释](../../server/services/content/story.service.ts)称客户端回传 `base_viewer_key` 以判定正文是否变化。
- **实际**：当前 [get_story_body](../../server/services/content/story.service.ts)比较 `base_representation_version`；哈希包含当前权限投影及 viewer_key。其他资源仍可能使用 viewer key，不能因此把它们一并改掉。
- **选项**：A 订正当前正文协议说明；B 恢复独立 base_viewer_key 入参。
- **建议 A**，说明表示哈希和 namespace/title token 分属不同新鲜度合同。

### D12 · P3 · 附件删除 helper 的调用顺序注释相反

- **说法**：[delete_story_attachment_rows](../../server/services/content-attachments.service.ts#L129)称调用时 story row 已被删除。
- **实际**：[delete_story](../../server/services/content/story.service.ts)先删附件行，再删 story row，并在同一事务中处理退役意图和通知。
- **选项**：A 改注释为真实前置条件；B 为迎合旧注释改变删除顺序。
- **建议 A**，注明事务和先收集对象身份的责任；无需改迁移或删除顺序。

### D13 · P2 · 草稿冲突并非在加载时就提示

- **说法**：[草稿文档](../modules/content/drafts.md#L11)称加载时比较草稿与服务端，决定恢复、提示冲突或舍弃。
- **实际**：[onMounted](../../app/composables/useStoryEditSession.ts#L208)直接恢复可用草稿，保留旧 base revision；主要冲突提示在保存返回 409 后由 `show_save_conflict()` 触发。服务端并发保护仍在，偏差是用户发现冲突的时机。
- **选项**：A 文档改为“先恢复，保存时检查冲突”；B 加载时就明确提示基线过旧，同时保留保存时检查。
- **建议 B**，提示不应自动舍弃内容；如果暂不调整交互，先采用 A 消除误导。

### D14 · P2 · 草稿失焦并不总是立即释放编辑锁

- **说法**：[草稿文档](../modules/content/drafts.md#L9)称失焦/离开时立即保存并释放。
- **实际**：[finish_tab_release](../../app/composables/useStoryEditSession.ts#L246)在保存或引用同步中会等待；持久化失败且未关闭时也保留锁。无 Web Locks 时当前逻辑保持只读，不能仅理解为失去多标签优化。
- **选项**：A 描述“先只读、保存/同步完成且持久化成功后交接”，明确不支持 Web Locks 的结果；B 强制立即释放并另建冲突协议。
- **建议 A**。现有等待具有数据保护意义；补慢网、存储满、缺失 Web Locks 的验收说明。

### D15 · P1 · 文档对全部异步结果和页面级 store 隔离的保证过强

- **说法**：[草稿文档](../modules/content/drafts.md#L11)泛称切换身份/销毁页面使旧异步结果失效；[store 注释](../../app/stores/contentDraft.ts#L34)将状态描述为创建它的页面实例拥有。
- **实际**：引用 bridge 的快照围栏确实存在；但 [do_save](../../app/composables/useStoryEditSession.ts#L520)等流程没有同等统一检查。store 实际按档案 ID 复用，不能保证同一档案的新旧页面实例完全独立，且无账号键。详见 A02。
- **选项**：A 把说明缩到已实现的 bridge 和不同 target 隔离；B 补全所有写回路径的操作代次/身份校验和账号归属，再保留较强承诺。
- **建议 B**，期间先使用准确的 A 说明。验证同档案离开/返回、迟到保存、账号切换，不以不同档案测试替代。

### D16 · P3 · 后台适配器数量未同步

- **说法**：[草稿文档](../modules/content/drafts.md#L43)仍称“五类” runner 适配器；部分部署枚举也未列全桶对账。
- **审查基线实际**：[装配器](../../server/services/content/background.service.ts)当时为 images、uploads、retirement、preload、sync、storage_audit 六类，后续新增 receipts 压缩，现行清单见[后台手册](../modules/background-jobs.md)。审查基线的引用清理在外部；后续 A01 已移除独立清理并更新草稿/后台手册，其他部署枚举仍需核对。
- **选项**：A 更新数字及各重复清单；B 删除各处易漂移的数字，链接到拥有清单的后台文档。
- **建议 B**；后台文档保留完整表即可。不要将引用清理误算为第七个已接入的适配器。

### D17 · P2 · “全部命令”清单和 test 参数说明已经过期

- **说法**：[命令清单](../development/commands.md#L5)以 31 个入口、旧 scripts 盘点为依据，表中 `test` 仍写可追加文件/筛选参数。
- **实际**：[package.json](../../package.json#L34)已有 36 个入口，新增 `test:unit/tools/component/e2e/all`；`test` 是三个命令的串联，尾随参数不能视为对三组统一筛选。旧盘点可作为 2026-10-25 历史事实，但不能再充当当前全部入口和删减数量依据。
- **选项**：A 更新为当前调用关系，并使用 `test:unit` / `test:tools` / `test:component` 或直接 Vitest 指定范围；B 设计真正的统一参数转发 CLI。
- **建议 A**，不为清单增加总调度器。保留仍未实施建议的标记，重新计算建议后的数量，补 testing/ci 等新增脚本职责。

### D18 · P2 · OSS 策略说明既允许全桶列举又称不允许

- **说法**：[RAM 参考表](../deployment/ram-reference.md)列出 `ListObjects`，紧接的第 17 行又称“不允许任意列举桶对象”。
- **实际**：[生产策略](../../config/ram/stupig-oss-app-prod-access.json#L7)和开发对应策略授予指定桶的 `oss:ListObjects`，没有 prefix 条件。对象内容读取仍限制到受控前缀；不能把元数据列举和内容读取混为一谈。
- **选项**：A 改为“允许指定桶全量元数据列举，不允许任意前缀内容读取/跨桶操作”；B 加 prefix 条件并缩小对账范围。
- **建议 A**，符合全桶对账设计。本轮只核对策略文件，未重新验证云端 RAM 绑定。

### D19 · P2 · 历史发布快照被写成持续有效的当前状态

- **说法**：[故障排查](../operations/troubleshooting.md#L32)仍称生产未迁移，与[切换记录](../operations/content-cutover.md)的 2026-10-25 已完成矛盾；[导航](../README.md#L75)/[对账文档](../operations/storage-audit.md#L67)使用“本次待合并”“本 PR”；切换/云台账仍说工作区尚未提交。
- **实际**：当前 Git 历史已有相关 Content 迁移与对账实现提交，当前基线包含自动清理实现。但代码已提交、已合并、已部署、开关已启用是四件不同的事，本轮未读线上，无法直接把“未部署”替换成“已部署”。
- **选项**：A 将这些表述改为带日期/版本的历史回执，“当前线上状态”只由单一台账的最近验收负责；B 删除历史记录，只留当前说明。
- **建议 A**。保留镜像/备份摘要等恢复证据，修正明确的文档内部矛盾，线上部分标“本轮未复核”；不凭 Git 推断部署状态。

### D20 · P2 · 排障中的 Compose 命令漏选环境文件

- **说法**：[故障排查](../operations/troubleshooting.md#L12)用 `docker compose -f docker-compose.dev.yml ps`。
- **实际**：[开发 Compose](../../docker-compose.dev.yml)的插值依赖 `.env.dev` 提供的变量，仓库已不使用旧 `.env`；项目其它正确命令显式传 `--env-file .env.dev`。是否偶然成功取决于调用终端已有变量。
- **选项**：A 补 `docker compose --env-file .env.dev -f docker-compose.dev.yml ps`；B 要求每个终端预先注入全部变量。
- **建议 A**，同时检查复制到运维清单中的同类命令。不要为兼容旧命令重新引入跨环境 `.env` 兜底。

## 建议决策顺序与验收

| 顺序 | 决策集合 | 完成条件 |
| --- | --- | --- |
| 1 | A01/A02、D03/D04/D06/D15 | 明确引用和草稿合同；复现索引遗漏/跨账号/迟到写回；修正错误映射、隐式引用转换和封面身份偏差，相关回归能检出旧行为 |
| 2 | D01/D02/D05/D07–D14/D16–D20 | 确认保留哪些兼容例外，订正文档/注释/命令；每项可回到当前实现，不误改冻结迁移、作者内容或未核验的线上状态 |
| 3 | A03/A04/A05 | 建立规模与延迟基线，减少重复扫描，决定生产 worker 隔离与连接预算；保持事务和撤权保证 |
| 4 | A06/A07/A08/A09/A10 | 明确账本保留、兼容退出、通知保证和不可变发布身份；按行为边界渐进拆分，避免一次性大重构 |

“补文档”与“改实现”必须分别关闭：例如 D06 仅把手册改成 500 可以消除字面冲突，但不能实现预期的可重试服务不可用分类；D15 仅收窄说明也不能解决 A02 的草稿归属问题。

## 初始审查验证记录

- 现有定向测试：6 个文件、148 个用例通过。范围为 `contentDraft.test.ts`、`attachment-access.service.test.ts`、`upload-publication.service.test.ts`、`content.service.test.ts`、`content-reference.test.ts`、`router.test.ts`，使用 app/server Vitest 项目。
- A01 复核另运行 `content-reference-replay.test.ts`、`reference-history.service.test.ts`、`draft-reference-bridge.test.ts`，3 个文件、38 个用例通过，覆盖附件/标题重放及客户端应用等行为。服务测试对 `JSON_CONTAINS(related_story_ids, ...)` 返回空夹具，不能据此证明“先引用后创建”的数据库索引完整性。
- 三个内存探针运行真实模块，基础设施边界使用空夹具：`ApiError(503)` 经 tRPC 得到 500；机密封面回退到另一公开附件 ID；旧相对链接转换为 `att://`。未连接数据库、OSS、MQTT 或云控制台。
- README、scripts README 与 docs 的本地 Markdown 文件链接检查：未发现目标文件缺失；不包含外链可达性及所有标题锚点校验。
- 静态核对：显式 import 关系、公共 DTO/调用者、迁移定义、package scripts、Compose、配置和策略文件；运行时与冻结迁移副本分开判断。
- 全仓 `pnpm lint` 通过，`git diff --check` 通过；检查使用本机已有 pnpm 12.10.1，经 Corepack 调用，未安装依赖。本次没有运行 Nuxt build/prepare、全量端到端、压力测试或生产验收；148 个测试通过不能代替 A01/A02 待补场景。

## A01 实现后验证记录

- 完整 `pnpm test` 通过：app/server 128 个文件、1669 项；tools 35 个文件、317 项，另有 1 项跳过；组件 4 个文件、27 项。新增回归覆盖统一重放、超过 200 个正文引用、新建草稿追赶、删除后悬空、参数保留、大小写与 Unicode 归一化，以及各作用域整批裁剪。
- `pnpm lint`、`pnpm exec nuxt typecheck`、`pnpm exec tsc --noEmit -p scripts/tsconfig.json`、`pnpm settings:check` 均通过。旧迁移冻结摘要保持不变，新迁移摘要已固定。
- 在本地 MySQL 随机隔离库中运行完整迁移：空库迁移及重复执行、旧 JSON 批次转换、中断后恢复均通过。验证 200 个批次上限、单批 250 行完整保留、floor 边界及追加／裁剪事务回滚；测试库在结束时清理。没有对业务库或生产执行迁移。
- README、scripts README 与 docs 共 40 个 Markdown 文件的本地链接目标及源码行号范围检查通过；不含外链可达性及所有标题锚点校验。
- 未执行全量浏览器端到端、压力测试或生产验收；A02 及其余未标注解决的审查项仍待决策。标题改名会在事务中扫描全部已保存正文，性能边界仍需按 A04 测量。

## A01 浏览器验收补充（2026-10-28）

- 用户批准后，在独立应用与随机 MySQL 测试库中分两轮运行 7 个相关 Playwright 场景，全部通过。覆盖先引用后创建、超过 200 个正文引用、标题／附件目录改名与跨上下文草稿追赶、新建草稿、删除影响提示与悬空 warning、同名重建、历史不可用后的确认保存。
- 附件和全局标题作用域各验证 200 个完整批次、250 行批次保留及 floor 边界。测试使用历史仓库在隔离库准备批次，再通过实际 API／编辑器触发变更和裁剪；未在浏览器逐次执行 200 次操作。
- 测试启动器运行完整迁移及测试专用构建，使用真实本地 MySQL、Redis、MQTT；OSS／短信等外部边界替换为测试实现。未对业务数据库或生产执行迁移，未执行全项目浏览器套件、压力测试或真实云端验收。

## 共享云端草稿实施复核（2026-10-30）

本节更新工作区处理状态，不覆盖上述历史证据，也不证明生产已部署。合同、逐阶段落点与验证明细见[实现记录](../designs/shared-cloud-draft-implementation-2026-10-30.md#8-实施记录与发布边界)。

| 项目 | 当前处理与剩余边界 |
| --- | --- |
| A01／A02、D03／D13–D15 | 独立云端 draft、MySQL 租约、原命令回执、页面与身份代次、内存恢复区及 CodeMirror 只读过滤已实现；普通本地草稿／Web Locks 协议退出。管理员明确自行处理旧 localStorage，应用不导入或删除；不声称所有浏览器旧残留已清除 |
| A03 | 工作区一次构造 folder 成员及附件 Map；版本与前后快照对比用 Map／Set 避免逐行重复扫描，版本 hash 字节保持不变。一万文件快照约 10MB，平坦／深度 8 本机三次最大约 221／266ms；分页／增量树另案 |
| A04／A05 | 维持标题→story→draft 锁顺序；纯保活不拉工作区，持久化引用不生成编辑器补丁。两个写者、四后台 SQL 占位、真实图片任务／读取授权、250 行附件变更和 100 份草稿标题改名的混合测量在 T 内；outbox 最终清空，连接池饱和后的过期写被拒绝。全局锁、10 连接无限等待及 app worker 仍是扩展上限，扩大规模须补预算／背压，未以缓存授权替代撤权 |
| A08 | 草稿的当前用户／session／实际 token generation 在内容锁后及最终写入前同连接复核；取得授权行锁后单独读取数据库时间，覆盖排队期间自然过期，避免使用等待前的语句起始时间。通知走事务 outbox 和独立授权 WS。既有通知连接最多 30 秒票期，API 不等待消息撤权。账号域全面 outbox 化仍独立 |
| A09 | 新发布维护 SHA tag，实际运行固定应用／broker RepoDigest；回执记录 commit、schema、settings 摘要与 cloud-v1。首次跨协议失败停写并保留数据，不自动启动旧无租约写者；生产外部反代与恢复材料尚需发布窗口验收 |
| A10 | 一个 Pinia store 拥有编辑状态和串行命令；composable 保留页面／API／query／编辑器接线，不把 MQTT 或 DOM 搬进 store |
| D01／D02／D16／D17 | 架构修正托管 broker、Redis 无当前业务消费者及事务内引用裁剪；草稿现行手册、配置、测试入口与部署说明同步。历史线上状态单独保留，不凭 Git 推断 |
| D06／D08／D09 | 503 映射 SERVICE_UNAVAILABLE；新增明确 draft DTO，区分 main／draft revision、引用 baseline 和 epoch。旧附件 DTO 清理仍另案 |

本轮本地隔离验收完成：单元／工具测试共 2025 项、组件 30 项、生产编译后的浏览器分轮 20 个不同场景通过；隔离 MySQL 19 项合同、真实临时 MQTT 权限与交付、混合负载及连接池饱和验收通过。现有依赖镜像环境的集成测试 1 项跳过。类型、lint、settings 与冻结摘要检查通过；随机测试库和临时 broker 已清理。随后经用户授权迁移本地开发库并核对回填；具体覆盖及测量限制见实现记录，未迁移生产业务库或部署生产。

审计 D04 已于 2026-10-31 单独修复；D05 后续处理见本项说明。A06 其余账本保留及未在本轮复核的云端配置不随草稿实现关闭；A07、D18 后续处理见本文 2026-11-01 状态。生产切换必须使用同版本维护包、停旧写者、核对回填与回执，并完成草稿专用 WSS 反代／匿名拒绝验收。
