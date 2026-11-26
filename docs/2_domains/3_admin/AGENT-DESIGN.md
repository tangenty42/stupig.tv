# AGENT-DESIGN：管理控制台的实现

- 本文档状态：DONE（验收用例见文末，实际运行结果见同目录 AGENT）
- 覆盖范围：控制台的用户与运行状态两个视图、用户筛选和管理操作、后台任务、存储审计及验收标准
- 上位依据：[SID#2.3.LAW](LAW.md)、[SID#2.1.LAW](../1_accounts/LAW.md)、[SID#0.1.LAW](../../0_overall/1_architecture/LAW.md)、[SID#0.1.DESIGN](../../0_overall/1_architecture/DESIGN.md)
- 核对基线、裁定与偏差：[SID#2.3.AGENT](AGENT.md)

LAW 用大白话讲人能看到和做到的事。本文约束具体实现：LAW 没写的规则、数值和边界都以这里为准，改动它们要先经人类同意。账号、会话、权限本身怎么实现见 [SID#2.1.AGENT-DESIGN](../1_accounts/AGENT-DESIGN.md)。本板块负责控制台的查看和管理操作。后台任务怎么跑、存储审计怎么查属于运行与维护设施，这里只写它们的状态在控制台里怎么展示。

## 入口

| 位置 | 内容 |
| --- | --- |
| [admin/index.vue](../../../app/pages/admin/index.vue) | 控制台页面与视图切换。在已打开的页面失去控制台读权时移除内容并返回首页 |
| [UsersView.vue](../../../app/components/MyAdmin/UsersView.vue) | 用户视图：命令栏、用户列表、各弹窗 |
| [CmdBar.vue](../../../app/components/MyAdmin/CmdBar.vue) | 命令栏：输入筛选条件或命令 |
| [UserCard.vue](../../../app/components/MyAdmin/UserCard.vue) | 用户卡片 |
| [RunView.vue](../../../app/components/MyAdmin/RunView.vue)、[RunIssues.vue](../../../app/components/MyAdmin/RunIssues.vue) | 运行状态和『TODO』区的异常 |
| [RunDetails.vue](../../../app/components/MyAdmin/RunDetails.vue)、[RunTaskDetails.vue](../../../app/components/MyAdmin/RunTaskDetails.vue)、[RunTimingDetails.vue](../../../app/components/MyAdmin/RunTimingDetails.vue) | 展示任务待办及当前状况、存储审计、应答进程及各环节最近用时 |
| [StorageFindings.vue](../../../app/components/MyAdmin/StorageFindings.vue) | 有『控制台·只读』权限即可按需查看当前存储桶的对象级异常 |
| [features/admin/users.ts](../../../app/features/admin/users.ts) | `useAdminUsers()` 负责列表查询和各项操作 |
| [admin-command.ts](../../../server/shared/admin-command.ts) | 命令栏和元数据接口共用的命令、SQL 关键字 |
| [features/admin/status.ts](../../../app/features/admin/status.ts) | `useAdminBackgroundStatus()` 取后台状态；任务的名字和顺序、合计、归类、用时和相对时间的写法 |
| [features/admin/storage-audit.ts](../../../app/features/admin/storage-audit.ts) | `useAdminStorageFindings()` 取异常明细并翻页；各种异常的名字、颜色和处置提示 |
| [require-admin-auth.ts](../../../app/middleware/require-admin-auth.ts) | 没有『控制台·只读』以上权限时跳回首页 |
| [MyProfileHoverCard.vue](../../../app/components/MyProfileHoverCard.vue) | 顶栏用户菜单里的『控制台』链接，有『控制台·只读』以上权限才显示 |
| [admin 路由](../../../server/trpc/routers/admin.ts) | 接口 |
| [admin.service.ts](../../../server/services/admin.service.ts) | 列表查询和各项操作 |
| [admin-filter.ts](../../../server/services/admin-filter.ts) | 把筛选条件编译成受限的 SQL 片段 |
| [status.service.ts](../../../server/services/background/status.service.ts) | 汇总后台状态 |
| [storage-audit/service.ts](../../../server/services/storage-audit/service.ts) | `get_storage_audit_findings()` 读异常明细 |

路由中间件只管界面跳转，接口各自校验权限。页面带 `noindex`，robots 和 sitemap 配置也排除了 `/admin`。

## 数据

本板块没有自己的表。用户视图读写账号板块的 `users` 和 `user_login_sessions`，表结构见 [SID#2.1.AGENT-DESIGN](../1_accounts/AGENT-DESIGN.md#数据库结构)。运行状态视图读取运行与维护设施的账本和审计表。

| 操作 | 写什么 |
| --- | --- |
| 封禁、解封 | `users.is_banned`；封禁时还把该用户的全部会话标为已退出 |
| 强制下线 | 把该用户的全部会话标为已退出 |
| 认证 | `users.is_verified`、`users.verified_note` |
| 管理员身份 | `users.is_admin`；设为管理员时把 `users.permissions` 置空 |
| 权限 | `users.permissions`，整份替换 |

## 接口

| 接口 | 访问要求 | 说明 |
| --- | --- | --- |
| `admin.listUsers` | 『控制台·只读』 | 分页的用户列表，接受筛选条件 |
| `admin.getKeywords` | 『控制台·只读』 | 命令栏的补全建议：可筛选的字段、关键字、命令 |
| `admin.setBanned` | 管理员 | 封禁或解封 |
| `admin.forceLogout` | 管理员 | 强制下线 |
| `admin.setVerification` | 管理员 | 授予、修改或移除认证 |
| `admin.setRole` | 管理员 | 设为或撤销管理员 |
| `admin.setPermissions` | 管理员 | 替换权限列表 |
| `admin.getSelf` | 『控制台·只读』 | 返回调用者的 UID、用户名、是否管理员。页面没有用到 |
| `admin.getBackgroundStatus` | 『控制台·只读』 | 运行状态，包括后台任务、存储审计进度和全部桶的异常计数 |
| `admin.getStorageAuditFindings` | 『控制台·只读』 | 当前配置存储桶未关闭的异常明细，可按种类筛选后分页 |

表里的“管理员”指接口要求『控制台·完全』。这一级不能授予普通账号，所以实际只有管理员能通过，见 [权限判定](../1_accounts/AGENT-DESIGN.md#权限判定)。

替别人改资料、改密码、换手机号走的是 `profile` 路由，属于账号板块。控制台只提供去对方主页的链接。

## 视图切换

页面顶部保留『用户』和『运行状态』两个入口。选中的视图写在地址的 `view` 参数里，刷新和转发链接都留在原视图。

| 视图 | 地址 | 内容 |
| --- | --- | --- |
| 用户 | `/admin` | 命令栏和用户列表 |
| 运行状态 | `/admin?view=status` | 直接查看任务、待办、进程和存储审计，按需要读取对象级异常 |

- 原来的 `?view=tasks` 打开运行状态，`?view=storage` 滚动并聚焦「存储审计」标题。两种地址都不会自动读取对象级异常。
- 其他 `view` 值和没有 `view` 时均显示用户视图。切到用户视图时去掉这个参数，保留其他查询参数。
- 同一时刻只挂载一个视图。离开某个视图，它的轮询就停了；切回用户视图时，筛选条件和已选的用户从头开始。
- 用户列表沿用服务端首屏的名单和接收时间。运行状态只在浏览器取数，水合时先显示与服务端一致的骨架。页内切换由 `<Suspense suspensible>` 等待新视图首份数据，旧视图在此期间保持可见。超过 150ms 仍未就绪时淡到 60% 并标 `aria-busy`。切换按钮立即反映选择，一级标题和轮询周期跟随实际显示的视图。
- 两个视图沿用控制台的页面背景和边距，共用同一份页头。左侧显示一级标题『用户管理』或『运行状态』，右侧切换视图。标题下面依次显示轮询周期和『（时长）更新』，如『刚刚 更新』『1 天 2 小时前 更新』。首次取数前显示『—』，请求失败时保留上次成功的时间。

『控制台·只读』可查看两个视图，包括当前配置存储桶的对象级异常明细。管理用户需要『控制台·完全』。

## 用户列表

『命令』卡片提供筛选和命令输入。『用户列表』标题下的同一张卡片收拢当前筛选条件、刷新、选择与批量操作、分页和空结果提示。各个用户的资料卡在同一区块接在控件卡下面，窄屏一列、宽屏两列。筛选或翻页引起结果数量变化时，结果区也做高度过渡。

当前筛选条件使用描边 `MyBadge`，筛选生效时显示黄色和清除按钮。用户卡片在选中或取消选中时过渡边框颜色。

取消选择只保留用户列表顶部的入口，清空选择时保留命令输入。命令补全直接读取共享的命令、字段与 SQL 关键字定义，不依赖额外请求。用户名认证勾、补全候选、视图选项和指标名称的图标与文字使用同一行内基线。

`list_users()` 先数总数，再取当前页。每一行经账号板块的 `format_profile_row()` 裁剪，所以谁能看到手机号和主页上的规则一致：能进控制台的人都看得到。

没有筛选条件时按 UID 倒序。指定了排序时，末尾仍补上 UID 倒序，保证翻页稳定。

页码和每页条数只要求是正整数，服务端没有设每页条数的上限。

### 筛选条件

有控制台权限的人都可以在输入框写 SQL 的 `WHERE` 条件，可以带 `ORDER BY`。条件要过两道检查：

1. 浏览器里先用 SQL 解析器看语法对不对，并拒绝分号和注释符号。这一道只是为了及时提示。
2. 服务端的 `compile_admin_filter()` 把条件解析成语法树，只认下面列出的节点，再重新拼出 SQL。条件里的每个值都变成绑定参数，原文不会进入 SQL。

服务端认的写法：

| 类别 | 内容 |
| --- | --- |
| 字段 | `id`、`username`、`phone`、`is_verified`、`is_admin`、`is_banned`、`created_at`，可写成 `users.字段` 或 `u.字段` |
| 值 | 数字、字符串、`TRUE`、`FALSE`、`NULL` |
| 比较 | `=`、`!=`、`<>`、`<`、`<=`、`>`、`>=`、`LIKE`、`NOT LIKE`、`IS`、`IS NOT` |
| 组合 | `AND`、`OR`、`NOT`、括号 |
| 范围 | `IN`、`NOT IN`（最多 100 个值）、`BETWEEN`、`NOT BETWEEN` |
| 排序 | `ORDER BY` 后跟字段，可加 `ASC` 或 `DESC`，可多个 |

其余一律在访问数据库之前拒绝，返回 400：别的字段（包括密码和令牌的哈希）、子查询、函数调用、`UNION`、多条语句、`LIMIT`、`GROUP BY`、锁、输出到文件、变量、占位符等。条件最长 4096 个字符，语法树最多 256 个节点、32 层。

字段清单在 [user.ts](../../../server/shared/types/user.ts) 的 `ADMIN_FILTER_FIELDS`。`admin_filter_fields()` 按调用者的权限再过一遍，没有『控制台』权限的调用者拿不到 `phone`。目前所有调用者都有权限，这一层是防御。

## 命令栏

在输入框按回车或点执行按钮时，按内容分三种情况：

| 输入 | 结果 |
| --- | --- |
| 空 | 清空当前筛选条件 |
| 一个命令词 | 对已选中的用户执行该命令 |
| 其他 | 当作筛选条件 |

命令词不分大小写：

| 命令 | 作用 |
| --- | --- |
| `ALL` | 全选或取消全选本页 |
| `BAN`、`UNBAN` | 封禁、解封 |
| `KICK` | 强制下线 |
| `VERIFY`、`UNVERIFY` | 授予认证（会弹出填写说明的窗口）、移除认证 |
| `PROMOTE`、`DEMOTE` | 设为管理员、撤销管理员 |

除 `ALL` 外，管理员没有选中用户时提交命令，会看到『请先点选要操作的用户卡片』。

输入时有补全建议，按最后一个词的前缀匹配字段、关键字和命令。命令栏直接使用共享的字段、SQL 关键字和命令定义，无需等网络请求。`admin.getKeywords` 保留只读控制台权限校验，并使用同一份定义。

只读者看到筛选示例，补全只提供字段和关键字。手动输入管理命令会提示只有管理员能使用，并保留输入供修改。

## 管理操作

管理员可从用户卡片、列表上方的批量按钮或命令栏发起操作，三处共用同一套逻辑。后两处作用于已选中的用户。只读者使用同一个输入框筛选用户。

| 操作 | 服务端做什么 | 限制 |
| --- | --- | --- |
| 封禁 | 置封禁标记，让对方全部设备下线 | 不能封禁自己 |
| 解封 | 清封禁标记 | |
| 强制下线 | 让对方全部设备下线 | 可以对自己用 |
| 授予、修改认证 | 置认证标记，写入去除首尾空白的说明 | 说明必填，最多 255 个字符 |
| 移除认证 | 清认证标记和说明 | |
| 设为管理员 | 置管理员标记，清空权限列表 | 目标不存在时报『用户不存在』 |
| 撤销管理员 | 清管理员标记 | 不能撤销自己 |
| 修改权限 | 整份替换权限列表 | 目标是管理员时拒绝；不可授予的级别被拒绝 |

每项操作成功后都发通知，让对方已打开的页面跟着变：

| 操作 | 发布的资源键 |
| --- | --- |
| 封禁 | `profile_sessions`、`profile`、`auth_user` |
| 强制下线 | `auth_user`、`profile_sessions` |
| 其余 | `profile`、`auth_user` |

对方页面怎么响应这些通知见 [SID#2.1.AGENT-DESIGN 的『通知与轮询』](../1_accounts/AGENT-DESIGN.md#通知与轮询)。

对多个用户执行时，页面按选中的先后一个一个地请求。中途有一个失败就停下，前面的已经生效，后面的不再执行，页面提示错误并重新加载列表。全部成功后清空选择。

## 后台状态的数据

运行状态通过 `admin.getBackgroundStatus` 一次取得下列数据。

| 部分 | 内容 | 来自 |
| --- | --- | --- |
| `mode` | 后台任务怎么跑：`app`（跟着应用）、`worker`（独立进程）、`disabled`（停用） | 配置 |
| `process` | 应答这次请求的进程里，执行器的情况：各类名额的容量和占用，各任务的阶段、运行次数、失败次数、上次错误码、上次用时、上次开始和结束时间。`worker` 和 `disabled` 时是 `null` | 进程内存，重启清零 |
| `blocked` | 对象退役和边缘预热遇到的配置阻塞原因 | 当前运行配置 |
| `database.ledgers` | 七个任务各自的扫描周期 `interval_seconds`，以及数据库里的待办：按“阶段 + 错误码”分组，每组有总数、待办数、到期数、处理中数、最早待办时间 | 配置、数据库 |
| `database.storage_audit` | 每个存储桶的检查进度 | 数据库 |
| `database.storage_audit_findings` | 未关闭的异常，按种类计数 | 数据库 |
| `database.preload_targets` | 按最近错误码分组的预热站点数，以及各组中租约仍有效的站点数 | 数据库 |
| `observations` | 上传和图片处理各环节的用时统计 | 进程内存，重启清零 |
| `resources` | 进程已运行时间、内存、CPU 时间 | 进程 |

状态展示遵循以下范围：

- 状态只有固定字段，不带载荷、密钥、签名 URL、云端报错原文（[SID#0.1.DESIGN](../../0_overall/1_architecture/DESIGN.md) 的规定）。页面从这份快照整理概况、简短状态和供 Agent 使用的排查说明。
- `process`、`observations`、`resources` 说的是应答请求的那一个进程。多实例或独立 worker 时它不是全貌，界面上写明了这一点。
- 运行状态只供查看与复制排查说明。修复步骤见[维护补充](../../1_workflows/4_maintain/AGENT-DESIGN.md#后台任务与日常存储审计)。

`interval_seconds` 取自各任务的 `sweepIntervalSeconds` 配置。状态接口与执行器注册任务都使用 `content_background_intervals()` 给出的值。

## 后台任务视图

『后台任务』已并入『运行状态』。页头下并排显示任务阻塞、任务出错和未关闭存储异常三项计数。读屏软件可通过『异常概况』二级标题定位。『TODO』里的异常卡用标题说明发生了什么，左边框按阻塞、出错和存储异常标色。存储异常行的『查看明细』打开当前桶中该类型的第一页。

- 有明确阻塞原因且仍有待办时才计为阻塞。出错证据可来自执行器的上次错误，或仍待办的任务、存储审计及预热站点记录。同一任务同时阻塞和出错时，两项指标各计一次，列表合并为一条。存储异常按严重程度排列。正常保护、限流和历史累计失败数不会单独触发告警。
- 没有本地执行器记录时，仍显示账本中能确认的出错任务，缺少出错证据时显示未知。存储审计还没有记录或有桶首轮尚未完成时，也不能由零条发现推断检查正常。
- 读取失败后标记更新中断并弹 Toast。同一段轮询中断只提示一次。下一份快照成功返回后，恢复显示当前异常数和异常列表。

『仪表盘』与『异常概况』『TODO』同为二级标题。后台任务、存储审计、当前进程和处理用时各自使用带三级标题的卡片，共用一份快照。宽度达到 768px 时，每张卡接在两列中较短的一列下面。轮询改变卡片高度时重新排布，键盘和读屏顺序保持稳定。更窄时单列按上述顺序排列。两种配色下，卡片标题和有待办的数值加重显示，摘要、表头、样本数以及空闲读数减弱显示。异常概况卡和仪表盘卡沿用全站卡片的圆角与阴影（与 `SectionCard`、用户卡一致），仪表盘卡的标题栏另加浅底色，栏内图标配在标题旁、无底衬。卡内的小节标题（如『后台并发名额』『已用 / 上限』）与表格列表头同为小号次要色，字重统一取 PrimeVue 的列标题 token `datatable.column.title.font.weight`（主题默认 600），不各自硬编码。

| 详情 | 可核对的内容 |
| --- | --- |
| 后台任务 | 每个任务一行，三格依次显示任务名称、待办数和一句运行情况。有待办的阻塞任务排在首位，随后是出错、运行或排队、有待办的任务，再列其他任务。已知任务显示中文名。 |
| 当前进程 | 应答请求的进程已运行多久、常驻内存和累计 CPU 用时。已运行和累计 CPU 用 `duration_format`，常驻内存用 `format_bytes`，显示文案都取自 [全站共用模块](../0_framework/AGENT-DESIGN.md#时间)。『后台并发名额』逐项显示本进程执行器报告的已用数和上限，包括已用数为零的项。 |
| 处理用时 | 三列分别为环节、中位耗时和『P95 耗时』，耗时统一按毫秒显示。环节名称下一行标明『最近 N 次』，缺少近期样本时用『—』显示。所有已经记录过或正在计时的环节都直接显示，依次优先列出图片处理、正在计时、有失败记录、分片上传合并、数据库取连接，再列其余环节。 |

后台并发名额在一次任务扫描开始时占用，扫描结束时释放。配置列有图片处理、对象存储、边缘服务、同步通知四类。图片处理的一次扫描同时占用一个图片处理名额和一个对象存储名额；存储审计只占用一个对象存储名额。容量从执行器快照读取。独立 worker 模式下，应答网页请求的进程没有执行器快照，页面只展示本进程的运行统计和运行模式。[名额配置](../../../config/shared.yaml)、[各任务占用的名额](../../../server/services/content/background.service.ts)、[执行器分配与释放](../../../server/services/background/runner.ts)

## 存储审计视图

「存储审计」按桶显示已核对的引用数和对象数，下方列出检查阶段、本轮开始及上次完成时间。时间使用 `useAdminRelativeTime()` 的相对时长，最多两个单位，不足一秒显示『刚刚』。异常计数汇总全部桶尚未关闭的记录，各类型以顿号分隔，随状态快照更新。进程卡列出运行时长、常驻内存和累计 CPU 时间，以及各资源当前的已用数和容量。

有『控制台·只读』权限即可在四张详情卡之后看到「异常明细」区。点击「读取异常明细」从第一页查询当前配置桶的全部异常。从『TODO』里的某类存储异常点击「查看明细」，焦点立即移到明细标题，并从第一页查询本桶该类记录。类型筛选使用可多选的徽章，选中时为实底，未选中时为描边。显示命中任一选中类型的异常，点击「清除」后显示全部类型。汇总包含其他桶的异常时，本桶对应的列表可以为空。旧存储链接只定位到存储审计。服务端每次读取明细都校验『控制台·只读』权限。

首次读取或刷新失败时统一弹出 `读取异常明细失败，请『刷新』重试`。刷新失败保留上次的明细和更新时间。读取被拒绝时清除已有明细及更新时间，并提示读取权限不足。

每条明细首行加重显示对象键，第二行用 `MyBadge` 显示异常种类、观察次数、首次与最近发现时间，以及换算后的大小。首次和最近发现时间用逗号分隔。类型徽章默认描边，对应类型被选作筛选条件时转为实底。其余信息用 `info` 描边。小于 1 KB 时用字节显示。

| 种类 | 名字 | 颜色 |
| --- | --- | --- |
| `missing_object` | 对象缺失 | 错误 |
| `size_mismatch` | 大小不符 | 错误 |
| `public_object` | 对象可公开读 | 错误 |
| `invalid_reference` | 引用无效 | 警告 |
| `retired_object_present` | 已退役对象仍在 | 警告 |
| `orphan_candidate` | 疑似无主对象 | 普通 |
| `unregistered_static` | 未登记的静态文件 | 普通 |
| `unmanaged_object` | 不归本站管的对象 | 普通 |

认不出的种类用原文当名字，没有处置提示。处置提示是 [维护补充](../../1_workflows/4_maintain/AGENT-DESIGN.md#后台任务与日常存储审计)那张表的一句话版本，文字在 `storage-audit.ts` 的 `storage_audit_kinds`；以维护补充为准，改那张表时一起改。

明细上方显示分页，沿用用户列表的页码和范围显示，每页可选 10、50、100、154800 条，默认 10 条。总数按当前桶中符合筛选的未关闭记录计算，按异常 ID 升序排列。切换类型或每页条数时回到第一页，当前页超出范围时回到末页。换页或换筛选时，等待读取期间保留结果区高度，收到结果后由外层卡片过渡到新高度。顶部标明『手动更新』和『（时长）更新』，『刷新』重读当前页。

## 通知与轮询

用户和运行状态各自轮询，页面不可见时不请求。运行状态里各张卡片共用同一份状态快照。

用户列表在查询成功时把结果与接收时间存进同一份快照，服务端渲染和浏览器接管读取同一个时间。运行状态在浏览器收到第一份快照时才显示成功更新时间。

| 数据 | 周期 | 说明 |
| --- | --- | --- |
| 用户列表 | 2 秒 | 列表里有在线状态、最近在线这类随时间变化、没有对应写入事件的内容 |
| 后台状态 | 5 秒 | 一次请求是十条聚合查询，比用户列表重；最短的任务周期是 1 秒，5 秒足够看出变化 |
| 异常明细 | 不轮询 | 手动刷新 |

用户列表的查询不与别处共享（`share: false`），查询键由页码、每页条数和筛选条件组成。连续操作时只采用最后发起的那次请求的结果（`refresh_policy: 'latest'`）。

后台状态和异常明细只在浏览器里请求（`server: false`），服务端首屏显示待读取状态。两种查询都不共享，异常明细的查询键包含页码、每页条数和所选类型。

## 前端结构

| 部分 | 职责 |
| --- | --- |
| `useAdminUsers(query, on_data)` | 列表查询；`refresh()` 在查询条件变了时换查询、没变时刷新；`run(command, id, note)` 把命令映射到对应的一个接口；`set_permissions()` |
| 页面 | 共用页头显示当前标题、切换按钮、轮询周期及视图传来的成功更新时间；把选中的视图写进地址 |
| `MyAdminUsersView` | 筛选条件、分页、选择、各弹窗的状态；发起操作并在结束后重新加载 |
| `MyAdminCmdBar` | 输入、补全、浏览器侧的语法检查；发出“执行筛选”或“执行命令” |
| `MyAdminUserCard` | 展示一个用户；点卡片切换选中；按钮发出事件，由用户视图处理 |
| `useAdminBackgroundStatus()` | 在运行状态视图取数并轮询，给概览、任务和存储审计传同一份快照 |
| `task_cards()`、`task_backlog()` | 整理任务台账，供仪表盘使用；环节耗时用 `milliseconds_format()`、进程时长用 `duration_format()`，都来自 [time.ts](../../../app/utils/time.ts) |
| `useAdminRelativeTime()` | 按站内共用的时钟和时区写“…前”“…后” |
| `useAdminStorageFindings()` | 按页码、每页条数和所选类型读取异常明细；支持手动刷新 |
| `MyAdminRunIssues`、[issues.ts](../../../app/features/admin/issues.ts) | 归集有证据的问题，生成可复制的排查说明 |
| `MyAdminRunDetails`、`MyAdminStorageFindings` | 展示仪表盘与存储审计。明细区常驻，点击读取时才挂载明细组件并开始查询 |
| [SectionCard.vue](../../../app/components/MyAdmin/SectionCard.vue)、[RunDetailCard.vue](../../../app/components/MyAdmin/RunDetailCard.vue) | 前者供用户页及异常明细区使用，后者将仪表盘中各项的图标、三级标题、摘要和数据放进同一张卡片。卡片内容及关注列表用 [MyHeightTransition](../../../app/components/MyHeightTransition.vue) 响应高度变化 |

页码和每页条数一起变时只发一次请求：用户视图先改这两个值，再调 `refresh()`，由它把三个查询条件一次性换掉。

后台任务和各环节用时用 PrimeVue DataTable 展示。手机保留三列可见表头，任务或环节名称与两个读数在同一行。

## 配置

| 配置 | 当前值 | 作用 |
| --- | --- | --- |
| `app.admin.pollIntervalSeconds` | 2 | 用户列表的轮询周期 |
| `app.admin.statusPollIntervalSeconds` | 5 | 运行状态的轮询周期 |
| `app.online.timeoutSeconds` | 16 | 判定在线的时限，列表和主页共用 |

都在 [app-settings.yaml](../../../config/app-settings.yaml)。早期后台轮询曾是 `status.ts` 的硬编码常量，以避免改动已冻结 WebP 迁移的配置闭包；旧迁移删除后已改为公开配置，历史经过见 [SID#2.3.AGENT 的『传统与工作经验』](AGENT.md#传统与工作经验)。

## 向其他板块提供的能力

没有。本板块只使用账号板块的能力。

## LAW 没写的细节

筛选条件、命令栏和多选批量操作由本文约束。地址、数据范围和更新方式见[视图切换](#视图切换)、[后台任务视图](#后台任务视图)、[存储审计视图](#存储审计视图)和[通知与轮询](#通知与轮询)。

### 进入

- 入口在顶栏用户菜单里，文字是『控制台』。
- 没有权限的人直接打开 `/admin` 会被送回首页，不显示提示。

### 用户列表

- 每张卡片显示：头像和在线状态、用户名、认证图标、手机号、UID、标记（认证、管理员、已封禁）、各项权限、注册于、最近登录、最近在线。
- 每页条数可选 10、50、100、154800，默认 10。
- 列表上方显示已生效的筛选条件，默认为『全部用户，按 UID 倒序』。『清空输入框』只清理正在输入的内容，『清除筛选条件』恢复默认列表。
- 没有匹配的用户时显示『没有匹配的用户』。
- 有『刷新』按钮；不点也会每 2 秒自动更新。
- 改变页码、每页条数或筛选条件时立即清除旧名单、选择和管理弹窗。刷新相同查询时，成功后只保留仍在当前页的选择。若只收回管理权限，关闭管理弹窗并清空选择，保留只读列表。

### 操作

- 封禁、解封、强制下线、设为管理员、撤销管理员点了就执行，没有二次确认。人类已确认不要加。
- 授予和修改认证都要求填写说明。页面和服务端均校验去除首尾空白后的内容。对多个用户一起授予时，他们得到同一段说明。
- 对已认证的单个用户点『修改认证』时，弹窗里带着原来的说明，并多一个『移除认证』按钮。
- 批量认证弹窗用『为小明等，共 3 名用户』概括目标，首个用户名用描边 `MyBadge`。单用户认证显示 `用户『小明』`。
- 未选中用户时批量按钮不可点。选中后『取消选择』按钮显示人数，点击清空选择。
- 修改权限的弹窗一次只针对一个用户，每项权限在『未授予』和各个可授予的级别之间选。管理员卡片的『修改权限』不可点。
- 自己卡片上的『封禁』和『撤销管理员身份』不可点。
- 卡片上的『编辑资料』在新标签页打开对方的主页。
- 修改权限弹窗、权限保存成功提示和管理命令成功提示里的用户名使用描边 `MyBadge`。批量命令成功时只显示首个用户名和总人数，如『封禁：小明等，共 3 名用户』。
- 批量命令逐个请求。服务端在写入前明确拒绝某个目标时，以 `ADMIN_TARGET_REJECTED` 标记该错误，前端继续处理下一项。权限失效、结果未知、换账号或原界面及目标失效时停止发送后续请求。完成后按公开错误原因合并失败，Toast 每组显示首个目标的描边 `MyBadge` 和原因。多人组加总人数，例如『小明等 67 个用户：用户不存在』。单条命令的提示沿用原错误。

### 只读者

- 看得到列表、手机号、筛选条件和命令栏，能筛选和翻页。
- 看不到卡片下方的按钮、列表上方的快捷按钮和『全选本页』。
- 点卡片仍能选中，但选中了也没有可执行的操作。

## 验收标准

LAW 只用大白话讲行为，可检验的标准放在这里。改动本板块时，下面每一条都应继续成立；最后一列是目前锁定它的测试，写“无”的还没有测试。

| # | 标准 | 现有测试 |
| --- | --- | --- |
| 1 | 访客和普通用户打开 `/admin` 被送回首页，直接调控制台接口分别得到 401、403 | `tests/e2e/pages-restricted.spec.ts` |
| 2 | 得到『控制台·只读』后顶栏菜单出现『控制台』。失去最后一级控制台权限后，已打开的控制台清除名单并返回首页 | `tests/e2e/account-sync.spec.ts`、`app/pages/admin/index.nuxt.test.ts` |
| 3 | 管理员能打开控制台页面 | `tests/e2e/pages-render.spec.ts` |
| 4 | 『控制台·只读』能看列表和手机号、能按手机号筛选；封禁、设管理员、改权限被拒绝 | `server/trpc/routers/admin.test.ts` |
| 5 | 筛选条件只接受允许的字段和写法，值都作为参数绑定；其余写法在访问数据库前被拒绝 | `server/services/admin-filter.test.ts`、`server/trpc/routers/admin.test.ts` |
| 6 | 默认按 UID 倒序；指定排序时末尾补 UID 倒序 | `server/services/admin-filter.test.ts`、`server/trpc/routers/admin.test.ts` |
| 7 | 页码和每页条数一起变时只换一次查询；条件没变时是刷新 | `app/features/admin/users.test.ts` |
| 8 | 每个命令只调用它对应的那一个接口 | `app/features/admin/users.test.ts` |
| 9 | 补全建议请求失败时退回内置命令清单 | `app/features/admin/users.test.ts` |
| 10 | 不能封禁自己；『控制台·完全』不能授予 | `server/trpc/routers/admin.test.ts` |
| 11 | 强制下线后对方已打开的页面回到未登录状态；改权限后对方页面的入口随之变化 | `tests/e2e/account-sync.spec.ts` |
| 12 | 封禁后对方全部设备下线且不能登录，解封后可以登录 | `tests/e2e/account-sync.spec.ts`，服务与登录守卫见[账号验收第 19 条](../1_accounts/AGENT-DESIGN.md#验收标准) |
| 13 | 不能撤销自己的管理员；设为管理员时权限列表被清空；不能给管理员改权限 | `server/services/admin.service.test.ts` |
| 14 | 授予和修改认证须填说明，修改时带出原说明，移除后认证标记和说明都消失 | `server/trpc/routers/admin.test.ts`、`tests/e2e/admin-views.spec.ts` |
| 15 | 选中多个用户后逐个执行，明确拒绝单项时继续并按原因汇总，权限或结果不明时停止 | `app/components/MyAdmin/UsersView.nuxt.test.ts` |
| 16 | 只读者可筛选用户，手输管理命令会看到权限提示，卡片和列表均无管理操作按钮 | `app/components/MyAdmin/UsersView.nuxt.test.ts` |
| 17 | 列表在页面可见时每 2 秒自动更新，隐藏时暂停，恢复可见后继续 | `tests/e2e/admin-views.spec.ts` |
| 18 | 地址里的 `view` 决定挂载哪一个视图，别的值回到用户视图；切换时写回地址并保留其他参数 | `app/pages/admin/index.nuxt.test.ts`、`tests/e2e/admin-views.spec.ts` |
| 19 | 后台状态只在浏览器里请求、不共享，每 5 秒轮询 | `app/features/admin/status.test.ts` |
| 20 | 任务表优先显示有待办的阻塞任务，同级沿用任务顺序；待办数由各分组相加，清单外的任务保留 | `app/features/admin/status.test.ts`、`app/components/MyAdmin/RunDetails.nuxt.test.ts`、`tests/e2e/admin-views.spec.ts` |
| 21 | 应答进程没有执行器记录时，数据库待办仍可查看；从旧存储地址可滚动并聚焦「存储审计」三级标题 | `app/components/MyAdmin/RunDetails.nuxt.test.ts`、`app/components/MyAdmin/RunView.nuxt.test.ts`、`tests/e2e/admin-views.spec.ts` |
| 22 | 任务表按名称、待办、运行情况显示。进程资源条包含本机执行器上报的空闲及已占名额 | `app/components/MyAdmin/RunDetails.nuxt.test.ts`、`tests/e2e/admin-views.spec.ts` |
| 23 | 已记录或正在计时的环节全部直接可见；零耗时和缺少样本分别展示，手机保留可见三列表头。增加环节和存储桶后，桌面详情卡按新高度紧接较短列，手机保持源码顺序 | `app/features/admin/status.test.ts`、`app/components/MyAdmin/RunDetails.nuxt.test.ts`、`tests/e2e/admin-views.spec.ts` |
| 24 | 状态里每个任务带扫描周期，没有对应配置时为空；状态不含载荷和原始错误 | `server/services/background/status.service.test.ts` |
| 25 | 只读者可看审计进度与异常计数，主动读取时才查询当前配置桶的对象明细。未登录者和没有控制台权限的用户请求明细分别得到 401、403 | `app/components/MyAdmin/RunView.nuxt.test.ts`、`server/trpc/router.test.ts`、`tests/e2e/admin-views.spec.ts` |
| 26 | 每条明细展示对象键、异常种类、发现次数和时间及换算后的大小。未知种类显示原文 | `app/components/MyAdmin/RunView.nuxt.test.ts`、`app/features/admin/storage-audit.test.ts` |
| 27 | 明细类型可多选，筛选后重新计算页数；切换类型或每页条数回到第一页；明细不轮询 | `app/features/admin/storage-audit.test.ts`、`app/components/MyAdmin/RunView.nuxt.test.ts`、`server/services/storage-audit/service.test.ts` |
| 28 | 异常概况区分有待办的阻塞、出错任务和未关闭的存储异常；快照中断、独立 worker 缺少进程信息、首轮存储审计均不误报正常 | `app/features/admin/issues.test.ts`、`app/components/MyAdmin/RunIssues.nuxt.test.ts` |
| 29 | 『TODO』只在有读取权限的存储异常卡上显示『查看明细』。异常明细的记录行直接显示对象键和徽章 | `app/components/MyAdmin/RunIssues.nuxt.test.ts`、`app/components/MyAdmin/RunView.nuxt.test.ts` |
| 30 | 两个视图使用同一页头显示各自的轮询周期和成功更新时间；分区卡与用户卡支持内容高度变化 | `tests/e2e/admin-views.spec.ts` |

[css-production-ssr.spec.ts](../../../tests/e2e/css-production-ssr.spec.ts) 也会打开控制台，但它检查的是命令栏输入框在生产构建下的样式，不算上面任何一条。
