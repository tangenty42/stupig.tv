# 接手说明

给接手这个仓库的人（或 agent）的入口。目标是让一个没有上下文的接手者在**读完这一页 + 两份链接文档**后就能开工，不必重新考古。

> 基线：`main` 的提交以本文写作时为准（写作时 `d7c0119`）。开始工作前先 `git log --oneline -5` 对一下。
> 当前状态：content（蠢猪档案）模块的附件系统正处于一次分阶段重构中，阶段 0–2 已完成，阶段 3–5 有计划、未开工。

## 1. 一分钟上手

```sh
cp .env.example .env     # 首次：填密钥，本地端口保持原样
pnpm install
pnpm dev:all             # 起依赖容器（MySQL/Redis/EMQX/phpMyAdmin）+ dev server
```

验证改动（三项都必须过，CI 也是这三项）：

```sh
pnpm lint
npx nuxt typecheck
pnpm test                # vitest run
```

注意事项：

- 依赖是 **pnpm**，不要引入 `npm`/`yarn` 的 lockfile。
- 项目跑在 Docker 里（Dev Container），`pnpm` 可直接用。
- dev server 端口来自 `.env` 的 `APP_PORT`（示例值 3042）；它通常已在后台运行并带 HMR，**不要再起第二个**。
- `npx` 在 PowerShell 下若被执行策略挡住，用 `cmd /c "npx ..."`。

## 2. 读什么，按什么顺序

1. `.github/copilot-instructions.md`（全局规则）与 `.github/instructions/*.md`（按文件 glob 生效的分域规则）——**这是权威**，`AGENTS.md` 只是指针。
2. [`docs/content-task-refactor.md`](./content-task-refactor.md)——附件系统重构的完整方案：数据模型、锁模型、任务生命周期、各操作任务化细则、API、同步协议、前端结构、阶段计划，以及**每个阶段的详规**（§13.1 阶段 3、§13.2 阶段 4、§13.3 阶段 5）与修订记录。**开工前先读你要动的那个阶段的详规**。
3. [`docs/architecture-risks.md`](./architecture-risks.md)——全局风险清单与优先级路线图，含每条风险的"现状（已实施）"追记。
4. `README.md`——环境搭建、部署、迁移、清理任务的运维细节。

## 3. 工作流（仓库规则，务必遵守）

- **提交信息**：`type(scope): description`，单行、英文、祈使句、描述小写、无句号、无 trailer。`main` 的历史已按此格式重写，只有这一种风格可对照。
- **分支名**：`type/scope/description`（如 `feat/content/task-staging-cleanup`）。
- **PR 标题**：`type(scope): description`。`main` 受 Ruleset 保护：必须走 PR、必须签名、`check` 与 `migrations` 两个状态检查必须通过。合并用 `gh pr merge <n> --rebase --auto`（也允许 merge/squash）。
- **合并后分支自动删除**（仓库级开启），不要复用、也不要手动删。
- **提交必须签名**：本机已配 `gpg.format ssh` + `id_ed25519`，公钥已登记为 signing key。若换机器，需重新登记，否则 PR 合不进去。
- `git add` 用**显式路径**，不要 `git add -A`/`git add .`（历史上曾因此把一个有意删除的文件重新加回）。
- 不要附带 `Co-authored-by` 或任何 trailer，除非当次对话里用户明确要求。

## 4. 环境与配置

- 配置分层：`config/default.yaml` + 环境覆盖，Schema 校验在 `server/shared/config.ts`；`.env`/`.env.example` 只提供 `${VAR}` 插值。**改配置要三处同步**（yaml + `.env.example` + `config.ts`），并且**不要硬编码**。
- 服务端读配置统一走 `runtime_config()`（缓存单例）；构建期不读 `.env` 的路径是 `load_public_config()`（`nuxt.config.ts` 这类工具用）。
- 外部服务：同机 Docker 里的 MySQL；Aliyun（短信/DYPNS/CAPTCHA）；MQTT/EMQX 做实时同步。
- 实时同步：服务端用 `server/lib/sync.ts` 的 `publish_refresh({ resource })` 发布事件，浏览器端 `useSyncedData` 订阅并按需重新拉取。**不要**在客户端主动轮询服务端状态变化。
- 数据同步的 SSR 边界有历史坑（hydration mismatch），规则写在 `.github/copilot-instructions.md` 里，动 `useSyncedData`/`useDataSync` 前先读。

## 5. 数据库与迁移

- **`migrations/` 是结构的唯一事实源**（历史的手工 dump 已删除）。表名 snake_case，时间戳 `TIMESTAMP` 存 UTC，布尔字段是 `tinyint(1)`，返回客户端前 `Boolean()` 转换。
- **已应用的迁移是冻结的，一个字节都不能改** —— 运行器记录每个文件的 sha256，不一致就拒绝执行（容器启动失败）。连注释和空白也算：2026-10-09 就是这么把生产搞挂的。新增迁移要在同一个提交里把 hash 补进 `scripts/frozen-migrations.test.ts`；CI 在空库上重放，**发现不了**对已应用文件的改动。遇到 `已应用的迁移文件被改动或删除了` 时，先分辨是"行尾造成的假警报"还是"真的被改了"，两者修法相反 —— 判定规则与修复 SQL 见 [`.github/instructions/migrations.instructions.md`](../.github/instructions/migrations.instructions.md) 的 "Recovering from ..." 一节。
- 迁移执行器 `scripts/migrate.ts`：checksum 篡改检测、`GET_LOCK` 并发保护、`--status`/`--dry-run` 只读、`--baseline` 登记存量库；**对"有业务表但没有迁移记录"的存量库会自动 baseline**（登记而不重放）。
- 容器启动自动执行迁移，失败则容器起不来（有意如此）。CI 的 `migrations` job 会在全新 MySQL 8.4 上做空库全量重放 + 二次执行幂等验证 + 结构断言（`content_locks`/`content_tasks`/`content_task_items` 存在，`content_operation_locks` 已删）。
- 需要改结构时：**写新的增量迁移**，不要改已应用的迁移文件（checksum 会拒绝）。

## 6. content 模块当前架构（速查）

重构的核心：把附件操作从"请求内同步执行 + 一把 scope 锁"改成**服务端任务队列 + 路径粒度锁**。

| 组成 | 位置 | 要点 |
|---|---|---|
| 任务表 / 任务项表 / 锁表 | `migrations/20261008160000_content_tasks.sql`、`20261008140000_content_locks.sql` | `content_tasks`（一次用户操作）、`content_task_items`（`UNIQUE(task_id, path)`）、`content_locks`（`PRIMARY KEY(scope_id, path)`） |
| 任务状态机与存储 | `server/services/content/task.service.ts` | `content_task_transitions` 是合法迁移的唯一事实源；`transition_task` 用条件 UPDATE 防回退 |
| 调度与锁 | `server/services/content/task-runner.service.ts` | `dispatch_task`、`run_task_synchronously`（旧端点的同步包装）、tick 里的 sweeper 与过期任务清算 |
| 执行器 | `server/services/content/task-operations.service.ts` | `execute_task` 返回 `{ complete }`：纯 DB 任务 true（dispatch 内收尾），传输任务 false（准备后就保持 `running` 并**继续持锁**，等客户端灌字节） |
| 任务应用层 API | `server/services/content/task-api.service.ts` | preflight/create/cancel/resume/signParts/reportItem/resumeItem，以及结构类旧端点的同步包装 |
| 锁实现 | `server/lib/operation-lock.ts` | scope 锁（path `''`）与路径锁共享 per-scope 命名锁临界区；冲突判定是**双向前缀匹配**（`attachment_path_conflicts`） |
| 前端上传器 | `app/utils/content/task-uploader.ts`（+ `upload-transport.ts`） | 分批预签、批内并发、隐式续传、进度节流、可取消；注入式传输层便于单测 |
| 前端任务状态 | `app/stores/contentTasks.ts` | 服务端任务状态 + 本地 driver；`pending_rows` 是该 store 的行投影 |
| 行投影 | `app/utils/content/task-row.ts` | 任务项 → 附件卡片数据（`pending_upload_card`/`pending_upload_status`） |
| 实时进度 | `server/lib/sync.ts` 的 `publish_task_snapshot` + `useDataSync` 订阅 | `type: 'task_progress'` 事件**自带快照**，订阅方直接应用，不重拉；任务集增减才 `publish_refresh` |

关键配置（`config/default.yaml` 的 `app.content`）：`operationLock.ttlSeconds`、`task.heartbeatSeconds`（必须短于租约，`config.ts` 有交叉校验）、`task.queuedTimeoutSeconds`、`task.retentionHours`、`task.sweepIntervalSeconds`、`task.clientIdStorageName`、`upload.partSizeMb`/`signBatchSize`/`urlTtlSeconds`/`maxSizeMb`、`encrypt.maxSizeMb`。

## 7. 不许动的既有决策

这些是用户已拍板的语义，改动前必须重新确认：

- **正文保存不进锁体系**：`update_story` 与附件任务改写引用的竞态由 story 行 `FOR UPDATE` + `revision` 乐观锁覆盖，不要给它加锁。
- **`client_id` 只做"本机可续传"提示**，不是授权边界；任何持有源文件的客户端都能续传。
- **取消/失败任务的暂存语义**：`failed` 任务**保留** staging（续传要用），只有 `cancelTask` 与保留期清算才释放；清算必须先抢到行（条件 DELETE）再丢对象。
- **上传的命名冲突在 finalize（锁内）解析**，preflight 只判合法性并给 `suggested_name`。
- **加解密是整块 buffer 处理**（上限 20 MiB，故意如此），不要为了"大文件可中断"改成流式（会改 AES-GCM 密文格式）或客户端解密（扩大密钥暴露面）。
- **服务端分层**：tRPC router 只做鉴权+校验+委托；业务在 `server/services/`；`server/lib/` 是低层无状态基础设施且**不依赖 services**；`@shared` 里的规则模块是单一事实源。

## 8. 已知遗留与待办

- **阶段 3**（加解密/删减版/替换任务化）：计划见 §13.1，决策已定；其中「任务清理范围要包含自身新产生的 `content/att/<uuid>` 对象」是必做项。
- **阶段 4**（前端收敛）：`edit.vue` 仍有 2954 行，客户端规则与 preflight 重复；拆分映射与顺序见 §13.2。
- **阶段 5**（方言清单）：见 §13.3（含"方言其实已大部分单源"的现状核对）。
- 与重构无关但已记录的风险：`docs/architecture-risks.md` 的高优先级项（OSS 对账任务、删除失败重试、生产错误响应脱敏、MQTT 重连刷新与版本校验、故障注入测试）。
- 小项：结构类旧端点（move/rename/delete/folder/encrypt/decrypt/abridged）要到阶段 3 收尾才能删。

## 9. 陷阱清单（都是真踩过的）

- **PowerShell 把 `[id]` 当通配符**：`Select-String -Path 'app/pages/content/[id]/edit.vue'` 会**静默返回空**。用 `-LiteralPath`，或改用 ripgrep / `grep` 工具。
- **中文经 PowerShell 管道会乱码**：给原生命令（`gh`、`python`）传含中文的内容时，走 UTF-8 文件（`[System.IO.File]::WriteAllText(path, text, New-Object System.Text.UTF8Encoding($false))`），不要用管道；不要用 `Set-Content -Encoding UTF8`（会带 BOM，GitHub API 会 400）。用 PowerShell 做字符串替换改含中文的源码也很容易掉字符——优先用编辑器工具而不是 `-replace`。
- **`gh api` 改 Ruleset 必须用 PUT**（不是 PATCH），且 JSON 不能带 BOM。
- **新写的守卫必须能变红**：先故意破坏被守护的行为、确认测试失败、再恢复。不会失败的测试比没有测试更糟。`scripts/frozen-migrations.test.ts` 就是这条规则的产物（2026-10-09 生产事故后补的）。
- **不要为了让测试过而放宽断言**；expectation 与实现谁对，先判断再改。
- **子代理不可用**：本环境的 `explore`/`general-purpose` 子代理会以 `400 The requested model is not supported` 失败，探查工作要自己做。
- 测试环境是 Node、**没有 DOM**：需要真实浏览器行为（canvas、布局、指针事件）的东西不在单测范围内；`import.meta.client` 被强制为 `true`。
