# AGENT-DESIGN：草稿机制的实现

- 本文档状态：PENDING（初稿，待人类审阅）
- 覆盖范围：云端草稿表、编辑权（租约）、草稿命令、发布、舍弃、删除档案、未发布草稿列表、编辑页
- 对应 LAW：[SID#2.4.1.LAW](LAW.md)；总则见 [SID#2.4.AGENT-DESIGN](../AGENT-DESIGN.md)

## 入口

| 位置 | 内容 |
| --- | --- |
| `server/services/content/draft.service.ts` | 新建、读取、列表、取得编辑权、草稿命令 |
| `server/services/content/draft-auth.service.ts` | 事务内重读身份和权限 |
| `server/services/content/draft.repository.ts`、`draft-summary.ts` | 读取草稿行、从正文前 4096 字符取标题 |
| `server/services/content/draft-sync.service.ts` | 草稿通知的 MQTT 读取凭据 |
| `server/shared/content-draft.ts`、`server/shared/types/content-draft.ts` | 租约时长、命令和回执的类型 |
| `app/features/content/draft.store.ts` | 页面一侧的编辑会话：租约、命令序号、自动保存、恢复区 |
| `app/features/content/editing.ts` | 编辑页适配：状态文字、保存、舍弃、删除、快捷键、页面可见性 |
| `app/features/content/draft-list.ts`、`app/components/MyContent/Story/DraftList.vue` | 未发布草稿列表 |
| `app/pages/content/[id]/edit.vue` | 编辑页；路由 `/content/new/edit`、`/content/draft-<id>/edit`、`/content/<id>/edit` |

## 数据库结构

### `content_story_drafts`

| 列 | 含义 |
| --- | --- |
| `id` | 32 位十六进制随机串 |
| `story_id` | 对应的档案；未发布时为空。唯一键，所以一篇档案最多一份草稿；外键 `ON DELETE CASCADE`，删档案时草稿一起删 |
| `create_request_id` | 新建请求的幂等键，与 `created_by` 组成唯一键 |
| `markdown` | 草稿的档案 Markdown |
| `draft_revision` | 草稿每次变化加一 |
| `namespace_revision`、`title_revision` | 引用改写的基线，见 `3_references` |
| `published_main_revision` | 草稿基于的正式版版本号；未发布时为空 |
| `unpublished_changes` | 草稿与正式版是否不同 |
| `lease_epoch` | 编辑权的代数，每次被取得加一 |
| `lease_actor_id`、`lease_session_id`、`lease_page_id`、`lease_token_hash` | 当前持有者：用户、登录会话、页面、令牌哈希 |
| `lease_until` | 编辑权到期时间；让出时置空 |
| `last_command_seq`、`last_command_hash`、`last_command_result` | 最近一条命令的序号、指纹和回执，用于重放 |

## 编辑权

- 租约时长 `draft_lease_ms()` = 保活间隔 + 2 × 请求超时 + 余量，按当前配置是 10 + 2 × 5 + 3 = 23 秒。
- 取得：`acquireDraft` 带上页面看到的 `expected_epoch`。只有租约已过期且代数没变时才成功，代数加一并清空命令记录；否则原样返回快照，`occupied` 为真。
- 持有者必须同时匹配用户、登录会话、页面、代数和令牌。换了标签页或重新登录都算别人。
- 页面一侧把截止时间算得比服务端早一个余量，到点就停止编辑，状态变为“连接中断”，不等网络报错。
- 续期：每条成功的命令都把 `lease_until` 往后推一个租约时长。编辑页按保活间隔轮询，即使没有输入也会发一条空的 `sync`。
- 让出：页面隐藏、`pagehide` 或离开时，先发出最后一份正文，再发 `release`；`release` 成功后 `lease_until` 置空。
- 关页时的 `release`：请求体小于 64 KiB 时 fetch 带 `keepalive`，页面关掉后浏览器仍会送出（`app/composables/useTrpcClient.ts`）。更大的、被强关或断网没送到的，靠租约到期兜底。
- 草稿的六个接口（`createDraft`、`listDrafts`、`getDraft`、`acquireDraft`、`commandDraft`、`draftSyncCredentials`）不走批量请求，直接单发。

## 草稿命令

`commandDraft` 处理 `sync`、`release`、`publish`、`reset`、`delete` 五种命令，每条都带租约、序号 `seq` 和可选的正文。

处理顺序：
1. 事务里加锁：标题命名空间（`sync` 不带正文时跳过）、档案行、草稿行，然后重读身份和权限。
2. 同一持有者、同一序号、同一指纹的命令，直接返回记下的回执。网络丢了回复时，页面原样重发就能拿到结果。
3. 不是持有者或租约已过期，返回 `lease_lost`；序号不是上一条加一，返回 `command_order`。
4. 带正文时先按引用历史改写，见 `3_references`；历史不可用又没有确认令牌时，返回 `reference_review_required`。正文超过 `markdownMaxBytes`（当前 1 MiB）时返回 413。
5. `publish`、`reset` 要求 `expected_revision` 等于当前 `draft_revision`，否则返回 `snapshot_changed`。
6. 执行命令本身，见下表。400、409、413 类的业务错误回滚到保存点，回执记为 `validation_failed`。
7. 记下序号、指纹和回执，续期或让出，写通知。

| 命令 | 效果 |
| --- | --- |
| `sync` | 只保存正文 |
| `release` | 保存正文并让出编辑权 |
| `publish` | 未发布的：`create_story` 建档案，草稿绑定 `story_id`。已发布的：先核对正式版版本号等于 `published_main_revision`，再 `update_story` |
| `reset` | 已发布的：草稿换回正式版，`unpublished_changes` 置 0。未发布的：删除草稿 |
| `delete` | 已发布的：`delete_story`，草稿随外键删除。未发布的：删除草稿 |

`create_story`、`update_story` 的 `can_private` 都传 `true`，因为 `full` 已包含 `private_read`。

页面一侧（`draft.store.ts`）：
- 自动保存节流 `app.content.draft.saveThrottleMs`（`config/app-settings.yaml`，现为 1 秒）：距上次带正文的 `sync` 不足 1 秒时只排定时器，停手后的最后一段输入也会保存。
- 同一时刻只有一条命令在途（`flight`），这时再发命令就复用它；发布、舍弃、删除、让出都先等在途的命令结束。
- 回执只确认发出时的那份正文。请求发出后又输入的文字不会被回包覆盖，仍算未确认，下一轮再传。
- 站内离开前的 `flush_changes` 等在途命令，然后跳过节流保存最新正文。失败或达到整次导航等待期限后停止追加请求，在途回执仍可确认它对应的正文。
- 页面代次 `generation`：每次 `configure`、`clear` 都加一，异步回包先核对代次再生效。所以重新挂载、换号、同一草稿 A→B→A 往返之后，旧回包一律作废。

## 新建

`createDraft` 带页面生成的 `request_id`。同一用户重复提交时，`ON DUPLICATE KEY` 返回已有的那份。新草稿正文由 `story_markdown_template()` 生成，默认省略 `time`，作者按需补写。成功后页面用 `replace` 跳到 `/content/draft-<id>/edit`；首次发布后再跳到 `/content/<story_id>/edit`。

## 未发布草稿列表

`listDrafts` 一次返回 `story_id` 为空或 `unpublished_changes = 1` 的全部草稿，按更新时间倒序（同一时刻再按 `id` 倒序）。标题从正文前 4096 字符的 Front Matter 里取，不返回正文。列表页按保活间隔轮询，并订阅 `content_drafts:all`。`DraftList` 在顶层 await 首次请求（水合期间跳过），只在浏览器取数。列表页在切换时借此保留旧视图，见 `0_stories` 的列表页说明。

首次取数时显示骨架。请求失败时显示带刷新图标、大号描边次要样式的『重新加载』按钮，首载失败的按钮放在空态位置。收到空结果时显示『还没有草稿~』。首载失败提示『草稿列表加载失败，请重试』。刷新失败提示『草稿列表更新失败』，已读到的草稿继续显示。连续后台失败只提示一次，手动重试失败可再次提示。

## 通知

| 资源 | 什么时候写 |
| --- | --- |
| `content_draft:<id>` | 取得编辑权、正文变化、`publish`/`reset`/`release`/`delete` 成功 |
| `content_drafts:all` | 新建、正文变化、上述命令成功 |

发布和删除档案时，`content_stories:all`、`content_story:<id>` 的通知由 `story.service.ts` 写，见 `0_stories`。草稿通知需要权限，MQTT 读取凭据由 `draftSyncCredentials` 发放，有效期 30 秒，见 [SID#2.5 的通知送达](../../5_operations/AGENT-DESIGN.md#通知送达)。

草稿六个接口的 HTTP 响应一律带 `Cache-Control: no-store`，包括鉴权失败、出错和混有草稿接口的批量请求；这些请求出错时日志只记错误码（`server/api/trpc/[trpc].ts`）。

## 编辑页

云端草稿就绪时，连接转圈淡出，随后编辑内容淡入。编辑页复用全站页面的过渡时长和减少动态效果设置。

首次读取或新建草稿失败时，显示『重新加载』并以 Toast 说明失败来源。按原保活间隔自动重试，连续失败时保留按钮并合并 Toast。手动重试期间显示连接转圈，失败时可再次提示。新建重试复用同一页的 `request_id`。首次读取确认 404 时返回档案列表。确认 403 时显示云端草稿无权访问并停止打开请求。

### 状态文字

`editing.ts` 的 `draft_status_label` 按顺序取第一个成立的：

权限撤销先由编辑页的整屏占位处理，不另计算不可见的工具栏权限标签。连接占位与编辑内容使用 `site-page` 的先出后入过渡，减少动态效果时直接切换。

收到有效草稿响应后清除断线提示，包括不带正文的续租成功。待处理的命令拒绝仍按对应回执显示。

| 条件 | 文字 |
| --- | --- |
| 恢复区打开 | 编辑权已变更，恢复区可用 |
| 连接中断且有未确认修改 | 连接中断，修改尚未保存 |
| store 有消息 | 该消息，如“连接中断，已暂停编辑” |
| 正在取得 | 正在取得编辑权…… |
| 不可用 | 云端草稿不可用 |
| 超时 | 连接中断 |
| 正在让出 | 正在保存并让出编辑权…… |
| 正在处理命令 | 正在处理草稿…… |
| 正在改写引用 | 正在更新引用…… |
| 恢复区已关闭且仍显示同一云端版本，没有未确认修改 | 草稿与云端一致 |
| 别的页面持有 | 其他页面正在编辑 |
| 有未确认的输入 | 修改待保存…… |
| 尚未首次发布，或有已保存的未发布修改 | 草稿已保存，尚未发布 |
| 与正式版相同 | 与已发布版本一致 |

### 恢复区

编辑权被拿走时，`draft.store.ts` 的 `lose()` 把未确认的输入放进 `recovery`，编辑器换成云端正文并变为只读。`edit.vue` 在 `recovery` 非空时弹出 `MyDialog`，首次点击『复制未保存内容』前隐藏关闭按钮，按 Esc 或点击遮罩也无法关闭。点击后尝试把原文写入剪贴板，同时恢复关闭入口。复制成功或失败都通过 Toast 提示，弹窗保持打开。关闭对话框会清空 `recovery`。恢复区只存在内存里，不写本地存储。

### 编辑器状态

- 登录身份（用户 id、是否管理员、权限）变化时，`editing.ts` 清空正文、恢复区和命令状态。草稿失效、换成另一份草稿、其他页面接管租约或成功舍弃时，原编辑器会话也结束
- 同一草稿刷新或重新取得编辑权时，编辑器、粘贴命名弹窗及附件选择现场保留。租约代数变化只清空撤销历史，随后同步来的正文也不会进入撤销记录
- 界面状态：按账号和草稿 id 分开存在 localStorage，键为 `stupig:editor-view:<用户 id>:<草稿 id>`。记录全屏、编辑或预览、预览视角、分栏比例、附件栏宽度、正文是否有焦点、光标选区，以及编辑区、预览区和页面的滚动位置（`app/features/content/markdown/view-state.ts`）。隐藏页面、`pagehide`、卸载时写入，挂载后恢复。首次发布沿用同一个草稿 id 和界面状态。存储不可用或记录损坏时用默认值
- 离开时若焦点在正文，切回标签或重进同一草稿后，等正文可见并取得编辑权，再从原光标或选区继续输入。同一标签沿用编辑器当前选区，后台的引用修改可移动选区。焦点在查找框、弹窗或其他控件时，由该控件继续接收输入
- 收到云端正文快照时将选区截到新正文范围内，引用补丁则按改动映射选区。两者都保留视口。图片、字体等布局晚到时继续恢复滚动位置，用户滚轮、触摸、按指针或按键就停止恢复（`app/features/content/markdown/editor.ts`）
- 上传字节、等待图片处理、刷新附件目录时可继续编辑。粘贴和拖入文件会记住当时的插入点，并随 CodeMirror 的正文改动调整；附件落地后按最终文件名插入，保留当前选区和焦点
- 附件落地时若档案正在保存，等保存结束后再尝试插入。仍在原档案编辑页而自动插入失败时，每批提示一次『附件已上传，但自动插入正文失败，请手动插入~』。页面在后台时，切回本页再提示。
- 查询引用改写时仍可输入，暂缓发布。服务端回包只应用到发起查询时的同一份文字；期间又输入的内容沿用原引用版本，在下一次草稿同步时一起改写
- 只读有三层：`EditorState.readOnly`、`EditorView.editable` 和一个 `transactionFilter`。过滤器拦下只读时改正文的事务，只放行带 `external_update` 标记的程序更新（云端正文、引用补丁）。

### 操作

- 创建与保存按钮共用发布入口，图片编辑器关闭时 Ctrl+S / ⌘S 也调用该入口。同步云端草稿后，立即检查即将发布的 Markdown。`error` 阻止发布，`warning` 照常显示。成功后提示『档案已保存』。图片编辑器打开时的快捷键见 [图片编辑器](../5_images/AGENT-DESIGN.md#图片编辑器)。
- 站内导航离开当前编辑路径时，若仍有未确认修改，最多等待一个 `requestTimeoutMs`（现为 5 秒）保存最新正文。保存失败或超时后仍有未确认修改时，弹出『草稿尚未保存』。左侧是纯文字按钮『离开』，右侧是默认聚焦的实底按钮『留下』。关闭弹窗等同留下。点击留下保留正文，连接恢复后可按原序号补发。继续离开由卸载流程保存并让权。只有续租失败且正文已确认时可以直接离开。
- 仍有未确认修改时注册 `beforeunload`。浏览器接管刷新和关页的离开提醒。恢复区里还保留未保存文字时也启用离开保护，文字供作者复制保留。
- 舍弃：用确认气泡“确定要舍弃草稿吗？”。确认时如果版本或输入已变，就不执行。按钮只在有未发布修改或档案未发布、且没有显式草稿动作 pending 时显示；不可写时禁用，不再设置不可见的独立忙碌状态。
- 删除：点击原按钮后先查删除影响，等待时该按钮转圈并禁用，成功后才打开 `MyContentDeleteImpact`。失败显示 Toast『引用检查失败，请重试后再删除』，可再次点击原按钮重试。
- 删除确认保留“空城计？”标题，依次显示删除说明、引用影响和检查时点。『草稿引用』组的右侧提示云端草稿命中，组内另列当前未保存的修改中的引用位置。完整分组和位置规则见[删除前的引用确认](../3_references/AGENT-DESIGN.md#删除前的引用确认)。
- 检查时点说明居右。引用链接用 `.link` 的底边作为下划线，悬停时加粗
- 图标与文字的对齐沿用 [SID#0.1 的界面惯例](../../../0_overall/1_architecture/AGENT-DESIGN.md#界面惯例)。
- 草稿被删除（404）时跳回 `/content`。

## LAW 没写的细节

- 新档案的保存按钮显示“创建”，已发布的显示“保存”。
- 编辑页的标题固定为“蠢猪档案 - 编辑”，并设 `noindex, nofollow`。
- 摘要区在 Front Matter 暂时写错时保留最后一次正确的样子。
- 新建页在附件区显示“创建档案后即可上传附件”。

## 验收标准

| 条目 | 测试 |
| --- | --- |
| 开始只读，从服务端取得编辑权，不用本地存储 | `draft.store.test.ts` 的 “starts read only …” |
| 被接管时未确认的输入进恢复区 | `draft.store.test.ts` 的 “moves unconfirmed input to a read only recovery area …” |
| 到保守截止时间就停止编辑 | `draft.store.test.ts` 的 “stops editing at the conservative deadline …” |
| 丢失回复后用相同序号和内容重发 | `draft.store.test.ts` 的 “retries a lost response …” |
| 最新输入确认后才发布 | `draft.store.test.ts` 的 “only publishes after …” |
| 舍弃未发布草稿会删除它 | `draft.store.test.ts` 的 “removes an unpublished draft on discard …” |
| 舍弃的确认绑定当时的版本和输入 | `editing.test.ts` 的 “binds destructive reset approval …” |
| 区分空闲草稿和被别的页面占用的草稿 | `editing.test.ts` 的 “distinguishes an available draft …” |
| 未发布前不能上传附件 | `editing.test.ts` 的 “rejects attachment uploads before a story exists” |
| 跨标签页、过期、丢失回复、舍弃的完整流程 | `tests/e2e/content-draft-*.spec.ts` |
| 服务端的租约判定、命令序号、重放、`snapshot_changed`、发布基线、`reset`、列表查询范围与排序 | [draft.service.test.ts](../../../../server/services/content/draft.service.test.ts)（替身数据库，只验证分支和查询；SQL 实际效果靠 E2E） |
| 恢复区对话框 | [编辑页组件测试](../../../../app/pages/content/[id]/edit.nuxt.test.ts) |
