# 共享云端草稿、引用基线与同步保护

正式正文 main、共享云端 draft、附件工作区和上传会话各有独立生命周期。自动保存只更新 draft；“保存／创建”才发布 main。上传成功不会直接替代整篇草稿，附件路径变化通过引用历史精确作用于 main 和 draft。

## 草稿状态

每篇 story 对应一条 `content_story_drafts`；未发布草稿有独立 ID，首次发布绑定 main 并保留 draft ID。`/content/new/edit` 创建独立草稿并替换为 `/content/draft-<id>/edit`；档案首页可切换“已发布”和“未发布草稿”，草稿卡片包含未发布草稿以及已发布档案中尚未发布的修改。旧 `/content/drafts` 地址跳转到首页草稿视图。列表仅向有权限的客户端提供有限标题和更新时间，不批量下发正文。所有草稿读取、占用和命令同时要求 `content_manage:full`、`content_private:read`，包括不完整或未闭合 `<good>` 的正文。

`contentDraft` Pinia store 拥有内存文本、确认快照、串行命令、租约状态、引用核对及只读恢复区。`useStoryEditSession` 只接 API、页面可见性、路由、认证代次、CodeMirror 和 `useSyncedData`。页面代次使同一档案重挂载、换号和 A→B→A 后的旧回包失效；清理同时使编辑器重新挂载，丢弃旧文档与 undo。store 不持有 MQTT 连接，也不保存上传 `File`。

不再读取、写入或自动导入 localStorage 草稿，也不使用 sessionStorage、IndexedDB 或 Web Locks 保存正文与编辑权。旧键按管理员已选策略由管理员自行处理，应用不删除；上传恢复句柄和偏好设置保持各自生命周期。普通初始化、回读与保存不升级旧引用语法。

## 编辑权、调度与断线

编辑器默认只读。页面可见后从 MySQL 申请独占租约，凭证绑定当前账号、登录会话、页面 ID 和 epoch；跨浏览器也只能有一个写者。输入至少间隔 N=1 秒提交，尾随输入仍会保存；请求结束后的空窗由 `useSyncedData` 按 M=10 秒轮询。每次请求上限 T=5 秒，S=3 秒余量，服务端 L=M+2T+S=23 秒；数值来自 `app.content.draft`。纯保活不拉附件工作区、不更新正文时间、不广播通知。

请求失败或本地保守截止时间到达立即只读。客户端保留原申请身份或原命令的 seq 与完整负载，先核对未知结果再处理新输入；重复命令不重复写入、不续租、不发 outbox。同 seq 不同负载被拒绝。保存响应仅确认发出的快照，不能覆盖发送后继续输入的文字。丢失租约后未确认文本仅留在本页只读恢复区；不自动覆盖新持有者。

页面隐藏或销毁时先关输入，尽力把最后快照与 release 一起提交。草稿 RPC 直接发送，小于 64KiB 的 release 使用 fetch keepalive；大快照、强关页面、浏览器冻结和网络故障仍靠租约到期兜底。焦点变化不等于页面隐藏；没有 Web Locks 也可编辑。重新可见时立即核对，不能凭本地事件解锁。

“舍弃草稿”绑定确认时的文本与 draft revision，恢复为当前 main 或新建模板。发布只接受已确认的当前 draft revision；无效 Markdown 能自动保存但不能发布。旧 `createStory/updateStory/deleteStory` 写入协议返回升级提示，不得绕过租约。

事务锁顺序为标题作用域 → story/scope → draft，随后同连接锁定读取当前用户、会话和请求所携带 token generation。草稿与 story 的绑定先在事务外定位，取得锁后重新核对；期间首次发布导致绑定变化时，回滚并重新定位，不能倒序补锁。业务快照在作用域锁之后建立，确保等待附件改名提交后能同时读到新版本和对应历史。等待锁之后读取数据库时间，最终受保护写入前再次核对权限及到期；有效的旧 token generation 正常轮换仍可用，退出或复用 session row 不会复活旧请求。main、draft、引用和 outbox 同事务提交。

## 三类版本

保存／重置后的界面反馈以匹配且成功的命令回执为依据，不能把一次 refresh 正常返回当作发布成功。删除后清空当前 draft；删除响应丢失时，重试若确认目标已不存在，也会清空页面并返回目录，不伪造数据库回执。

| 基线 | 解决的问题 |
| --- | --- |
| main revision / draft revision | main 的正式发布版本与 draft 确认版本分别计数；发布／重置检查当前 draft 快照 |
| namespace revision | 判断附件／目录路径在草稿产生后如何变化 |
| title revision | 判断被引用档案的标题如何变化 |

附件和标题共用统一历史表及重放模块。附件作用域为所属 story，标题作用域为全局；两者保留各自的 revision/baseline。匹配依据是“作用域 + 归一化的 `att://…` / `content://…`”，对象 ID 仅用于追踪。归一化规则见 [Markdown 引用](markdown.md)。

main 和持久化 draft 在变更事务内应用新批次并写入 outbox。标题改名检查全部 main 与 draft，包括未发布草稿；附件变更处理所属 story。创建、删除及空映射批次也推进已消费 baseline。机械引用更新不消耗 main 的发布 revision，但推进 draft revision；客户端未上传输入按自身 baseline 重放，提交时服务端再次核对。

每个批次内的变更同时解释，批次间按 revision 顺序执行，再按当前路径／标题解析目标。例如同批次 `a → b`、`b → c` 不会把原来指向 a 的引用连续改到 c。

当历史基线未知、早于裁剪 floor 或超前于当前版本时，系统不能证明旧引用如何变化，需要用户审查。删除附件、目录或被引用档案不会因正文／草稿引用而被拒绝；原链接保留为悬空引用，编辑器显示 warning，并允许保存。同路径或同标题的新目标出现后，引用静默指向当前同名目标。权限、上传预约和版本校验仍然有效。

自动保存时发现引用历史不可用，会返回绑定 draft ID、epoch、提交文本、旧基线及当前作用域版本的核对摘要。该业务终态消费序号但不保存文本；保活不会清除待核对状态。核对后以新序号提交，摘要不匹配则重新核对；发布、权限及租约校验仍然执行。摘要是快照约束，不是授权凭证。

## 异步重放

store 串行处理确认快照和未上传输入的引用重放；结果只在页面代次和原文仍匹配时应用。已有 `create_draft_reference_bridge()` 继续提供可复用的快照补丁协调，不能绕过 store 的编辑权。

编辑器通过 `apply_reference_changes(snapshot, changes)` 应用目标补丁，保留其他正文和编辑历史。没有变化的目标不顺手格式化。引用语法和忽略区域与[Markdown 解析](markdown.md)共用。

## 慢网速下的编辑保护

正文只读状态覆盖服务端正文同步、引用重放请求以及上传末期的引用同步衔接。上传运行时从 seal／图片处理／adopt 观察到 finalizing，接受工作区和调用落地回调时继续保持保护，再交给正文引用同步。

这段保护针对『上传已成功，但正文替换尚未完成』的空窗期：不能提前解锁让用户输入，再用旧请求结果覆盖新内容。它不要求整段上传期间禁用所有附件操作。

只读同时设置 CodeMirror `EditorState.readOnly`、`EditorView.editable` 和文档事务过滤。键盘、粘贴、undo、程序插入都检查当前许可及单调时钟截止时间；上传插入额外绑定开始时的页面代次和租约 epoch，新租约不会复活旧回调，编辑会话更换时清理粘贴命名窗口。服务端引用补丁单独标记且不进入 undo。单纯把保存按钮变灰不能保护正文。

## 通知与敏感数据

草稿正文仅客户端授权读取，不进入 SSR payload/head。所有 draft HTTP 路径及混合 batch 标记 `Cache-Control: no-store`；错误日志不记录正文、凭证或 SQL 参数。草稿事件沿用事务 outbox，topic 与 payload 使用相同 HMAC resource，内容不含正文、原始 draft ID 或租约凭证。

草稿通知使用独立 `stupig/draft-sync` 前缀及授权 WS listener。客户端凭当前登录领取最长 30 秒的内存凭据，broker 重新验证当前权限与会话，只准订阅该前缀，不能发布。撤权后的既有连接最多保留到凭据过期，消息只有失效信号；API 每次事务即时重新授权。断网和消息丢失由 M 轮询补偿，见 [MQTT](../../deployment/mqtt.md)。

## 引用历史维护

`content_reference_journals` 一行记录一个目标变化，以 `(scope_id, revision, entry_index)` 标识；`scope_id = 0` 为全局标题，其余为附件所属 story。创建的 `from_ref` 为 null，删除的 `to_ref` 为 null；空映射批次用两者均为 null 的一行记录目录／表示版本变化。

`app.content.reference.journalBatchLimit` 当前为 **200 个完整批次／作用域**。一次批量操作即使包含超过 200 行，也不会被拆开。追加历史、裁剪最旧批次、推进 floor、保存 main 及 outbox 在同一事务提交；不再叠加 30 天 TTL，也不需要独立清理定时器。floor 等于最后被裁剪批次的 revision：baseline 等于 floor 仍可重放，早于 floor 则提示历史不足，不能冒充已同步。

附件历史在有效基线到当前版本之间必须逐批连续；缺批返回 503 并回滚保存，不推进草稿基线。旧版标题创建曾只推进版本、不记录空批次，因此标题历史保留合法跳号兼容。

升级通过三步维护迁移展开表、转换旧 JSON 批次并收紧结构；旧 scope/revision 保持不变，已有有效草稿基线可继续使用。操作要求与隔离验证命令见[迁移手册](../../operations/migrations.md)。

## 源码与验证

- 草稿：[`contentDraft.ts`](../../../app/stores/contentDraft.ts)。
- 页面生命周期：[`useStoryEditSession.ts`](../../../app/composables/useStoryEditSession.ts)。
- 重放协调：[`draft-reference-bridge.ts`](../../../app/utils/content/draft-reference-bridge.ts)。
- 编辑器只读及补丁：[`useStoryEditor.ts`](../../../app/composables/useStoryEditor.ts)。
- 服务端历史：[`reference-history.service.ts`](../../../server/services/content/reference-history.service.ts)。
- 历史存储与裁剪：[`reference-journal.repository.ts`](../../../server/services/content/reference-journal.repository.ts)。
- 统一重放：[`content-reference-replay.ts`](../../../server/shared/content-reference-replay.ts)。
- MySQL 隔离验证：[`reference-history.ts`](../../../scripts/verify/reference-history.ts)。
- 草稿事务与私有通知：[`cloud-drafts.ts`](../../../scripts/verify/cloud-drafts.ts)、[`cloud-draft-mqtt.ts`](../../../scripts/verify/cloud-draft-mqtt.ts)。
- 有界容量验证：[`cloud-draft-capacity.ts`](../../../scripts/verify/cloud-draft-capacity.ts)，随草稿 QA 使用随机库运行。

验证入口及已运行范围见[实现记录](../../designs/shared-cloud-draft-implementation-2026-10-30.md)与[测试手册](../../development/testing.md)。源码落地和本地隔离验收不代表生产迁移、反代或部署已完成。
