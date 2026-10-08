# Content 附件任务队列与前端瘦身重构方案

> 状态：**计划已定稿，未开工**（阶段 0 暂缓）。
> 关联文档：[architecture-risks.md](./architecture-risks.md)（本方案覆盖其 #1、#3、#4、#7 四项）。
> 决策记录见文末「附录 A：决策记录」。

## 0. 目标

1. **附件操作任务队列化**：每一次用户操作（拖入一批文件、一次拖拽移动、一次多选加密……）是一个服务端任务，有完整的生命周期、锁、进度与崩溃恢复。
2. **前端瘦身**：[edit.vue](../app/pages/content/[id]/edit.vue)（~2900 行 script）从"状态机集中营"退化为"组合 + 表单"；规则单一权威在服务端，前端只做预检展示与通用任务 UI。
3. **Markdown 方言统一**：渲染器、编辑器、服务端校验共享一份方言清单，新增语法只改一处定义。

非目标：正文保存/草稿冲突模型不变（revision 乐观锁）；`SyncRuntime` 抽象（risk #5）不在本次范围；UI 视觉不变。

## 1. 现状诊断（为什么乱）

### 1.1 前端

edit.vue 承担了五种交织的职责：

1. **双状态对账**：`pending_uploads` 视图模型与 Uppy 内部文件状态互相同步（`upload_from_file` / `sync_uppy_files`），叠加 GoldenRetriever ghost 恢复、IndexedDB FileSystemFileHandle 恢复、NoSuchUpload 自救三条恢复路径。**根因：服务端对"上传任务"一无所知，客户端只能自建状态机。**
2. **规则双份实现**：加密资格、删除阻止、命名冲突预测等为了在 UI 上"先知 disabled"在客户端重写了一遍（architecture-risks #7），存在漂移风险。
3. **选择/拖拽两台手写状态机**：锚点范围选择、marquee、祖先归一化；拖拽的源/目标/禁用/高亮散落在约 40 个函数中。
4. **草稿与保存冲突**：contentDraft store + 冲突对话框 + 远程版本 dirty-merge 采纳。
5. **约 15 个对话框/流程的字段状态**。

### 1.2 后端

- [content.service.ts](../server/services/content.service.ts) 约 1400 行、30+ 函数混合五种关切（risk #4）。
- 锁是单粒度 scope 租约（[operation-lock.ts](../server/lib/operation-lock.ts)）：竞争即 409（无队列）、TTL 定死（无续租）、无路径粒度。
- 加解密在**请求内**逐个做 OSS 下载/转换/上传——长请求持锁，大批量时逼近租约 TTL。
- 上传生命周期（staging key → confirm → copy → 落行）只有客户端记得，崩溃残留依赖对账脚本 [cleanup-orphan-attachments.ts](../scripts/cleanup-orphan-attachments.ts) 事后清理（risk #1/#3）。

## 2. 总体架构

```
前端（编辑页）
  ├─ 预检 preflightTask ─────────────┐（只读，无锁，返回逐项 verdict）
  ├─ 建任务 createTask ──────────────┤
  ├─ 传数据 ← signTaskParts / reportTaskItem →┤
  └─ 订阅进度 ← MQTT content_story_tasks:{scope}（内嵌快照）┐
                                                            ▼
后端                                            ┌──────────────────┐
  content.preflightTask / createTask / ...  →   │ task.service     │
                                                │ task-runner      │  Nitro plugin 进程内循环
                                                │  ├─ 调度（FIFO，锁集不冲突可并行）
                                                │  ├─ 锁管理（路径粒度，租约+续租）
                                                │  ├─ 逐项执行（DB 事务 / OSS 搬运）
                                                │  └─ 心跳、超时、sweeper
                                                └──────────────────┘
                                                        │ MySQL: content_tasks / content_task_items / content_locks
                                                        │ OSS: staging → content/att/<uuid>
                                                        │ MQTT: 任务事件 + publish_refresh
```

关键性质：

- **任务是真相**：进行中的操作持久化在数据库，任何标签页/设备可见（pending 卡片），崩溃可恢复，sweeper 可清算。
- **服务端编排传输**：后端分解任务为任务项、分配 staging key、预签分片、管理 multipart 状态；前端上传器只负责"按 URL PUT 字节并回报"。
- **规则单一权威**：preflight 与 runner 执行时跑同一份校验代码（@shared + service 层），客户端不再重写规则。

## 3. 数据模型（迁移 SQL 另行提供；`migrations/` 是结构的唯一事实源）

```sql
-- 任务：一次用户操作
CREATE TABLE content_tasks (
  id            bigint UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  scope_id      bigint UNSIGNED NOT NULL,              -- story_id
  kind          varchar(24)  NOT NULL,                 -- upload / replace / move / rename / delete / encrypt / decrypt / redact / folder_create / folder_delete / folder_rename
  status        varchar(16)  NOT NULL DEFAULT 'queued',-- queued / running / paused / cancelling / done / failed / cancelled
  payload       json         NOT NULL,                 -- 任务字段：moves[]、file_names[]、mode、insert_position……
  actor_id      bigint UNSIGNED,                       -- 操作者
  client_id     varchar(64),                           -- 发起方实例 ID（仅作"可续传"提示，见 §8）
  error         varchar(500),
  heartbeat_at  timestamp    NULL,
  created_at    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_scope_status (scope_id, status),
  KEY idx_status_heartbeat (status, heartbeat_at)
);

-- 任务项：任务分解后的最小执行单元
CREATE TABLE content_task_items (
  id           bigint UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id      bigint UNSIGNED NOT NULL,
  path         varchar(255) NOT NULL,                  -- 操作对象路径（上传=计划落点路径）
  action       varchar(16)  NOT NULL,                  -- upload / move / rename / encrypt / decrypt / delete / replace / redact / folder_*
  status       varchar(16)  NOT NULL DEFAULT 'pending',-- pending / active / done / skipped / failed
  bytes_done   bigint UNSIGNED NOT NULL DEFAULT 0,
  bytes_total  bigint UNSIGNED NOT NULL DEFAULT 0,
  staging_key  varchar(512),                           -- 上传暂存 object key（服务端分配）
  upload_id    varchar(128),                           -- multipart upload id（断点续传的锚）
  part_size    bigint UNSIGNED,                        -- 激活时由服务端按 bytes_total 决定
  result       json,                                   -- { new_path, reason, attachment... }
  UNIQUE KEY uq_task_path (task_id, path),
  KEY idx_task (task_id)
);

-- 路径粒度操作锁（替代 content_operation_locks）
CREATE TABLE content_locks (
  scope_id    bigint UNSIGNED NOT NULL,
  path        varchar(255) NOT NULL,                   -- 非空；文件夹路径锁整棵子树
  task_id     bigint UNSIGNED NOT NULL,
  token       char(36)     NOT NULL,
  expires_at  timestamp    NOT NULL,
  PRIMARY KEY (scope_id, path, task_id),
  KEY idx_scope_path (scope_id, path)
);
```

迁移处理：`content_operation_locks` 废弃（租约是瞬时数据，不迁移，直接 DROP；迁移窗口内确保无进行中的操作）。

新增配置项（`config/default.yaml` + `.env.example` + `server/shared/config.ts` 三处同步，遵循项目配置外化约定）：

```yaml
app:
  content:
    task:
      lockTtlSeconds: 120 # 锁租约（心跳滚动续期）
      heartbeatSeconds: 30 # runner 心跳/续期间隔
      queuedTimeoutSeconds: 300 # 排队超时 → failed
      retentionHours: 24 # 终态任务保留期（续传窗口）
      sweepIntervalSeconds: 60
    upload:
      partSizeMb: 8 # 服务端决定分片大小
      signBatchSize: 20 # 单次预签分片数上限
      # handleStorageName 沿用现有键
```

## 4. 锁模型（按决策 4 修订：正文保存不进锁体系）

### 4.1 路径锁语义

- 锁是 `(scope_id, path)` 上的排他行，由任务持有；**冲突 = 双向前缀匹配**：任务要锁 `a/b/c.png` 时，任何已持有 `a`、`a/b`、`a/b/c.png`、`a/b/c.png/x`（不可能但兜底）等互为前缀路径的锁都构成冲突。
- 由此天然得到决策所需的传递性：锁文件挡其所有祖先文件夹上的操作；锁文件夹挡整棵子树。
- **不需要意向锁行**：前缀匹配一次查询完成，锁行数 = 任务实际触及的路径数。
- 多路径任务按路径字典序一次性插入（单事务），避免死锁；冲突则任务保持 `queued` 等待，不报错。
- **续租**：runner 心跳与 `reportTaskItem` 都会滚动 `expires_at`；租约过期且任务未收尾 → sweeper 判 `failed`（"中断"）并释放锁，上传类任务项保留 `staging_key`/`upload_id` 供 `resumeTask` 重新排队。

### 4.2 与正文保存的关系（重要修订）

初版方案曾让 `update_story` 持 scope 排他锁。**决策 4 要求保存不被附件任务阻塞**——重新审视后这是可行的，而且更简单，因为现有机制已经覆盖了全部竞态：

| 竞态 | 现有/新机制 |
|---|---|
| 任务改写附件引用（`rewrite_story_attachment_refs`） vs 保存覆盖 markdown | 双方都 `SELECT ... FOR UPDATE` story 行：行锁使两个序列两两原子；任务改写 bump revision，后到者的保存以旧 `base_revision` 比对 → 409 → 编辑器走既有冲突流程。**这与今天的语义逐字一致。** |
| 保存的 `delete_files` 删除正被任务操作的附件 | 保存逐项检查 `content_locks`：被锁路径跳过（`skipped: '正在操作中'`），不阻塞整体保存。存在 TOCTOU 窗口（检查后任务才加锁），兜底是任务项失败（"附件不存在或已被删除"）——双方都是幂等失败，可接受。 |
| `delete_story` vs 进行中任务 | 任务表即真相：scope 上存在非终态任务时 409 拒绝删除，无需 scope 锁行。 |
| `create_story` | 无 scope，不涉及。 |

结论：**`content_locks` 只需路径粒度**，没有 scope 行、没有读写锁层级。保存路径的并发正确性继续由 story 行锁 + revision 承担。

## 5. 任务生命周期

### 5.1 状态机

```
任务:  queued ──runner 取锁成功──→ running ──全部任务项终态──→ done
         │                           │                             ↑（部分项失败/跳过时
         │排队超时                    ├─某任务项失败且不可恢复──→ failed   仍 done，逐项结果
         └──→ failed                  ├─cancelTask──→ cancelling ─→ cancelled  记录在 result）
                                      └─心跳中断（sweeper）──→ failed（中断）
        running ──用户暂停（仅含传输项的任务）──→ paused（释放锁）──resumeTask──→ queued

任务项: pending → active → done / skipped / failed
```

### 5.2 执行规则

- **逐项提交**（上传/替换/加解密/删减版）：每个任务项独立事务落库并即时 `publish_attachment_change`（bump `updated_at` + 刷新事件），天然产出结构化 `succeeded/skipped`（risk #7 终态）。
- **整任务单事务**（移动/重命名/文件夹操作）：链式移动（a→b, b→c）依赖两阶段改名（`.mvtmp-`）的整体性，保持今天的批量事务语义；任务项状态在提交后一次性翻转。
- **加解密移出请求**：runner 异步执行 OSS 下载/转换/上传，解除"长请求持锁"隐患（现状痛点 §1.2）。
- **sweeper**（Nitro plugin 内 `setInterval`，DB 租约 claim，单实例可用、多实例安全）：回收过期锁与中断任务、清理超保留期的终态任务（见 §5.4：先抢行再释放其暂存对象）。任务表本身就是对账单，与 cleanup 脚本互补（risk #1/#3）。

### 5.3 暂停/取消/恢复

- **暂停**：仅对含传输项的任务（upload/replace/redact）有意义。前端中断在途分片（AbortController），任务转 `paused` 并**释放路径锁**（不占着锁睡觉）；`resumeTask` 重新排队。
- **取消**：`cancelTask` → 服务端 abort multipart、删 staging、释放锁；已完成的任务项不回滚（部分成功语义，与今天一致）。**失败任务也能取消**（`failed → cancelled`）：`failed` 是唯一保留暂存的状态（续传要用），所以"我不要了"必须走这条路径才能顺手放掉暂存。
- **恢复**：任务项的 `(staging_key, upload_id)` 是续传锚。resume 后 runner 先 `ListParts` 核对；upload_id 已被 OSS 回收则重建 multipart（staging key 保留或重签）。

### 5.4 暂存对象的生命周期（阶段 2 补齐）

`content-upload/<scope>/<uuid>` 下的对象只在两处离开暂存区：**定稿**（finalize 把它 copy 到 `content/att/<uuid>` 后删源）与**放弃**。放弃只有三条路径：

| 路径 | 时机 | 动作 |
|---|---|---|
| `cancelTask` | 用户主动取消（含取消失败任务，即 UI 的"移除"） | `discard_task_staging`：逐项 `AbortMultipartUpload`（有 upload_id 时）+ 删对象，随后释放锁 |
| 保留期清算 | 终态任务超过 `retentionHours`（runner tick 的 `purge_expired_tasks`） | 先删行（条件 UPDATE 抢所有权，抢不到说明刚被 resume，保留原状），再 `discard_task_staging` |
| 定稿 | 任务项落地 | finalize 内 `copy_object` + `delete_object_best_effort(staging_key)`（已有） |

规则要点：
- **`failed` 不清暂存**——失败的传输任务正是要靠暂存续传；它的对象由保留期清算或用户取消负责释放。
- **先声明所有权再释放**：清算用一个按状态与保留期约束的 DELETE 抢行，抢到了才丢对象，避免与并发 `resumeTask` 抢同一批分片。
- **abort 是 best-effort**：客户端可能已经把 multipart 完成了（`NoSuchUpload`），失败只记日志，对象删除照常执行。

## 6. 各操作任务化细则

| kind | payload | 任务项分解 | 执行（runner / 客户端） | 锁路径 |
|---|---|---|---|---|
| `upload` | `[{ path, size, mime, insert_position? }]` | 每文件一项 | runner 分配 staging_key + 建 multipart（或单 PUT）→ 客户端预签分片、上传、回报 ETag 列表 → runner CompleteMultipart → head → copy 至 `content/att/<uuid>` → 落行 → 物化文件夹 | 各文件计划路径（最终名执行时锁定后重解析，见 §6.1） |
| `replace` | `{ old_file_name, mode: keep-name/new-name, size, mime, file_name? }` | 一项 | 同 upload 的传输段；落库时换对象不换 key 语义沿用现状（加密件拒绝替换的规则进 preflight）；new-name 时引用改写 | 源路径 + 目标路径 |
| `move` | `{ moves: [{ file_name, target_folder }] }` | 每文件一项 | 整任务单事务：两阶段改名 + 引用改写（沿用现逻辑） | 全部源路径 + 目标文件夹路径 |
| `rename` | `{ old_file_name, new_file_name }` | 一项 | 同上 | 源 + 目标 |
| `folder_create` | `{ folder }` | 一项 | 建行（含祖先物化） | 目标路径 |
| `folder_rename`（现 moveFolder） | `{ source_folder, new_folder }` | 一项 | 子树行改写 + 引用改写 | 源 + 目标（前缀锁覆盖子树） |
| `folder_delete` | `{ folder }` | 一项 | 删除空文件夹行 | 目标路径 |
| `delete` | `{ file_names: [], folders: [] }` | 每项一行 | 逐项：引用检查 → 删行 → 删对象（`delete_object_best_effort` 不再裸 catch，失败记 sweeper 重试单） | 全部路径 |
| `encrypt` / `decrypt` | `{ file_names: [] }` | 每文件一项 | runner：下载 → AES-256-GCM 转换 → 新对象 → 事务换行 + 引用改写 → 删旧对象 | 源路径 + 目标路径（`.good` 增减） |
| `redact` | `{ source_file_name }` + 一幅涂抹后的位图 | 一项 | 传输段同单 PUT 上传；落库走现 `create_abridged_attachment` 逻辑（sniff 校验等） | 源 + twin 路径 |

正文保存耦合的删除（`update_story` 的 `delete_files`）**保持现状不进任务**——它是文档编辑的一部分，受 revision 保护（§4.2）。

### 6.1 命名冲突的时序

preflight 给出计划名（含自动加后缀建议）；**执行时锁定计划路径后再跑一遍权威校验**，若期间名字被占则按 `resolve_attachment_name` 的 suffix 策略重解析，新名须同文件夹且未被他人锁定，否则该项 skipped。markdown 引用插入（`insert_position`）以**最终落点名**为准，在任务项 done 后由前端应用（见 §8.2）。

## 7. tRPC API（新端点；schema 集中于 `api_schema.content`）

```text
// 预检：只读无锁，返回逐项结论。前端"先知"disabled 的唯一权威。
content.preflightTask({ story_id, kind, payload })
  → { items: [{ path, ok, reason?, suggested_name? }], conflicts: string[], active_locks: [{ path, kind }] }

content.createTask({ story_id, kind, payload, client_id })
  → { task, items }                    // 幂等：同 scope+kind+payload 哈希的 queued 任务直接返回既有任务

content.cancelTask({ task_id })
content.resumeTask({ task_id })        // paused/failed(中断) → 重新排队
content.listScopeTasks({ story_id })   // 活跃 + 保留期内任务（断线补全/进入页面）

// 传输段（上传器专用，校验任务归属与 staging_key）
content.signTaskParts({ task_id, item_id, part_numbers[] })
  → { urls: [{ part_number, url }], part_size }
content.reportTaskItem({ task_id, item_id, status, bytes_done?, parts? })
  // parts: [{ part_number, etag }] —— CompleteMultipart 所需；同时滚动锁租约
```

- 权限：全部 `content_manage: full`（`signAttachmentDownload` 保持 public 不变）。
- 旧端点（`moveAttachment` / `renameAttachment` / `moveAttachments` / `deleteAttachment` / `encryptAttachments` / `decryptAttachments` / `createFolder` / `deleteFolder` / `moveFolder` / `createAbridgedAttachment`）在阶段 2 前保留为任务的**同步包装**（建任务→等待终态→返回现状形状）。阶段 2 已删除上传与替换的旧端点（`signAttachmentUpload` / `confirmAttachmentUpload` / `replaceAttachment`，决策 5）；其余包装随阶段 3 移除（同批操作仍在请求内同步执行）。
- `updateStory` / `createStory` / `deleteStory` / `getStory` / `listStories` / `getBilibiliVideoCards` 签名不变。

## 8. 同步与前端协议

### 8.1 进度下发

- MQTT 资源 `content_story_tasks:{scope}`：事件**内嵌任务快照**（任务 + 任务项状态/字节数），不走"通知再拉取"（进度 tick 太密）。订阅者限于编辑页（普通访客无感，详情页不变）。
- 断线/重连补全：`listScopeTasks`（risk #2 的必修课：内嵌事件丢了就停在旧进度）。
- `get_story` payload 扩展（仅对 `content_manage: full` viewer 附带）：`tasks`（活跃任务摘要）与 `locks`（路径+kind+是否本实例持有）；访客的 payload 不含这两块（顺带收敛 `operation_lock` 现状的全员可见）。
- **可见性分级（决策 2）**：任务卡片（pending 行、状态文案）所有编辑标签页可见；传输速度只由发起方本地计算（从自己的上传器读速率），不进事件。

### 8.2 前端落点

- **统一行投影**（单一函数，纯函数可测）：
  ```text
  // app/utils/content/scope-rows.ts
  projectScopeRows({ attachments, folders, tasks, locks, draftReferencedNames }): MyContentAttachmentRow[]
  ```
  存储附件、文件夹、任务 pending 项（上传中/移动中/加密中…）融合为一份行模型；[Attachment/List.vue](../app/components/MyContent/Attachment/List.vue) 与 [Attachment/Card.vue](../app/components/MyContent/Attachment/Card.vue) 的 **UI 与交互完全保留**，只换数据源。
- **禁用状态的来源**：右键菜单/拖拽目标/批量按钮的 disabled 由 `locks` + 任务状态 + 服务端规则派生（preflight 返回的 reason 直接展示）；客户端只保留一类本地规则——依赖未保存草稿的（如"已被正文引用"，草稿里的引用服务端看不到），集中于 `useAttachmentRules` composable，其余客户端规则代码删除。
- **模态框即任务表单**：重命名/替换/新建文件夹/删减版等对话框 UI 原样，职责改为"填任务 payload → preflight → createTask"。
- **引用插入**：上传项带 `insert_position` 的，在任务项 done（拿到最终名）后由发起方插入 markdown；其他标签页不插入（只有发起方有编辑器上下文）。

## 9. 断点续传与设备标识

- 续传锚 = 任务项的 `(staging_key, upload_id)` + 分片清单（`ListParts`）。**任何持有源文件的客户端都能续**。
- `client_id` = localStorage 安装实例 UUID（`app/composables/useClientInstanceId.ts`，配置项 `app.content.task.clientIdStorageName`；与 useDataSync 用 sessionStorage 的 `sync_client_id` 有意区分）。建任务时记录，仅作提示（决策 6）：本机 `client_id` 匹配且 IndexedDB（`upload-file-handle.ts` 沿用，键为 `<story_id>:<计划路径>`）里有 FileSystemFileHandle → 卡片显示"可续传"。
- 分片计划：任务项激活时服务端按 `bytes_total` 与 `upload.partSizeMb` 定 `part_size` 与分片数；客户端按批预签（`signBatchSize`），XHR PUT（要 upload progress 事件）+ 并发池 + AbortController，收 ETag 回报。
- **Uppy 移除（决策 3，✅ 已完成）**：`@uppy/core` / `@uppy/aws-s3` / `@uppy/golden-retriever` 依赖卸载；`upload_from_file` / `sync_uppy_files` / ghost 恢复 / NoSuchUpload 自救等对账代码删除。新上传器 `app/utils/content/task-uploader.ts`（注入式传输层 + 单测：分片规划、分批预签、并发上限、续传跳过、进度节流、取消；XHR 传输在 `upload-transport.ts`），任务状态与本地 driver 在 `app/stores/contentTasks.ts`，行投影在 `app/utils/content/task-row.ts`。

## 10. 服务端模块拆分（risk #4 落地）

```
server/services/content/
  story.service.ts        —— CRUD、front matter、标题/引用级联、revision（现 update_story/delete_story 等）
  scope.service.ts        —— 附件/文件夹行操作（现 content-attachments.service.ts 并入）
  task.service.ts         —— 任务 CRUD、preflight、payload 校验
  task-runner.service.ts  —— 调度、锁、逐项执行、心跳、sweeper 钩子
  upload.service.ts       —— staging、预签、multipart 生命周期
  encryption.service.ts   —— 加解密转换（runner 调用；lib/attachment-crypto 不动）
server/plugins/task-runner.ts —— 进程内 runner 循环 + sweeper
```

不变量：@shared 规则模块（[content-markdown.ts](../server/shared/content-markdown.ts) 等）保持单一事实源；`lib` 不被 `services` 之外的层调用；tRPC router 只做鉴权 + 校验 + 委托。

## 11. 前端结构（目标：edit.vue script ≤ 约 400 行）

| 模块 | 职责 | 形态 |
|---|---|---|
| `useContentEditorStore(storyId)` | 草稿、保存、冲突、base_revision、头部 meta 映射；吸收现 contentDraft store | Pinia（per-target defineStore，沿用 contentDraft 先例） |
| `useAttachmentTasksStore(storyId)` | 任务订阅/预检/发起/暂停/取消/续传、本地传输速率、pending 行数据 | Pinia |
| `useAttachmentSelection()` | 锚点/范围/marquee 选择状态机 | composable（ephemeral UI 态，不进 store） |
| `useAttachmentDrag()` | 拖拽源/目标/禁用/高亮 | composable |
| `scope-rows.ts` | `projectScopeRows` 纯函数 | util（单测重点） |
| `useAttachmentRules()` | 仅草稿依赖的本地规则 | composable |
| `task-uploader.ts` | 分片上传执行器 | util |
| edit.vue | 组合上述模块 + 对话框 | 页面 |

**Pinia 使用原则（回答"store 是否应该应用在更多地方"）**：是，但只用于**客户端工作区状态**（编辑器/任务/草稿）——跨组件共享、逻辑复杂、devtools 可观测。服务端同步数据（stories/story detail）继续走 `useSyncedData` + `useState`，其 SSR payload 序列化与共享代理语义与 Pinia 叠加无收益且有 hydration 风险。useDataSync 内部传输态不进 Pinia（属 risk #5 的 SyncRuntime 议题，正交）。

### 11.1 编辑器与渲染器收敛

- 新建 `app/utils/content/editor/index.ts` 导出 `create_story_editor(options)`：装配 CodeMirror 扩展（语言/lint/补全/主题/搜索/alert-marker），与渲染侧 `create_story_markdown` 对称。[Editor.vue](../app/components/MyContent/Markdown/Editor.vue) 只留 DOM、全屏 Teleport、分栏拖拽、slots。
- [Preview.vue](../app/components/MyContent/Markdown/Preview.vue) 的 script 抽出三个 composable：`useBilibiliVideoCards`（卡片缓存+SSR 预取）、`useDecryptedAttachments`（加密图 blob 替换/下载/删减版切换）、`useStoryBodyEnhancements`（carousel + sticky-headings + cropped-images 的 DOM wiring）。`.story-body` 的 scoped 样式**不拆**——它是渲染 HTML 的唯一样式来源，与 v-html 消费者同文件是正确内聚。

## 12. Markdown 方言清单

新建 `server/shared/content-dialect.ts` 作为方言唯一事实源，收编：

| 现状位置 | 收编内容 |
|---|---|
| [app/utils/content/alerts.ts](../app/utils/content/alerts.ts) | alert 类型/图标/标签/标记正则（移至 @shared） |
| [content-markdown.ts](../server/shared/content-markdown.ts) 评分段 | 评级 tier、`#置顶`、难评 |
| [content-private.ts](../server/shared/content-private.ts) | `<good>` 标签、占位符文案 |
| [app/utils/content/html.ts](../app/utils/content/html.ts) | HTML wrapper/原生标签清单（移至 @shared；编辑器 language 与渲染器 html-wrappers 共用） |
| 散落的卡片触发规则 | `@` 引用前缀、bilibili 链接模式、`.good` 后缀等（re-export 归口） |

消费方：渲染插件、编辑器高亮/补全、lint、服务端校验、测试 fixture。新增语法 = 改清单 + 一处渲染规则 + 一处补全声明。[render.test.ts](../app/utils/content/markdown/render.test.ts) 的图标守卫模式推广为"清单完备性"测试。

## 13. 阶段计划与验收

> 前置条件（**已完成**，2026-10-08）：迁移系统接管——`migrations/20261008000000_init_schema.sql` 基线登记（开发库 + 生产库）、check.yml 空库全量迁移验证进入 CI。此后三张新表与 DROP `content_operation_locks` 只是普通的增量迁移。
>
> 修订记录（2026-10-08，阶段 1）：① 同步派发模型——旧端点建任务后进程内 inline 执行（run_task_synchronously），执行器 ApiError 原样透传，锁冲突保持原 409 语义，无需轮询等待；② scope 锁与任务路径锁共享 per-scope 命名锁临界区，双向互斥，过渡期未任务化的操作（encrypt/decrypt/redact/replace）不会与任务并发；③ `get_operation_lock` 折叠路径锁（任一活跃锁即禁用结构操作），细粒度按路径禁用留给阶段 4 的 preflight 接线；④ 锁续租用 `operationLock.ttlSeconds` 单一配置，runner 心跳续租随阶段 2 的传输任务一起启用（纯 DB 任务毫秒级完成，无需续租）；⑤ 前端接线（任务事件订阅、pending 行）不在阶段 1 单独做，并入阶段 4 前端收敛。
>
> 修订记录（2026-10-08，阶段 2）：① 上传的命名冲突在**建任务时不再解析**——preflight 只判合法性与给出 `suggested_name`，权威的一次冲突解析发生在 finalize（锁内，见 §6.1）；② 客户端 `sign_batch_size` 由服务端随任务项下发，预签批处理无需试探上限；③ 续传靠 staging key + multipart `list_parts`，`client_id` 只用于「本机可续传」提示（决策 6）；④ 前端 `task-uploader` 取代 Uppy，`@uppy/*` 依赖与旧上传端点（signAttachmentUpload / confirmAttachmentUpload / replaceAttachment）一并删除；`confirm_attachment_upload` 的服务端实现同样删除，其逻辑由 `finalize_transfer_item` 独占；⑤ 粘贴改名不再需要「先入队后改名」的中间态：任务直接以最终名字创建。

| 阶段 | 内容 | 验收 |
|---|---|---|
| **0. 拆分预热**（✅ 已完成，2026-10-08） | `content_locks` 表 + 锁管理器内部替换 operation-lock（保持 409 语义）；按 §10 拆 service（不改行为） | 全部既有测试绿（546）+ typecheck + lint；锁语义单测（operation-lock.test.ts）；迁移在开发库真实执行 |
| **1. 任务内核**（✅ 已完成，2026-10-08） | 任务表、runner plugin、路径锁 + 续租、preflight；move/rename/folder/delete 四类纯 DB 操作切换为任务（旧端点转同步包装，tRPC 形状不变）；新增 preflightTask/createTask/cancelTask/listScopeTasks 端点 | 状态机、排队/冲突/超时/中断恢复、锁前缀冲突矩阵、preflight 逐项判定测试；既有 57 个 content 服务测试不改断言、全程走任务管线通过 |
| **2. 上传任务化**（✅ 已完成，2026-10-08） | signTaskParts/reportTaskItem/resume、上传任务化（服务端准备 + 客户端灌字节）、实时进度事件；前端 task-uploader 替换 Uppy、pending 行来自服务端任务；旧上传端点删除 | task-uploader（12 测试）+ 任务 store（27 测试）+ task-row 投影（9 测试）+ 服务端 task-api 测试；`@uppy/*` 依赖移除；lint/typecheck/668 测试全绿 |
| **3. 加解密/删减版/替换任务化** | 移出请求，runner 异步执行（重活只需 1 个任务项）；redact 模态框接任务流 | 大批量不再触碰 TTL；权限矩阵回归（content_private 密钥下发不变） |
| **4. 前端收敛** | scope 统一投影、preflight 接入全部入口（右键/拖拽/模态框）、edit.vue 抽离 §11 的 composable/store 并瘦身收尾、Pinia store 落定 | 客户端规则代码删除量核对；disabled 状态走查清单；行投影单测 |
| **5. 方言清单** | content-dialect 收编 + `create_story_editor` 工厂 + Preview composable 抽取 | 清单完备性测试；渲染快照对比不变 |

每阶段独立可上线、可回滚（阶段 1-3 旧端点包装层即回滚阀）。

## 14. 测试策略（在既有测试规范上追加）

- **锁管理器**：前缀冲突矩阵（文件-祖先-子树）、续租、过期抢占、多任务字典序获取无死锁。
- **任务状态机**：全迁移路径；runner 崩溃在各迁移边界的恢复（任务表重放）。
- **preflight/执行一致性**：同一校验代码两处调用，fixture 共享，防漂移（risk #7）。
- **task-uploader**：分片规划、ETag 收集、暂停/恢复/重试（纯逻辑部分）；传输层留 e2e 手工走查清单。
- **projectScopeRows**：存储行 + 文件夹 + 任务 pending 项的融合、排序、禁用派生。
- **回归**：content.service.test.ts 按 §10 拆分到对应 service 测试文件；渲染快照在阶段 5 前后 diff。
- 新守卫要求沿用项目规范：先破坏被守护的行为确认测试变红，再恢复。

## 15. 风险与缓解

| 风险 | 缓解 |
|---|---|
| runner 单点崩溃 | 锁租约 + 任务表重放，sweeper 接管；任何时刻死亡可恢复是设计底线与测试重点 |
| MQTT 任务事件丢失（risk #2） | `listScopeTasks` 断线补全是必须项；终态翻转同时走 `publish_refresh`（故事 payload 兜底） |
| 多管理员同时操作的排队体验 | 任务卡片展示排队原因（被谁锁）；排队超时可配 |
| 任务表膨胀 | 终态保留 24h（可配）后 sweeper 清理；索引按 (scope_id, status) |
| 范围蔓延 | 正文保存/草稿不进任务模型；SyncRuntime 不在本次；UI 视觉冻结 |
| 可观测性（risk #9） | 任务生命周期结构化日志（task_id/scope/kind/duration/结果），顺带补 risk #9 一角 |

## 附录 A：决策记录

| # | 议题 | 决策 |
|---|---|---|
| 1 | 任务存储 | **MySQL**（崩溃恢复、可查询、与项目栈一致；不上 Redis） |
| 2 | 进度可见性 | 任务卡片全编辑端可见；**传输速率仅发起方本地**计算展示 |
| 3 | Uppy | **移除**，自研 task-uploader 替代（删除双状态对账层） |
| 4 | 保存与任务的互斥 | **正文保存不进锁体系**（§4.2：行锁 + revision 已覆盖全部竞态） |
| 5 | 旧端点 | 阶段 2 前转同步包装，之后**一次性删除** |
| 6 | 设备标识 | `client_id` 仅作"可续传"提示，不强制同设备 |
| 7 | 文档与开工 | 先落本文档；**阶段 0 暂缓** |
