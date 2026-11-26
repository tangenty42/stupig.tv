# AGENT-DESIGN：领域文档的组织方式

- 本文档状态：PENDING（六个一级目录和档案八个子目录均已写完，各目录的审阅与验收进度见 SID#2.AGENT）
- 覆盖范围：`docs/2_domains/` 的目录划分、三类文档各写什么、与总体及流程文档的分工、数据表归属
- 旧文档：`docs-legacy/` 已于 2026-11-19 删除；本文提到的旧手册、旧台账以及“留在原文”的内容，原文都在 git tag `docs-legacy-final`
- 上位依据：[SID#README](../README.md)、[SID#0.1.LAW](../0_overall/1_architecture/LAW.md)
- 进度与调研记录：[SID#2.AGENT](AGENT.md)

## 目录

一级目录与 `SID#0.1.LAW` 板块表的六个板块一一对应，顺序相同。蠢猪档案按业务对象拆成八个子目录。

```text
docs/2_domains/
├── 0_framework/      公共框架
├── 1_accounts/       账号与权限
├── 2_pages/          平凡页面
├── 3_admin/          管理控制台
├── 4_content/        蠢猪档案
│   ├── 0_stories/     档案的元数据、列表、详情页、事件日历
│   ├── 1_drafts/      云端草稿、编辑权、发布、舍弃、删除档案
│   ├── 2_markdown/    正文语法、机密标记、编辑器、预览
│   ├── 3_references/  正文对附件和档案的引用、改名后的自动改写、删除影响
│   ├── 4_attachments/ 附件目录、上传与替换、整理、命名与冲突、机密标记
│   ├── 5_images/      图片处理、原图、删减版、图片编辑器
│   ├── 6_access/      附件的打开与下载、链接与授权
│   └── 7_storage/     存储、延迟删除、预热、存储审计、档案的后台任务
└── 5_operations/     运行与维护设施
```

每个目录放三份文档：人类写的 `LAW.md`，Agent 写的 `AGENT-DESIGN.md` 和 `AGENT.md`。领域目录不设 `DESIGN.md`。

`5_operations` 只有 AGENT-DESIGN 和 AGENT（`7_storage` 原先也打算不设 LAW；2026-11-15 人类要求重组后改为有 LAW，因为是否保留旧版本、有没有回收站要人类定）。`5_operations` 承诺的都是对其他板块和运维的行为，按人类 2026-11-15 的答复不设 LAW。

## 各目录写什么

| 目录 | 范围 | 主要源码 |
| --- | --- | --- |
| `0_framework` | 顶栏与面包屑、明暗主题、首屏遮罩、提示与确认浮层、时间显示、页面自动更新的可见效果、出错时看到什么 | `app/app.vue`、`app/composables/`、`app/utils/`、`app/plugins/` |
| `1_accounts` | 注册登录、登录状态、验证码、个人主页与资料、登录记录、权限的含义与生效、账号状态 | `server/services/{auth,auth-guards,session,profile}.service.ts`、`server/shared/permissions.ts`、`app/features/account/` |
| `2_pages` | 首页、联系方式页 | `app/pages/index.vue`、`app/pages/contact.vue` |
| `3_admin` | 控制台的用户列表与筛选、封禁、强制下线、认证、管理员身份、权限编辑、批量操作，以及运行状态里的后台任务和存储审计 | `app/pages/admin/`、`app/features/admin/`、`server/services/admin.service.ts` |
| `4_content` | 档案板块的角色、机密总则、子目录共用的数据和约定 | `server/trpc/routers/content.ts`、`server/shared/content-*.ts` |
| `5_operations` | 通知的资源清单与送达、后台扫描清单与状态、存储审计、健康检查、sitemap、请求标识、对外的错误输出、外部回调入口；设备身份 cookie 归 `1_accounts` | `server/lib/{sync,sync-channel,mqtt}.ts`、`server/services/background/`、`server/api/hooks/`、`server/errors/` |

### 源码与领域对照

改某项业务的代码前，先按下表找到它所属的目录，读该目录已有的 LAW、AGENT-DESIGN 和 AGENT；蠢猪档案的子目录还要读 `4_content` 的三份总则。上表的“主要源码”列管一级目录，本表补蠢猪档案的子目录。子目录写完一个补一行，没写的按 [4_content 的文件名前缀归属](4_content/AGENT-DESIGN.md#入口) 先找到目录。有些行为由配置或云端设置决定，代码里看不出来，见“配置与云端”列。

| 目录 | 源码 | 配置与云端 |
| --- | --- | --- |
| `4_content/0_stories` | `server/services/content/story.service.ts`、`server/shared/content-markdown.ts` 的 Front Matter 部分、`app/features/content/{stories,event,story-cover}.ts`、`app/pages/content/index.vue`、`app/pages/content/[id]/index.vue`、`app/components/MyContent/Story/` | — |
| `4_content/1_drafts` | `server/services/content/draft*.ts`、`server/shared/content-draft.ts`、`server/shared/types/content-draft.ts`、`app/features/content/{draft.store,draft-list,editing}.ts`、`app/pages/content/[id]/edit.vue`、`app/pages/content/drafts.vue`、`app/components/MyContent/Story/DraftList.vue` | — |
| `4_content/2_markdown` | `server/shared/content-{markdown,markdown-syntax,private,placeholder}.ts`、`app/features/content/markdown/**`、`app/components/MyContent/Markdown/*.vue` | — |
| `4_content/3_references` | `server/shared/content-{reference,reference-replay,reference-definitions,reference-definitions-live,reference-error,delete-impact}.ts`、`server/services/content/{reference-history.service,reference-journal.repository,delete-impact.service}.ts`、`app/components/MyContent/DeleteImpact.vue` | `app.content.reference` |
| `4_content/4_attachments` | `app/components/MyContent/Attachment/`、`app/features/content/{attachments,uploads}/`、`server/services/content/upload-admission.service.ts`、`server/shared/content-workspace.ts` | `app.content.{workspace,upload}` |
| `4_content/5_images` | `server/lib/oss-image-processing.ts`（生产唯一的图片处理，在阿里云上转换）、`server/services/content/{image-job.service,image-scheduler.service,image-attempt-cleanup.service,upload-image.service,image-presentation,image-original-object,redacted-variant}.ts`、`server/shared/content-image-format.ts`、`app/features/content/image-editor/`、`app/components/MyContent/Attachment/ImageEditor.vue`。`server/lib/webp-image-processing.ts` 只供离线性能脚本，生产不走 | `app.content.{image,redact,imageEditor}`；`contentImages`（`config/shared.yaml`） |
| `4_content/6_access` | `server/services/content/{attachment-access.service,edge-read.service,upload.service}.ts`、`server/lib/{esa,esa-access,content-disposition}.ts`、`server/api/hooks/esa/authorize.post.ts`、边缘函数 `config/esa/content-auth.mjs` | 签名有效期：`app.content.{read,download}.urlTtlSeconds`，上限 `aliyun.esa.urlTtlSeconds` 须与边缘函数的 `TTL_SECONDS` 一致；ESA 站点、路由、回源分片和响应头见 [SID#1.0 第 3 节](../1_workflows/0_setup/AGENT-DESIGN.md#3-在-esa-准备分发和授权) |
| `4_content/7_storage` | `server/services/content/{object-retirement.service,object-retirement.repository,preload.service,preload.repository,command-receipts.service,upload-lifecycle.service,background.service}.ts`、`server/services/storage-audit/`、`server/lib/{aliyun-oss,esa-purge,esa-preload}.ts` | `contentRetirement`、`contentPreload`、`contentReceipts`、`contentUploads`、`storageAudit`（`config/shared.yaml`）；OSS 版本控制和生命周期规则（旧版本 7 天清除）见 [SID#1.0 第 2 节](../1_workflows/0_setup/AGENT-DESIGN.md#2-在-oss-建桶) |
公共组件和全站写法不在本表，见 `0_framework` 与 [SID#0.1.AGENT-DESIGN](../0_overall/1_architecture/AGENT-DESIGN.md#前端组件与样式)。

### 交界

- `1_accounts` 与 `3_admin`：前者写账号、会话、权限本身和它们的表，后者写管理员在控制台上能做的操作。控制台的操作写的是账号的表，表结构只在 `1_accounts` 写一次。
- `3_admin` 与 `5_operations`：后台扫描怎么跑、状态里有哪些字段写在 `5_operations`；这些状态和存储审计结果在控制台里怎么展示、谁能看，按人类 2026-11-12 的答复归 `3_admin`。
- `0_framework` 与 `SID#0.1.DESIGN`：查询、通知、水合的机制已在总体 DESIGN 写清，`0_framework` 只写用户看到的效果和公共组件的用法。
- `5_operations` 与 `SID#1`：怎么执行迁移、部署、排障归流程文档，`5_operations` 写这些设施对业务承诺什么。数据迁移和版本交付已由 `SID#1.1`、`SID#1.3`、`SID#1.4` 覆盖，`5_operations` 不重复。
- `5_operations` 与各业务目录：通知和后台扫描的通用机制在 `5_operations`，某项业务何时发通知、扫描处理什么待办，写在该业务自己的目录。
- `4_content` 与它的子目录：角色和机密规则各子目录都要用，统一写在 `4_content`，子目录只写自己的差异。

## 三类文档的骨架

以 [账号与权限](1_accounts/AGENT-DESIGN.md)为样板。章节可按目录的实际内容增减，顺序保持一致。

### LAW

只写人在网站上看得到、做得了的事，由人类编写。Agent 不改 LAW；人类需要时，Agent 可在同目录的 `TMP-LAW.md` 提供草稿，正式 `LAW.md` 写完后删除草稿。

写法以人类已写的三份为准：[账号与权限](1_accounts/LAW.md)是内容多的样子，[平凡页面](2_pages/LAW.md)是内容少的样子，[管理控制台](3_admin/LAW.md)居中。

- 用大白话，不带技术用语，篇幅短。简单的板块每节一两句话就够，平凡页面的 LAW 正文只有两句。
- 有需要交代的角色和说法时，开头用『概念』表；没有就不设。之后按功能或页面分节，讲这里有什么、谁能看到什么、能做什么。
- 能用一张小表说清的（比如权限分哪几级、哪项资料谁能改）就用表。
- 只讲大意，不写具体文案、数值、字符范围、时限这类细节，也不逐条列页面上的『整活』。这些下放给 AGENT-DESIGN 的『LAW 没写的细节』。
- 不写接口名、表名、函数名、状态码，也不写验收标准和测试文件。

Agent 提供草稿时照这个写法来，宁短勿长，另在末尾列出『还没定的事』：现状里需要人类先拿主意的地方，用问句写。人类写完正式 LAW 后，Agent 把答复抄进同目录 AGENT 的『人类裁定』再删草稿；没得到答复的问题继续留在『人类裁定』里。

### AGENT-DESIGN

写清楚这块业务是怎么实现的，让接手的人不必通读源码。LAW 只讲大意，具体实现由这份文档约束，所以它虽然是非权威文档，也不轻易改：改动其中的规则和数值先经人类同意。

| 章节 | 内容 |
| --- | --- |
| 入口 | 页面、组件、前端 feature、路由、服务、共享模块各在哪 |
| 数据库结构 | 本目录拥有的表：列、键、谁写谁读 |
| 状态与规则 | 状态机、版本号、并发与幂等的做法 |
| 接口 | 每个接口的访问要求和一句话说明 |
| 通知与轮询 | 发布和订阅哪些资源键，哪些查询带轮询 |
| 前端结构 | 入口函数、store、组件的分工 |
| 配置 | 用到的配置项、当前值、作用 |
| 向其他板块提供的能力 | 别的板块会调用的入口 |
| LAW 没写的细节 | LAW 略过的具体规定：数值、字符范围、时限、边界情况，按功能分小节 |
| 验收标准 | 能照着检验的条目，每条标出锁定它的测试文件，没有测试的写“无” |

总体 DESIGN 已有的机制只引用，不重述。

### AGENT

| 章节 | 内容 |
| --- | --- |
| 人类裁定 | 人类对待定问题的答复原文和落实情况；还没答复的问题也列在这里，写清现状和为什么要定 |
| LAW 解读 | LAW 的说法落到实现时取的读法，以及其中 Agent 自己做的取舍 |
| 落实与验证 | 改了什么、实际跑了哪些检查、哪些没能验证 |
| 代码与 LAW 的出入 | 发现的偏差，交人类裁定 |
| 其他出入 | 不涉及 LAW 的不一致 |
| 待办 | 事项与完成条件 |
| 传统与工作经验 | 代码里不直观的做法及其原因 |
| 旧资料去向 | `docs-legacy/` 和总体文档中的相关内容被哪里承接 |

文档头写核对基线（时间精确到秒并带时区、提交、是否含未提交工作区）和核对范围，说明哪些结论只读了代码、没有运行验证。

## 数据表归属

每张表只在一个目录的 AGENT-DESIGN 写结构，其他目录引用。现行结构以当前基线 SQL 及后续迁移为准。

| 表 | 归属 |
| --- | --- |
| `users`、`user_login_sessions`、`user_login_session_tokens`、`otp_send_logs` | `1_accounts` |
| `content_stories` | `4_content/0_stories` |
| `content_story_drafts` | `4_content/1_drafts` |
| `content_title_namespace`、`content_reference_journals` | `4_content/3_references` |
| `content_story_attachments` | `4_content/4_attachments`；图片相关的列由 `5_images` 说明，读取授权相关的列由 `6_access` 说明 |
| `content_command_receipts` | `4_content/4_attachments` |
| `content_transfer_sessions`、`content_transfer_attempts`、`content_transfer_parts`、`content_upload_part_grants` | `4_content/4_attachments` |
| `content_upload_images`、`content_image_jobs`、`content_image_attempts` | `4_content/5_images` |
| `content_object_retirements`、`content_preload_sites`、`content_preload_jobs`、`content_preload_budget` | `4_content/7_storage` |
| `content_sync_outbox` | `4_content`（各子目录共用） |
| `migration_runs`、`storage_audit_targets`、`storage_audit_findings` | `5_operations` |
| `content_migration_references`、`content_migration_scopes`、`content_migration_pins`、`content_migration_objects`、`content_webp_migration_objects` | 五张表的用途、归档和退出条件见[迁移明细归档与退役](../1_workflows/4_maintain/AGENT-DESIGN.md#迁移明细归档与退役)。在线使用方式见[对象退役](4_content/7_storage/AGENT-DESIGN.md#删除流程)和[存储审计](5_operations/AGENT-DESIGN.md#存储审计) |

已被后续迁移删除、不再写入文档的表:`content_operation_locks`、`content_locks`、`content_tasks`、`content_task_items`、`content_attachment_encryption_backup`、`content_attachment_storage_migrations`。

旧迁移架构使用的表(新架构从未创建):`schema_migrations`(已由 `migration_runs` 替代)。当前执行器发现这张表时会以 `legacy_ledger` 拒绝运行，不能带着它继续升级；须先用定基线前的匹配版本核对并完成账本迁移，再运行当前版本。

## 编写顺序

1. `1_accounts`（样板，三份文档齐）
2. `2_pages`（三份文档齐）
3. `3_admin`（三份文档齐；后台任务与存储审计视图已实现，待人类在浏览器里看）
4. `0_framework`、`5_operations`
5. `4_content` 及其子目录，按 0 到 8 的顺序

先写账号，是因为其他板块都依赖它的角色和权限定义。档案放最后，是因为它的角色一节要引用账号的权限，通知和后台任务要引用 `5_operations`。
