# AGENT-DESIGN：蠢猪档案的总体实现

- 本文档状态：PENDING（初稿，待人类审阅）
- 覆盖范围：档案板块各子目录共用的入口、权限判定、机密内容机制和通知；各子目录的实现写在子目录的 AGENT-DESIGN
- 对应 LAW：[SID#2.4.LAW](LAW.md)

## 入口

| 位置 | 内容 |
| --- | --- |
| `server/trpc/routers/content.ts` | 档案板块全部 tRPC 接口 |
| `server/services/content.service.ts` | 列表、正文、下载签名的对外出口 |
| `server/services/content/` | 各子目录的服务和仓储，按文件名前缀归属：`story`→`0_stories`，`draft`→`1_drafts`，`reference`→`3_references`，`workspace`、`attachment-workspace`、`command-receipts`、`upload`、`transfer-session`→`4_attachments`，`image`、`redacted-variant`→`5_images`，`attachment-access`、`edge-read`→`6_access`，`object`、`preload`、`background`→`7_storage` |
| `server/shared/content-*.ts` | 前后端共用的解析和校验 |
| `app/pages/content/` | 列表、详情、编辑三类页面 |
| `app/features/content/` | `markdown/`、`attachments/`、`uploads/`、`image-editor/` |

## 权限判定

权限的含义和比较方式见 [SID#2.1.AGENT-DESIGN](../1_accounts/AGENT-DESIGN.md#权限判定)。级别按高低比较，所以 `full` 包含 `private_read`，管理员恒为真。

| 判定点 | 要求 | 位置 |
| --- | --- | --- |
| 草稿、附件管理、上传、删除影响、图片编辑器等写接口 | `content_access` 达到 `full` | 路由层 `content_admin_procedure` |
| 草稿操作 | 在事务里加锁重读用户、会话、令牌，再查 `full` | `draft-auth.service.ts` 的 `require_draft_actor` |
| 附件操作 | 在事务里重读用户，查 `full`；涉及机密时再查 `private_read` | `workspace-auth.service.ts` 的 `require_workspace_actor` |
| 列表、正文、附件目录、下载签名 | 公开；按 `private_read` 决定返回范围 | `story.service.ts`、`attachment-workspace.service.ts`、`upload.service.ts` |

路由层的检查用的是请求时的身份；写操作在服务层事务里重读一次数据库，防止检查之后权限被撤销。

## 机密内容

| 对象 | 机制 | 位置 |
| --- | --- | --- |
| 正文 | `<good>…</good>`，可作块或行内，可嵌套 | `server/shared/content-private.ts` |
| 正文对没有权限者 | 服务端把每个机密元素换成占位“你无权查看此处的机密内容”，原文不出服务端 | `redact_private_content` |
| 附件 | `content_story_attachments.is_private` | 见 `4_attachments` |
| 附件对没有权限者 | 目录照常列出，`url` 置空；有删减版的给删减版 | `attachment-workspace.service.ts`、`6_access` |
| 摘要 | 不判定机密，`list_stories` 原样返回 | `story.service.ts` |

正文的版本标识 `representation_version` 按查看者的投影计算，所以访客拿到的去掉机密内容的正文与有权限者的全文不会被缓存混用。

附件目录同理，带 `viewer_key`：`<用户 id 或 anon>:<是否可读机密>`（`attachment-workspace.service.ts`）。前端只在 `viewer_key` 相同、新快照的版本又更旧时丢弃新快照；查看者或权限一变，就无条件采用新的投影（`app/features/content/attachments/model.ts`）。

## 通知

档案的变化经 `content_sync_outbox` 送达，机制见 [SID#2.5.AGENT-DESIGN](../5_operations/AGENT-DESIGN.md#content_sync_outbox)。各子目录在自己的事务里写 outbox，资源名如 `content_story:<id>`，写在各子目录。

## 已退役的接口

`createStory`、`updateStory`、`deleteStory` 一律返回 409“编辑协议已升级，请刷新页面后使用云端草稿”，留给还开着旧页面的人。档案的创建、修改、删除都走草稿，见 `1_drafts`。

## 下放给子目录的规则

| 规则 | 写在 |
| --- | --- |
| 附件操作立即生效、不随草稿发布 | `4_attachments` |
| 机密附件对没有权限者列出名字但打不开 | `4_attachments`、`6_access` |
| 机密内容原处留“无权查看”提示 | `2_markdown` |

## 验收标准

| 条目 | 测试 |
| --- | --- |
| 机密元素的解析和替换 | `server/shared/content-private.test.ts` |
| 访客拿到的正文里机密内容已换成占位，`private_readable` 为 false | `server/services/content/story.service.test.ts` |
| 只有『机密可读』的人不能做附件操作，涉及机密目录时也一样 | `server/services/content/workspace-command.service.test.ts` 的 “rejects a read-only holder …” 两条 |
