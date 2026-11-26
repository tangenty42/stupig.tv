# AGENT：账号与权限的裁定、偏差与经验

- 本文档状态：PENDING（账号专项通过，本地复验已收尾，上线后仍需核对生产账号授权）
- 覆盖范围：SID#2.1 的人类裁定、LAW 解读、落实记录、代码与 LAW 的出入、待办、工作经验、旧资料去向
- 旧文档：`docs-legacy/` 已于 2026-11-19 删除；本文提到的旧手册、旧台账以及“留在原文”的内容，原文都在 git tag `docs-legacy-final`
- 核对基线：2026-11-12 14:37:08 +08:00（Asia/Shanghai）；提交 `722c1cd3392cb4cdb5c8b051f3354c8e3905e355` 及未提交工作区
- 依据：[SID#2.1.LAW](LAW.md)、[SID#README](../../README.md)、[SID#0.0.LAW](../../0_overall/0_background/LAW.md)、[SID#0.1.LAW](../../0_overall/1_architecture/LAW.md)、[SID#0.1.DESIGN](../../0_overall/1_architecture/DESIGN.md)
- 实现说明：[SID#2.1.AGENT-DESIGN](AGENT-DESIGN.md)
- 最近专项验收：2026-11-21，见[账号专项验收](#2026-11-21-账号专项验收)。生产账号授权待发布后核对

## 人类裁定

2026-11-12，人类写了正式 LAW，并在 LAW 草稿末尾逐条答复了待裁定事项，随后又在对话里补充了几项。草稿 `TMP-LAW.md` 已按授权删除，答复原文抄在这里。

| # | 问题 | 人类答复 | 落实 |
| --- | --- | --- | --- |
| 1 | 头像大小上限在服务端不生效 | 授权修复 | 2026-11-12 01:08:31 +08:00 起已修：服务直接读 `settings.app.avatar.maxSizeMb`，回归测试经过真实路由 |
| 2 | 『控制台·只读』该不该看到私密信息 | “应该看到才对”；随后在 LAW 里把『控制台·完全』改成管理员特有 | 已改代码，见『LAW 解读』 |
| 3 | 档案权限只能给六名成员，网站要不要管 | “不管了，管理员自己管好就行” | 不改代码。`SID#0.0.LAW` 的规定靠操作纪律 |
| 4 | 改密码后其他设备要不要下线 | “不要” | 不改代码 |
| 5 | 注册和验证码登录时的第二次人机验证 | “要留”；服务端也校验 | 已改代码 |
| 6 | 用户名规则 | “用户名限制合法字符，中英文数字横杠下划线，注意包括所有全角字符”；全角标点也放行；“直接禁止纯数字用户名” | 已改代码，字符范围见『LAW 解读』 |
| 7 | 管理员的自我保护 | “拦住封禁自己；踢自己是可以的” | 已改代码 |
| 8 | 登录保持多久 | 保持现状，不改 | 不改代码。7 到 14 天之间是否还在登录仍取决于上次换发令牌的时间 |

对话里另外定下的：

- LAW 就保持现在的详略。LAW 没写的具体细节和规定下放到非权威文档，见 [AGENT-DESIGN 的『LAW 没写的细节』](AGENT-DESIGN.md#law-没写的细节)。
- 『蠢猪档案』的两级权限是故意设计，要落实到代码。
- 已存的授权记录写一条迁移来转换。

2026-11-19，人类确认登录记录里“当前设备除外”也适用于接口。当前设备按发起请求的已认证会话判断。

2026-11-23，人类裁定清空旧密码哈希。未设密码的账号只能用手机号验证码登录。短信登录后由登录弹窗接续打开可跳过的设密弹窗。生产清空随维护迁移执行。

2026-11-23，人类裁定 UI-I04 各入口的成功提示统一为『密码已修改！』和『验证码已发送！』。本人和管理员改密、登录注册和安全区发送验证码均已统一。账户单测通过，已验收。

2026-11-26，人类裁定 UI-B03／UI-L10／#95：无效用户 ID 和服务端确认不存在都在个人主页内显示『用户不存在』，提供指向首页的『返回首页』，不额外弹错误 Toast。临时读取失败沿用默认错误 Toast，并提供『重新加载』。登录记录只有成功取得快照且当前筛选无结果时才显示『？！暂无记录！？』，请求失败可重试，刷新失败保留已读记录。主页旧资料也只在目标和查看者均相同时保留。批次 8 已通过人工验收。[验收记录](../../TMP-UI-AUDIT.md#加载失败反馈复核)

## 2026-11-25 UI 分支核对

- 登录、注册、安全区的验证码成功提示与本人／管理员改密提示仍遵守 UI-I04。新手机号与旧号相同的校验由一处 helper 提供，发送结束后主动重查冷却，UI-D05／B12 不重复实现。
- 已补齐 UI 清单中的首次设密提交、成功、失败及服务端凭据校验分支。校准了人机验证、短信响应、数据库配额锁和无密码账号的真实错误条件。用户名与手机号碰撞时优先校验手机号账号的修复已落实，不再列为待决。
- 资料标题与字段、认证说明、登录记录筛选项改为共用行内图标基线，尚未进行本轮人工视觉验收。
- 退出告别（UI-B02）沿用公共框架已记录的裁定，保留退出与刷新之间的原顺序，刷新防抖和 Toast 静默状态由公共框架修复。本轮不另选延迟或移除告别的方案。
- 本轮记录的用户主页与登录记录读取缺口（UI-B03／L10）已于 2026-11-26 裁定并验收，见上文。
- 批次 10 裁定：个人主页的管理员徽章显示『管理员·大权独揽』，权限系列沿用中点。登录记录用 ` - ` 分隔系统与浏览器，例如『Windows - Chrome』。

## LAW 解读

LAW 用大白话写，下面是落到实现时我取的读法。读错了请指出。

| LAW 的说法 | 读法 |
| --- | --- |
| 『控制台·完全』管理员特有，不能赋予普通用户 | 权限定义里这一级标记为不可授予。授权接口拒绝它；数据库或 cookie 里已有的这一条读取时被丢弃，不起任何作用。所有用户管理操作和对他人账号的修改因此只有管理员能做 |
| 『大手发力』可直接查看（若有权限，还可编辑）他人的账号信息 | 『控制台·只读』能在别人主页和控制台列表看到手机号，能看登录记录，不能改任何东西，也不能强制下线设备。能改的只有管理员 |
| 『蠢猪档案』机密可读、完全 | 一项权限两个级别，『完全』包含『机密可读』。只有『机密可读』的人不能编辑档案，也不能动附件 |
| 管理员“至高无上” | 普通账号无法获得『控制台·完全』，所以封禁、撤销、设立管理员都只有管理员能做。管理员之间可以互相封禁和撤销，LAW 没有限制 |
| 封禁“立即退出登录” | 服务端立即拒绝该账号的全部请求。对方已打开的页面收到通知时立刻回到未登录状态，通知丢失时靠约 30 秒一次的轮询 |
| 用户名 2 ~ 32 字符 | 按 JavaScript 字符串长度计。字符范围和禁止纯数字是答复 6 定的，LAW 里没写，记在 AGENT-DESIGN |
| “所有全角字符” | 全角 ASCII 变体（U+FF01–FF60、U+FFE0–FFE6）加中文标点（U+3001–303F）。全角空格 U+3000 没有放行，因为看不见，会造出和别人一模一样的名字。弯引号、破折号、省略号不在这两个区段里，也没有放行 |

最后一行有我的取舍：你说的是“所有”，我去掉了全角空格，也没有把弯引号等算进去。要放行的话改 [schemas.ts](../../../server/shared/schemas.ts) 里的 `username_pattern` 一处即可。

## 本轮落实

| 改动 | 位置 |
| --- | --- |
| 权限定义改为『控制台』只读／完全（完全不可授予）、『蠢猪档案』机密可读／完全 | [permissions.ts](../../../server/shared/permissions.ts) |
| 档案相关的权限判断全部换成新名字；原先要求两项同时具备的地方改为只要求『完全』 | `server/services/content/`、`server/trpc/routers/content.ts`、`app/features/content/`、档案页面与路由中间件 |
| 手机号对『控制台·只读』可见；资料多一个 `sensitive_readable` 字段 | [profile.service.ts](../../../server/services/profile.service.ts)、[user.ts](../../../server/shared/types/user.ts) |
| 登录记录的读取按『控制台·只读』放行，强制下线仍要求能编辑 | [auth-guards.service.ts](../../../server/services/auth-guards.service.ts)、[profile 路由](../../../server/trpc/routers/profile.ts) |
| 主页：安全区块只给能编辑的人，登录记录给能读的人，强制退出按钮只给能编辑的人 | [个人主页](../../../app/pages/u/[id].vue)、[ProfileSessions.vue](../../../app/components/MyAccount/ProfileSessions.vue)、[profile.ts](../../../app/features/account/profile.ts) |
| 控制台：筛选可用手机号；授权弹窗不再列出『控制台·完全』；自己的卡片上封禁按钮不可点 | [admin-filter.ts](../../../server/services/admin-filter.ts)、[UsersView.vue](../../../app/components/MyAdmin/UsersView.vue)（当时还写在控制台页面里，2026-11-12 晚搬出）、[UserCard.vue](../../../app/components/MyAdmin/UserCard.vue) |
| 不能封禁自己 | [admin.service.ts](../../../server/services/admin.service.ts) |
| 注册和验证码登录把提交时的人机验证结果交给服务端校验，先于验证码核验 | [auth.service.ts](../../../server/services/auth.service.ts)、[schemas.ts](../../../server/trpc/schemas.ts)、[auth.ts](../../../app/features/account/auth.ts) |
| 用户名字符范围，禁止纯数字 | [schemas.ts](../../../server/shared/schemas.ts) |
| 2026-11-23：UI-D05 本人与管理员换号表单共用新旧手机号相同校验，沿用『如改！』 | [ProfileSecurity.vue](../../../app/components/MyAccount/ProfileSecurity.vue)。2 项组件测试通过，覆盖动态手机号校验及两种入口原有的验证码与提交参数 |
| 2026-11-23：注册校验补上数据库视作数字或忽略的字符。密码登录碰撞时以手机号为先 | [注册规则](../../../server/shared/schemas.ts)、[登录查询](../../../server/services/auth.service.ts)。补了数字变体、组合附标、既有用户名登录和重合时的账号选择回归 |
| 已存授权记录的转换 | [迁移](../../../migrations/20261112160000_account_permission_levels.sql)，摘要已登记到 [frozen.test.ts](../../../scripts/migration/frozen.test.ts) |

迁移的转换规则：`admin_access:full` 降为 `readonly`；`content_manage:full` 变成 `content_access:full`；只有 `content_private:read` 的变成 `content_access:private_read`；认不出的项丢弃，结果为空则置 NULL。可以重复执行。

权限转换在基线之后实际执行，按维护迁移发布。旧版应用无法识别新权限字段，因此先停旧写入者，再执行转换并启动新版。

### 本轮验证

| 检查 | 结果 |
| --- | --- |
| `pnpm exec nuxt typecheck`、scripts 与 tests 两个 `tsc` 检查 | 通过 |
| 对改动的源码和测试文件运行 `pnpm exec eslint` | 通过 |
| `pnpm test:unit` | 160 个文件中 159 个通过，2087 项中 2084 项通过。失败的 3 项都在 `server/api/trpc/[trpc].test.ts`，是要连本机回环地址的 HTTP 测试，被沙箱代理拒绝连接；这 3 项与本轮改动无关，需要在沙箱外重跑确认 |
| `pnpm test:component` | 12 个文件 73 项通过 |
| `pnpm exec vitest run --project tools scripts/migration/frozen.test.ts` | 通过 |

没有做到的：

- 浏览器测试 `pnpm test:e2e` 没有跑，同样因为需要 Docker。主页对只读者的显示、控制台授权弹窗、注册时的用户名提示都没有在真实页面上看过。
- 没有完整跑 `pnpm check`。

### 后续迁移验证

本机隔离 MySQL 的发布专项使用模拟存量库，验证了 `content_private:read` 转成 `content_access:private_read`。重建后的本地开发空库也已执行权限迁移。生产账号授权核对保留在待办。[发布专项](../../../scripts/verify/deployment.ts)

### 2026-11-19 验收补测

换手机号的两个验证码分别有失败用例，也检查重复号码与成功写入。验证码改密码检查最终哈希。管理员代改密码、手机号、生日和头像均经过资料接口，检查写入目标用户。跨设备、跨标签页退出共用注册流程中的临时账号。

| 检查 | 结果 |
| --- | --- |
| `pnpm exec vitest run server/services/admin.service.test.ts server/services/profile.service.test.ts server/services/auth.service.test.ts server/services/auth-guards.service.test.ts server/services/session.service.test.ts` | 5 文件 109 项通过，涵盖上述资料接口、封禁后撤销该账号会话和拒绝登录、解封时恢复账号状态 |
| `pnpm exec tsc --project tests/tsconfig.json --noEmit` | 通过。Playwright 能列出账号生命周期用例，定向 E2E 启动时连接本机 MySQL 被拒（EACCES），跨设备和跨标签页两个步骤尚未运行 |
| [发布专项](../../../scripts/verify/deployment.ts) | 扩充旧控制台权限降级、旧档案权限合并、未知项和现有新格式样例，并补齐待执行的两条维护迁移。新增样例待在本机隔离库复验 |
| `pnpm exec vitest run server/services/profile.service.test.ts server/services/auth-guards.service.test.ts server/services/auth.service.test.ts server/services/session.service.test.ts` | 当前设备限制的两条路由回归在修改前都复现了问题。修改后 4 文件 107 项通过，涵盖普通用户和管理员拒绝强退本机、退出自己的其他会话、管理员代操作、常规退出 |

### 2026-11-21 账号专项验收

`pnpm test:e2e tests/e2e/accounts-lifecycle.spec.ts` 在隔离 Chromium 环境通过。第 17 条使用两个独立会话：从登录记录强退第二台设备后，该设备显示登录入口，`profile.getMe` 返回 401，发起操作的设备仍显示用户菜单且接口请求成功。另跑 `server/services/profile.service.test.ts` 的两条当前会话回归，普通用户和管理员请求强退本机均得到 `BAD_REQUEST`。第 18 条在同一浏览器打开两个标签页，从一页正常退出后，另一页随即显示登录入口。

在本机隔离 MySQL 执行[发布专项](../../../scripts/verify/deployment.ts)，查询迁移后的四个测试账号，结果如下。

| 迁移前 | 实际读回 |
| --- | --- |
| `content_private:read` | `content_access:private_read` |
| `admin_access:full`、`content_manage:full`、`content_private:read` | `admin_access:readonly`、`content_access:full` |
| 仅含已退役的未知项 | `NULL` |
| `content_access:full` | `content_access:full` |

权限迁移的执行次数为 1。已有正文和草稿的保留检查通过，脚本成功清理临时库和计划目录。

## 代码与 LAW 的出入

2026-11-19 已落实“当前设备除外”。[登录记录](../../../app/components/MyAccount/ProfileSessions.vue)只给其他设备显示按钮。[资料接口](../../../server/trpc/routers/profile.ts)把认证所得的会话 ID 传给[服务](../../../server/services/profile.service.ts)，服务核对会话归属后，若目标就是当前会话，返回 400。普通退出仍走 `auth.logout`。

下面两处 LAW 没有规定，实现保留了原样，记下来备查：

| 事项 | 现状 |
| --- | --- |
| 附件操作里的“涉及机密时再查机密权限” | [require_workspace_actor](../../../server/services/content/workspace-auth.service.ts) 仍接收“是否涉及机密”的参数并据此多查一级。『完全』已包含『机密可读』，这个参数现在不会改变结果。十几处调用没有动，是否清理留到写档案板块时决定 |
| 权限说明的文案 | 主页和控制台上显示的权限名称与说明取自权限定义，已改成 LAW 的叫法；[content-private.ts](../../../server/shared/content-private.ts) 开头的注释还写着旧权限名 `content_private`，没有改，因为不确定该文件是否在冻结的迁移依赖里 |

## 其他出入

这些不涉及 LAW，记下来供后续处理。

| 事项 | 现状 |
| --- | --- |
| 设备身份 cookie 的 httpOnly | [identity 中间件](../../../server/middleware/identity.ts)里 `httpOnly` 一行被注释掉了，cookie 脚本可读。`app/` 下没有代码读它。`SID#0.1.DESIGN` 原先注释掉的『用户身份』草稿写的是 httpOnly（该草稿已于 2026-11-19 删除） |
| 验证码用途不绑定 | `otp_send_logs.purpose` 只作记录。核验时只看手机号和验证码，为登录发的验证码也能用于注册或换手机号 |
| 两张表只增不删 | `otp_send_logs` 和 `user_login_sessions` 没有清理逻辑。令牌表每次换发时会裁剪 |
| 验证码次数的清零时刻 | 按 UTC 日，即北京时间早上 8 点 |
| 第 6 次发送仍是短冷却 | `tier1.dailyLimit` 是 5，但跨档的那一次仍用短冷却，有测试锁定 |
| 老账号的用户名 | 注册规则只校验新账号，旧用户名原样保留。密码登录只命中用户名时仍可使用旧名。旧名与另一账号的手机号相遇时，可用自己的绑定手机号登录 |
| 用户名的大小写与全角半角 | 是否把 `ａｄｍｉｎ` 和 `admin` 视为重名取决于数据库排序规则 `utf8mb4_unicode_ci`，没有实测 |
| 手机号形用户名与手机号的比较 | 已处理。2026-11-23 在本机 MySQL 8.4.11 用合成字符串核验 `utf8mb4_unicode_ci`。数字加部分组合附标、〇及杭州数字可与半角数字比较相等，注册规则已覆盖。两条虚拟记录同时命中时，新的密码登录查询选中手机号对应的记录。核验使用合成数据 |
| 没有调用方的代码 | `require_admin_user`、`system.me`、同步资源类型 `user_login_sessions` |

## 待办

| 事项 | 完成条件 |
| --- | --- |
| 全仓本地复验 | 已按人类要求收尾。`pnpm check` 通过。默认套件最近一次完整运行通过 39/40 项，唯一失败的权限页用例经单独复验通过。[全仓本地复验](../../AGENT.md#2026-11-21-全仓本地复验) |
| 账号专项验收 | 已完成。[第 17、18、29 条](#2026-11-21-账号专项验收)分别覆盖设备退出、跨标签页退出和四组旧授权迁移。第 19 条封禁与解封见[控制台的浏览器验收](../3_admin/AGENT.md#2026-11-21-用户操作与异常明细) |
| 承接总体文档里的本板块内容 | 已完成。2026-11-19 人类确认保留[账号与档案接线](../../0_overall/1_architecture/AGENT-DESIGN.md#账号与档案接线)的跨模块概要，细节归各领域 |
| 上线后重新核对授权 | 迁移把原先的『控制台·完全』降成了只读。需要继续管理用户的人要设为管理员 |

## 传统与工作经验

来自代码注释和测试，改动这些地方前先看原因。

- 登录令牌只通过 httpOnly cookie 下发，登录和注册的响应体里不带。响应体里有一份的话，页面上任何脚本都能读到。
- 令牌换发后旧一代不作废，到自己的 JWT 过期为止都能认证，但不再触发换发。在途请求和没收到新 cookie 的浏览器靠这一点不被踢下线；一直收不到 cookie 的客户端也因此不会每个请求都新增一代。
- 带 `X-Nuxt-SSR` 的请求不换发令牌也不更新活跃时间。SSR 内部请求的响应头到不了浏览器，在那里换发会让数据库里多出一枚浏览器没有的令牌。
- 换发令牌时同时刷新展示用户信息 cookie。只刷新令牌的话，展示 cookie 到期后界面显示未登录，而会话其实还有效。
- 验证码发送先落预约再调短信服务，短信失败或超时也不撤销预约。对方可能已经发出，撤销会让人反复重发。
- 验证码预约用的数据库命名锁不跨短信调用持有；锁的获取或释放结果不明时销毁连接而不是归还，因为提交和回滚都不释放命名锁。
- 人机验证排在验证码核验之前。验证码核验会消耗验证码，先验人机可以让没过人机验证的请求不碰验证码。
- 冷却频道名由服务端带密钥生成，浏览器只能用接口返回的那两个。[MyFormField](../../../app/components/MyFormField.vue) 里冷却查询的查询键是手机号而不是频道名：首次查询时还没有频道名，而且频道名随结果更新时不应再触发一次请求。该文件里有 `THIS IS A GOOD COMMENT` 保护段，改动前先看 [保护标记的规则](../../0_overall/AGENT-DESIGN.md#作者内容与保护标记)。
- 头像每次上传都用新的对象键，先写对象再更新数据库。同一个键被覆盖时，ESA 上的旧缓存不会失效。
- `useAuth().logout()` 在展示 cookie 已空时直接返回。401 处理会在每个失败请求上调用它，没有这个判断会不停重载页面。
- 401 的退出任务按 Nuxt 应用实例隔离，来由见 [SID#0.1.AGENT 的三阶段重构记录](../../0_overall/1_architecture/AGENT.md#三阶段业务模块重构)。
- 裁剪令牌代次的 SQL 里 `LIMIT` 是拼进去的，因为 MySQL 的预处理语句不接受这里用占位符；拼入的是校验过的配置整数。
- 数据库的 `tinyint(1)` 在组织返回值时显式转成布尔值，连接池没有统一转换。
- 权限的有效性只在 `is_valid_permission_grant` 一处判断，`has_permission` 和读取时的规整都经过它。测试里手写一条不可授予的权限给非管理员，是测不出“有权限”的。
- 服务测试直接调用 service 时测不到路由层的接线。头像大小上限的问题就藏在路由读配置的那一行，当时服务测试全部通过。
- 浏览器测试里验证码固定为 `123456`，由 [e2e-sms.ts](../../../tests/support/e2e-sms.ts) 替身核验。开发公共账号使用占位手机号，短信登录用例在隔离库中创建[专用账号](../../../tests/support/e2e-accounts.ts)，经过真实表单校验和发送冷却。开发账号约定见 `SID#1.1.DESIGN`。

## 旧资料去向

| 来源 | 去向 |
| --- | --- |
| 旧账号手册（`docs-legacy/modules/accounts.md`）『登录与验证码』『会话模型』 | AGENT-DESIGN 的『验证码』『认证与令牌换发』『数据库结构』 |
| 旧账号手册『权限』 | AGENT-DESIGN『权限判定』。已过时：手册里的四行权限表、`content_manage`／`content_private` 两个旧名和“草稿要求两项权限同时满足”，现为 `content_access` 的 `private_read`／`full`，草稿只要 `full` |
| 旧账号手册『登录与验证码』里冷却取最晚截止、人机验证上游异常即拒绝 | AGENT-DESIGN『验证码』 |
| 旧账号手册『源码与验证』 | `SID#1.2` |
| 旧账号手册『用户资料与控制台』 | 资料、头像、代操作在 AGENT-DESIGN；控制台部分归 `SID#2.3` |
| `SID#0.1.DESIGN` 注释掉的『用户身份』（2026-11-19 人类已删） | AGENT-DESIGN『身份数据』『认证与令牌换发』『通知与轮询』 |
| `SID#0.1.AGENT-DESIGN`『账号与档案接线』前两条 | AGENT-DESIGN『身份数据』『代操作』『资料查询』 |
| LAW 草稿 `TMP-LAW.md` | 人类据此写了正式 LAW；答复抄入本文『人类裁定』，验收标准在 AGENT-DESIGN，草稿已删除 |

旧账号手册不作为现行依据。
