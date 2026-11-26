# AGENT-DESIGN：附件的实现

- 本文档状态：PENDING（初稿，待人类审阅）
- 覆盖范围：附件列表、上传受理、各种附件操作、冲突 resolve
- 对应 LAW：[SID#2.4.4.LAW](LAW.md)；引用跟随见 `3_references`；图片处理见 `5_images`；权限见 `6_access`；存储与后台任务见 `7_storage`

## 入口

| 位置 | 内容 |
| --- | --- |
| `app/components/MyContent/Attachment/Workspace.vue` | 附件列表、右键菜单、改名 |
| `app/components/MyContent/Attachment/Card.vue` | 单个 item 的显示，详情页、编辑页、resolve dialog、附件状态变更确认 dialog 共用 |
| `app/components/MyContent/Attachment/Resolve.vue` | 冲突 resolve dialog |
| `app/components/MyContent/Attachment/PrivacyConfirm.vue` | 附件状态变更确认 dialog |
| `server/services/content/privacy-confirmation.ts` | 计算机密状态及删减版关系的变化，未确认时拒绝整批 |
| `app/features/content/attachments/list-model.ts`、`list-interaction.ts` | 列表行、树、冲突标红；行选择和附件添加菜单的共享项定义 |
| `app/features/content/uploads/` | 上传队列、受理、运行时 |
| `server/services/content/upload-admission.service.ts` | 上传受理与冲突汇报 |
| `server/shared/content-workspace.ts` | `WorkspaceIssue` 及其 schema |
| `server/shared/api-error.ts` | `BATCH_REJECTED` 的 `items`、`valid_count`；`PRIVACY_CONFIRMATION` 的 `changes`、`total`、`digest` |

## 细则

- 详情页和编辑页的附件列表首次请求期间显示骨架。首载失败时在空态位置显示带刷新图标、大号描边次要样式的『重新加载』按钮，并以 Toast 提示『附件列表加载失败，请重试』。成功取回空目录时显示『暂无附件~』。刷新失败保留已读目录，提示『附件列表更新失败』。连续后台失败只提示一次，手动重试失败可再次提示。
- 附件目录是 `content_story_attachments` 里的一棵树：每篇档案有一个根节点（`parent_id` 为 0），文件夹是显式的行，所以可以有空文件夹；每行有稳定的 `id`，改名、移动只改 `parent_id`、`name`、`name_key` 和 `node_revision`，不动对象键（`workspace.repository.ts`、`workspace-command.service.ts`）；
- 节点版本 `node_version` 是该节点（文件夹连同整棵子树）的 id、父节点、名字、`node_revision`、对象键、版本和机密状态的 sha256。命令带上看到的版本，对不上就拒绝，所以文件夹里任何一项变了，对文件夹的操作也要重来；
- 名称长度按字节计，上限 255；比较不分大小写，比较键 `attachment_name_key` 为 NFC 后转小写；
- 机密判定：`attachment_privacy`（`server/shared/content-markdown.ts`）。同一文件夹里有 `X.good` 时文件 `X` 是删减版，公开；其余看路径里是否有以 `.good` 结尾的段；
- 每次附件操作结束时（`finish_namespace_change`）按这条规则重算整篇档案各行的 `is_private`。改为公开只发生在路径带 `.good` 的删减版上；路径没有 `.good` 却标了机密的旧行保持机密；
- 上传受理时，目标名正好是某个 `X.good` 的删减版名则按公开受理，计算时排除即将被替换的旧文件。普通替换选择「保留原名称」时，使用新文件的扩展名，保留原文件和新文件自带的 `.good` 标记；
- 文件改名对话框锁住 `.good` 后缀。右键『设为机密／取消机密』操作条目自身的标记，不因上级文件夹的机密状态而禁用；仅继承机密的条目可添加自己的 `.good`，既继承又有自身标记的条目可移除自己的 `.good`。实际可见状态及删减版关系仍按整批最终结果判断。只有『取消机密』或文件夹改名成功移除自身 `.good`、但仍因祖先文件夹保持机密时，服务端才在成功回执中带回这些条目的最终路径，前端提示数量；添加标记不提示；
- 粘贴上传的更名弹窗与普通改名一致：用 `MyFileNameInput` 和 `split_attachment_editable_name` 把名称与扩展名（含 `.good`）分开，只编辑名称，扩展名作为固定后缀显示（`app/pages/content/[id]/edit.vue`）。名称为空时上传按钮禁用。`MyFilteredInput` 对外部填入的默认值（如粘贴的原始文件名）也自动过滤非法字符，与手动输入的清洗一致；锁定后缀同样过滤（`MyFileNameInput` 显示层兜底，粘贴提交值在填入时清洗）；
- 附件列表、编辑器补全和两个确认弹窗的附件行用文件类型图标或文件夹展开箭头（`presentation.ts`）。机密文件和列表里的机密目录用琥珀色，删减版文件（服务端下发 `is_redaction`）用蓝色，公开用灰色。未入库的上传行由 `attachment_upload_privacy`（`list-model.ts`）按路径判断删减版。附件状态变更确认的箭头两侧用同一个文件类型图标或文件夹图标，以灰色、琥珀色和蓝色分别表示公开、机密和删减版，悬停及读屏仍提供状态文字；正文卡片和图片标条见 [SID#2.4.2.AGENT-DESIGN](../2_markdown/AGENT-DESIGN.md#正文里的机密附件)；
- 附件状态变更确认由服务端判定，客户端按回执显示：
  - 附件操作（`workspace-command.service.ts`）和上传受理（`upload-admission.service.ts`）在冲突全部解决、整批写入之后、`finish_namespace_change` 之前，调用 `require_privacy_confirmation` 对比操作前后各 item 的 `{机密, 删减版}`；
  - 新上传的 item 以「目标路径上的一般 item」为操作前状态；替换类上传视为原行移到目标路径；被删除的 item 不列出，但它引起的其他 item 的变化要列出；
  - 『设为机密』和『取消机密』按实际执行的直接选中项 ID 判定免确认。最终机密状态符合指令且删减版关系未变时，省略该项。目录子孙、其他项目及删减版关系变化仍参与确认。
  - 有变化且请求里的 `privacy_digest` 与变化列表的 SHA-256 不符时，抛 `PRIVACY_CONFIRMATION`。回执的 `changes` 与摘要使用同一份完整列表，不受单批操作数量限制，`total` 必须等于列表长度。`workspace_transaction` 像 `BATCH_REJECTED` 一样回滚到 savepoint 并存回执；旧截断回执提示重新发起操作；
  - 客户端弹 `PrivacyConfirm.vue`，按预计最终路径在一棵可滚动的树中列出全部待确认变化，底部注明「以上为打开此框时的检查结果」。「继续」带上 `digest`、换新 `request_id` 重交；变化不同则再问一次；
  - 上传发布（文件传完后落地）不再检查；
- 设为机密或取消机密、拖动移动、上传都直接提交，由上面的检查决定是否确认；
- 机密上传：路径还没有 `.good` 时自动补上；自带的 `.good` 保留生效；
- pending items 与正常 items、父代与子代不能同时选中；支持 Shift 区间选择；
- 移动弹窗里普通点击展开或折叠目录。Ctrl／Cmd／Shift 点击、左滑或 Enter 选中目标，换目录时直接替换原目标。框选只命中一个有效目标时也可换选。
- 删除不可撤销，需二次确认。原删除入口先发起引用检查，等待时显示加载状态并禁用，成功后才打开『空城计？』。失败显示 Toast『引用检查失败，请重试后再删除』，用户从原入口重试。引用结果与确认规则见[删除前的引用确认](../3_references/AGENT-DESIGN.md#删除前的引用确认)。

## 复制和插入 Markdown

- 附件菜单的『复制 Markdown』与拖进编辑器共用[引用生成](../../../../app/features/content/attachments/drag.ts)。普通文件生成链接，图片生成图片引用。编辑区支持复制单项或选区，详情页可以复制单项。
- 只选文件时直接复制或插入。只要选区含文件夹，就问一次展开方式。『仅文件夹』生成文件夹卡片，『展开直属文件』和『展开直属图片』都不递归。选区里单独选中的文件不受展开方式影响。复制时静默跳过没有符合条件直属项的文件夹，其他可生成的引用照常处理。拖入时仍提示这些文件夹。
- 展开和去重后至少有两项时，复制 Markdown 默认生成一组 `<carousel>`，每个内容行前加两个空格。拖入时跟踪原落点，等选择完成再插入同样格式的轮播块。落点在既有轮播内时只插入引用，不套一层标签。正文单条引用沿用原插入规则，插入点前已有空格或制表符时直接插入，`cover: ` 也按此处理。
- 有生成结果且剪贴板写入成功后，只提示『已复制 Markdown』。没有生成结果时不写剪贴板，也不提示。实际写入失败时仍提示『无法复制 Markdown』。

## 提交与回执

- 每条附件命令在 `workspace_transaction` 里执行：先锁档案行（`SELECT … FOR UPDATE`），同一篇档案的命令因此串行；上传字节不经过这里，长时间上传从不持锁；
- 每条命令带 `request_id`，按 `(操作人, request_id)` 存回执，内容指纹不同或回执过期时返回 409。成功后返回最新的附件目录，前端直接采用；
- 前端遇到结果未知的失败（不是 `BATCH_REJECTED`、`PRIVACY_CONFIRMATION`），保留原命令和原 `request_id`，只让用户重试这一条，避免已提交的操作被换个 `request_id` 再执行一次（`app/features/content/attachments/panel.ts`）。
- 回执未确认时，附件命令显示『附件操作结果待确认』，上传受理显示『上传受理结果待确认』。失败的上传会话菜单用『重试』，主动暂停的会话用『继续』。上传重试沿用原受理请求或原上传会话。

## 上传协议

上传会话在 `content_transfer_sessions`，每次尝试在 `content_transfer_attempts`（入口 `upload-api.service.ts`，状态机在 `upload-session.service.ts`）：

1. 受理：整批通过冲突检查后，每项建一个 `queued` 会话，占住目标路径；同一路径上已过期的旧会话先作废；
2. 初始化：认领会话（`running`），先建尝试和对象键 `content/att/staging/<会话>/<尝试>`，再向 OSS 发起分片上传，记下 UploadId 后进入 `uploading`。初始化回包丢了，再初始化会换新尝试和新键，旧的留给清理；
3. 传分片：浏览器每片先报 MD5 申请签名（`sign`），服务端登记“第几片、多大、MD5”，同一片之后不能改内容；浏览器用签名 URL 直接 PUT 到 OSS，分片大小 `partSizeMb`（8 MiB）；
4. 续传和对账（`resume`）：用 ListParts 读 OSS 上已有的分片，逐片和登记的大小、MD5 核对，不符就拒绝；ListParts 期间会话若被别人完成、取消或换了尝试，结果作废；
5. 封口（`seal`）：分片必须连续、齐全、大小与计划一致。OSS 上还没有对象就合并分片，合并回执的 ETag、版本号须与 HEAD 一致；然后核对大小、版本号和 ACL 为私有。要做图片处理或删减版时，只读文件头 12 字节核对实际格式。核对通过后记下结果，会话进入 `verifying`，对外显示为 `ready`；
6. 采用（`adopt`）：在一个事务里把对象发布成附件行（新建或替换），会话变为 `completed` 并存下发布回执；重复采用返回同一回执。普通文件由浏览器调用 `adopt_upload_session`，返回当前的附件目录和新附件的 `attachment_id`；要做图片处理的，由 `images` 扫描处理完后采用（`upload-image.service.ts`），浏览器之后查询会话时拿到同样的结果。

- 对象身份只认 ETag、OSS 版本号、大小和 ACL，不把 ETag 当摘要，也不另算字节摘要，所以结果里的 `sha256` 恒为 `null`；
- 会话列表只列本人的会话（`actor_id`）；占用路径的预约对同一档案的所有人可见；
- 暂停只停浏览器的传输，不撤销会话；会话 24 小时后过期，由上传收尾清理，见 `SID#2.4.7`；
- 附件区和全屏侧栏共用上传控制器。『上传』与『上传文件夹』通过原生文件输入框选择，选好后即可上传，即使正文还在重新取得草稿编辑权。在系统窗口取消选择会直接返回编辑页。若窗口打不开，或选择结束却没有交回文件，『未能添加附件』弹窗说明原因；点『重新选择』可重新打开相应的选择窗口，保留原目标目录。列表“+”菜单和文件夹右键菜单共用 `attachment_add_menu_items()`：上传准备中禁用两种上传，仍允许新建文件夹；“+”按钮本身在准备中禁用
- 普通选择的文件在页面刷新后需要点『继续』重选原文件，上传会复用已确认的分片。若拖入文件时浏览器提供了文件句柄，客户端会按账号、档案和会话把句柄保存在 IndexedDB（`app.content.upload.handleStorageName`），刷新后有读权限时可直接取回文件。句柄失效或没有读取权限时同样需要重选。重选文件与已登记的分片对不上时，服务端拒绝续传。
- 读取图片头失败时，本批不会受理，列表指出出错的文件，可直接重新选择。受理后校验旧分片或读取新分片时失去读取权限，则停止本次传输、丢弃失效的本地文件和句柄，保留服务器会话与已确认分片。对失败行点『重试』可重新选择原文件。
- 准备行优先显示该文件的准备错误，其次显示整批受理失败的原因。行内文字和悬停提示使用同一条消息，缺少原因时只显示失败状态；
- 前端（`app/features/content/uploads/runtime.ts`）在会话 `completed` 后先采用返回的附件目录，再把最终附件交给发起上传的一方。上传行按该文件的状态显示『正在核对已上传分片』、『服务器处理中』或『校验完成，等待发布』等进度。编辑器粘贴或拖入时的 Markdown 插入规则见[草稿编辑器状态](../1_drafts/AGENT-DESIGN.md#编辑器状态)。

## 上传限额

| 项 | 值 |
| --- | --- |
| 每批 items | 500 |
| 每批总大小 | 20 GiB |
| 并行上传 | 3 |
| 上传会话过期 | 24 h |

## 冲突 resolve

| 类别 | 可选 |
| --- | --- |
| `name_conflict`、`reserved` | 只重试 / 跳过 / 自动编号 |
| `invalid_name` | 只重试 / 跳过 / 清洗 |
| `redacted` | 旧删减版机制专用，LAW 已删去，待第二步移除（见 `5_images` 的 AGENT） |
| `source_busy`、`other` | 只重试 / 跳过 |

- 有冲突则整批不处理，抛 `BATCH_REJECTED`；
- 目录之间重名不算冲突，只有文件类 item 与已有文件或目录重名（或与预约的上传目标重名）才报 `name_conflict`。目录撞上同名文件仍报冲突；
- 上传文件夹时，目标位置已有同名目录则合并：文件直接进入已有目录（`ensure_workspace_folders` 按父目录和 `name_key` 复用目录行）；
- 改名、移动和设为机密等隐式改名把目录移到已有同名目录的位置时合并：源目录的子项逐个按普通 item 规划，重名的子项与普通条目一样提供「只重试 / 跳过 / 自动编号」，选编号时只改这一个子项（如 `docs/a.txt` → `docs/a_1.txt`），不动其他子项；重名的子目录递归合并；用户的「跳过」决定让子项留在原目录，源目录在子项全部移走后才删除。被合并掉的目录行消失时，正文里指向它的文件夹引用和文件引用都由 `finish_namespace_change` 的 `folder_moves` 跟随到合并后的目录，不变成删除提示；
- 新建文件夹不合并：目标位置已有同名目录或同名文件时确定按钮禁用，服务端仍以 `name_conflict` 兜底；
- 文件夹撞上同名文件（任一操作方向）仍然报 `name_conflict`；
- 上传受理和附件命令按当前批次中的条目累计处理决定。清洗后如果又重名，只询问重名处理方式；同组另一项已经选过的自动编号不应用于刚暴露的冲突。上传文件按原始选择序号匹配，文件夹根单独匹配；附件命令按节点 ID 匹配，新建文件夹只有一个目标；
- 每个类别选一种处理方式；`other`、`invalid_name` 再按原因文字分组；整批只有一项时去掉「跳过」；
- 冲突处理和附件状态变更确认弹窗打开时，附件树默认展开到每一层。冲突处理也默认展开各分组，处理方式下拉框使用 PrimeVue 的 `size="small"`。用户可手动折叠，收到新一轮结果时恢复默认展开。每组只列本轮冲突项及其祖先目录，按回执的预计目标路径展示；已采纳的清洗、编号决定参与下一轮计算。`valid_count` 仅用于判断整批是否只有一项，从而去掉「跳过」；
- 文件夹上传：每个出问题的文件单独报出，`group` 为文件夹根路径；文件夹内所有问题都选跳过时，整个文件夹跳过。成员文件与独立文件上传、附件命令里的条目一样，重名时可选自动编号，编号只改这一个文件（如 `album/a.txt` → `album/a_1.txt`），文件夹结构与其余成员的相对路径不变；
- 不变量：文件夹与文件夹重名只合并、不因重名给文件夹编号；文件重名一律按冲突处理并可选编号（独立文件上传、文件夹成员、合并中的子项都是如此）；新建文件夹不合并，「名称非法」等其它类别没有编号选项；
- 底部按钮为「提交」。
