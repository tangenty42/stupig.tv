# AGENT-DESIGN：账号与权限的实现

- 本文档状态：PENDING（[账号专项验收](AGENT.md#2026-11-21-账号专项验收)已通过，[本地复验](../../AGENT.md#2026-11-21-全仓本地复验)已收尾，生产授权待上线后核对）
- 覆盖范围：注册登录、会话与令牌、验证码限流、资料与头像、权限判定、代操作、向其他板块提供的鉴权入口、LAW 没写的细节，以及本板块的验收标准
- 上位依据：[SID#2.1.LAW](LAW.md)、[SID#0.1.LAW](../../0_overall/1_architecture/LAW.md)、[SID#0.1.DESIGN](../../0_overall/1_architecture/DESIGN.md)
- 核对基线、裁定与偏差：[SID#2.1.AGENT](AGENT.md)

LAW 用大白话讲人能看到和做到的事。本文约束具体实现：LAW 没写的数值、规则和边界都以这里为准，改动它们要先经人类同意。目录职责、tRPC 分级、`useSyncedData` 和通知机制见 `SID#0.1.DESIGN`，这里只写本板块特有的部分。

## 入口

| 位置 | 内容 |
| --- | --- |
| [app.vue](../../../app/app.vue) | 顶栏的登录按钮和用户菜单，挂载登录注册弹窗，启动身份刷新 |
| [/u/:id](../../../app/pages/u/[id].vue) | 个人主页，由 [MyAccount/](../../../app/components/MyAccount) 下的概览、安全、登录记录三个组件组成 |
| [features/account/](../../../app/features/account) | `auth.ts` 负责身份刷新和登录注册流程，`profile.ts` 负责资料、安全、登录记录的查询与操作 |
| [useAuth()](../../../app/composables/useAuth.ts) | 读写展示用户信息 cookie，退出登录 |
| [routers/](../../../server/trpc/routers) | `auth`、`profile`、`presence` 三个路由 |
| [server/services/](../../../server/services) | `auth.service`、`auth-guards.service`、`session.service`、`profile.service` |
| [permissions.ts](../../../server/shared/permissions.ts) | 权限定义和判定，前后端共用 |
| [schemas.ts](../../../server/shared/schemas.ts) | 表单校验和密码规则，前后端共用 |

控制台对用户的封禁、认证、授权等操作由 `admin` 路由和 [admin.service](../../../server/services/admin.service.ts) 提供，归管理控制台板块；它们写的是本板块的表。

## 数据库结构

四张表的结构来自 [基线迁移](../../../migrations/20261112150000_baseline.sql)。[权限维护迁移](../../../migrations/20261112160000_account_permission_levels.sql)在基线之后改写 `users.permissions` 里已存的值，转换规则见 [SID#2.1.AGENT](AGENT.md#本轮落实)。时间列按 UTC 存。

### `users`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint 自增，主键 | UID |
| `username` | varchar(32)，唯一 | 没有修改入口 |
| `phone` | char(11)，唯一 | |
| `password_hash` | varchar(255)，可空 | Argon2id；NULL 表示未设置密码 |
| `avatar_file` | varchar(64)，可空 | 头像文件名，对象键为 `avatar/<文件名>` |
| `avatar_version` | varchar(64)，可空 | 头像对象的 ETag，拼成 `?version=` 让缓存失效 |
| `birthday` | timestamp，可空 | |
| `is_verified`、`verified_note` | tinyint(1)、varchar(255) 可空 | 认证标记和说明 |
| `is_admin` | tinyint(1) | 为 1 时等同全部权限，`permissions` 保持 NULL |
| `permissions` | json，可空 | `[{ field, level }]`，读取时经 `normalize_permission_grants` 过滤未知项、同一项只留最高级别 |
| `is_banned` | tinyint(1) | |
| `created_at`、`updated_at` | timestamp | |

最近登录、最近活跃、是否在线都从 `user_login_sessions` 现算，`users` 上没有对应列。

### `user_login_sessions`

一行是某账号在某设备上的一次登录。

| 列 | 说明 |
| --- | --- |
| `id` | 主键 |
| `user_id` | 外键到 `users`，级联删除 |
| `identity_token` | 设备身份 cookie 的值 |
| `is_logged_out`、`logout_at` | 退出、被强制退出、被封禁时置位 |
| `login_at`、`last_seen_at` | `last_seen_at` 在每个非 SSR 预取的已认证请求上更新 |
| `expires_at` | 每次更新 `last_seen_at` 时重设为当前时间加 `app.auth.session.maxAgeDays` |
| `login_ip`、`last_seen_ip`、`user_agent` | IP 取 `x-forwarded-for` 的第一段，没有时取连接地址 |

同一账号在同一设备上再次登录时，若最新一行已退出或已过期，就复用这一行并删掉它名下的全部令牌；若最新一行仍有效，另插一行。

### `user_login_session_tokens`

一行是某次登录名下的一代令牌。

| 列 | 说明 |
| --- | --- |
| `id` | 主键，同一会话内越大越新 |
| `session_id` | 外键到 `user_login_sessions`，级联删除 |
| `token_hash` | 令牌的 SHA-256，唯一。库里不存令牌原文 |
| `expires_at` | 与该令牌 JWT 的 `exp` 相同 |

### `otp_send_logs`

一行是一次验证码发送预约。

| 列 | 说明 |
| --- | --- |
| `identity_token`、`phone` | 限流的两个维度，查询时用 OR 合并 |
| `purpose` | `login`、`register`、`change_password`、`change_phone`、`verify_old_phone` |
| `requested_at` | 计入当日次数的依据 |
| `cooldown_until` | 下一次允许发送的时间 |

验证码本身由阿里云号码认证服务生成和核验，库里不存。

## 身份数据

| 数据 | 存放 | 用途 |
| --- | --- | --- |
| 登录令牌 | cookie `stupig_session`，httpOnly、secure、SameSite=Lax | 服务端认证的唯一依据。JWT 载荷只有 `sub`（UID）和 `jti` |
| 展示用户信息 | cookie `login`，脚本可读，JSON | 前端判断是否登录、渲染顶栏、决定入口显隐。服务端不信任它 |
| 设备身份 | cookie `stupig_identity`，脚本可读、secure，30 天 | 验证码限流的设备维度，登录时关联到会话行 |
| 会话与令牌代次 | 上面两张表 | 封禁、退出、过期的事实记录 |

令牌 cookie 只由服务端写入和清除。展示用户信息 cookie 在登录时由浏览器写入，令牌换发时由服务端同步刷新，其余时候由 `useAccountIdentity` 按最新资料更新。设备身份 cookie 由 [identity 中间件](../../../server/middleware/identity.ts)在每个请求上读取，没有就新发；首次签发与后续复用见[中间件测试](../../../server/middleware/identity.test.ts)。

前端只有 `useAuth()` 这一处身份来源，业务模块与它组合使用。

## 认证与令牌换发

[require_auth_user](../../../server/services/auth-guards.service.ts) 是服务端唯一的认证入口，结果缓存在 `event.context.auth_user`，一个 tRPC 批量请求内只解析一次。

1. 取令牌 cookie 并校验 JWT 签名和有效期。
2. 用令牌的哈希查出令牌行、会话行和用户行。
3. 账号被封禁、会话已退出、会话已过期，都返回 401，提示各不相同。
4. 带 `X-Nuxt-SSR` 头的请求到此结束，不更新活跃时间也不换发。
5. 其他请求更新 `last_seen_at`、`last_seen_ip` 并顺延 `expires_at`。
6. 若出示的是该会话最新一代令牌，且剩余有效期不超过 `app.auth.jwt.renewBeforeDays`，就签一枚新令牌并尝试插入新一代。插入条件是“该会话没有比出示的这一代更新的令牌”，并发请求里只有一个能插入成功，只有它下发新的令牌 cookie 和展示用户信息 cookie。
7. 同一事务里删掉该会话已过期的令牌，并只保留最新的 `app.auth.session.maxTokenGenerations` 代。

旧一代令牌在自己的 JWT 过期前仍能认证，但不触发换发。这样在途请求和没收到新 cookie 的浏览器不会被踢下线，一直收不到 cookie 的客户端也不会让令牌行无限增长。

返回的 `AuthUser` 带 `session_id` 和 `token_generation_id`。蠢猪档案的草稿事务和附件读取授权会拿这两个值回库复核，见各自的文档。

退出登录走 `useAuth().logout()`：直接请求 `auth.logout`，清掉展示用户信息 cookie，经 BroadcastChannel 通知同浏览器的其他标签页，然后重载页面。它不经过 `useApi()`，避免和传输层的 401 处理互相依赖。

## 验证码

发送流程在 [send_otp_for_request](../../../server/services/auth.service.ts)：

1. 校验人机验证。
2. 用途为 `change_password`、`verify_old_phone` 时要求已登录，手机号取账号当前手机号；其余用途取请求里的手机号。
3. 取得数据库级命名锁后查当日次数和未结束的冷却，通过则插入一行预约，然后释放锁。拿不到锁时返回 429，不排队。
4. 发布两个冷却通知。
5. 调用短信服务。

预约先于短信发送落库，短信失败或超时也不撤销，因为无法确认对方是否已经发出。命名锁不跨短信调用持有。锁的获取或释放结果不明时销毁该连接，因为事务提交和回滚都不会释放命名锁。

分档由 `calc_otp_send_tier` 按当日已发次数计算，数值来自 `app.otp`。

冷却查询 `get_otp_cooldown` 按设备身份（带手机号时加上手机号）取最晚的一条 `cooldown_until`，晚于当前时间就返回不可发送和这个时刻。发送时的冷却判断同样取 `MAX(cooldown_until)`。

人机验证在 [verify_captcha](../../../server/lib/captcha.ts)。参数不全返回 400；上游请求出错、HTTP 状态不成功或返回体不可识别时返回 503；上游结果不是 `success` 时返回 403。任何一种都不放行。

核验在 `check_otp_sms`，注册、验证码登录、凭验证码改密码、更换手机号都调用它。

注册和验证码登录在提交时还要再过一次人机验证，结果随请求提交，服务端在核验验证码之前校验。这样连同发验证码、密码登录、改密码、换手机号，共六个操作由服务端校验人机验证。

`app.otp.debug` 和 `app.captcha.debug` 为真时跳过短信和人机验证的真实调用。配置加载器只允许开发环境开启，服务端代码还会再判断一次 `NODE_ENV`。

## 权限判定

权限定义集中在 `PERMISSIONS` 数组，新增权限项或级别只改这一处。

| 权限项 | 级别（从低到高） | LAW 的叫法 |
| --- | --- | --- |
| `admin_access` | `readonly`、`full` | 『控制台』只读、完全 |
| `content_access` | `private_read`、`full` | 蠢猪档案，机密可读、完全 |

- 同一项里高级别包含低级别，`has_permission(user, field, level)` 按级别在数组里的位置比较。
- `is_admin` 为真时 `has_permission` 直接通过，管理员的 `permissions` 保持 NULL。
- `admin_access:full` 标了 `grantable: false`，是管理员特有的级别。`is_valid_permission_grant` 对它返回假，于是授权接口拒绝它，`normalize_permission_grants` 读取时丢弃它，`has_permission` 也不认非管理员手里的这一条。要求这一级的接口因此只有管理员能通过。
- `normalize_permission_grants` 还会丢弃认不出的权限项，旧名字 `content_manage`、`content_private` 就是这样失效的。

服务端用 `permission_procedure(field, level)` 守住路由，每个请求都从数据库读当前权限。前端用同一个 `has_permission` 读展示用户信息 cookie 来决定入口显隐，路由中间件也只用于跳转。

档案板块里，创建、编辑、删除档案和一切附件操作要求 `content_access:full`，读机密内容和机密附件要求 `content_access:private_read`。

## 代操作

LAW 把它叫『大手发力』。支持代操作的接口接收可选的 `operate_for`，统一用 `resolve_operate_target(event, operate_for, level)` 解析：省略或等于自己时操作自己，否则按 `level` 要求『控制台』权限。

- 修改类接口用默认的 `full`，只有管理员能替别人操作。
- 只读的 `profile.getSessions` 传 `readonly`，『控制台·只读』也能看别人的登录记录。

这些接口用 `public_procedure` 声明，登录要求由 `resolve_operate_target` 内部的 `require_auth_user` 保证。

直接改密码、直接换手机号不需要验证码，所以单独用 `permission_procedure('admin_access', 'full')` 声明成 `resetPasswordFor`、`changePhoneFor`。

## 接口

| 接口 | 访问要求 | 说明 |
| --- | --- | --- |
| `auth.register` | 公开 | 校验人机验证，核验验证码，建账号并登录 |
| `auth.loginWithPassword` | 公开 | 校验人机验证。未设密码的账号提示改用手机号验证码登录 |
| `auth.loginWithPhone` | 公开 | 校验人机验证和验证码；未设密码时回执带 `needs_password_setup`，并下发设密凭据 |
| `auth.sendOtp` | 公开，部分用途要求登录 | 见上文 |
| `auth.getOtpCooldown` | 公开 | 返回下次可发时间和两个冷却频道名 |
| `auth.logout` | 登录 | |
| `profile.get` | 公开 | 按访问者裁剪字段 |
| `profile.getMe` | 登录 | |
| `profile.updateBirthday`、`uploadAvatar`、`deleteAvatar` | 本人，或管理员代操作 | |
| `profile.getSessions` | 本人，或『控制台·只读』代看 | |
| `profile.forceLogoutSession` | 本人，或管理员代操作 | 目标会话须属于目标账号。归属无误后，若会话就是操作者当前使用的会话，则返回 400 |
| `profile.changePassword`、`changePasswordByOtp`、`changePhone` | 登录 | 只作用于自己，校验人机验证 |
| `profile.setInitialPassword` | 刚用短信登录的本人 | 核验绑定当前手机号和登录令牌的短期 HttpOnly 凭据，只写入仍未设置密码的账号 |
| `profile.resetPasswordFor`、`changePhoneFor` | 管理员 | |
| `presence.ping` | 公开 | 已登录时顺带更新活跃时间 |

## 资料查询

用户资料的查询统一用 `select_profile_row_sql` 和 `format_profile_row()`，控制台的用户列表也复用它们。`format_profile_row` 给出两个标记：

| 标记 | 为真的条件 | 用处 |
| --- | --- | --- |
| `sensitive_readable` | 本人，或有『控制台·只读』以上 | 为假时手机号置空；主页据此决定是否渲染登录记录 |
| `editable` | 本人，或管理员 | 主页据此决定是否渲染修改入口、安全区块和登录记录里的强制退出按钮 |

标记只管界面显隐，接口各自再由 `resolve_operate_target` 或 `permission_procedure` 把关。

个人主页区分加载、确认不存在和临时读取失败。首次读取及手动重试时居中转圈，读屏提示『正在加载用户资料』。无效用户 ID 与服务端 404 都在页内显示『用户不存在』，沿用公共链接样式提供指向 `/` 的『返回首页』，不额外弹错误 Toast。网络或其他临时失败沿用 `useSyncedData()` 的默认错误 Toast，并提供『重新加载』。已有资料仅在目标用户和查看者均相同时用于刷新失败后的保留，避免换用户时误显示上一份资料。

登录记录在成功取得快照且当前筛选没有记录时才显示『？！暂无记录！？』。首载失败显示错误 Toast 和『重新加载』。临时刷新失败保留同一查看者、同一目标的已读记录，由轮询或同步刷新恢复。确认权限被拒绝时清空旧记录。成功读取后清除失败状态。

在线状态的判定是：存在一条未退出、未过期、`last_seen_at` 在 `app.online.timeoutSeconds` 秒内的会话。为了让它及时，浏览器在页面可见、已登录、且 `app.online.pingIdleIntervalSeconds` 秒内没有发过别的请求时发一次 `presence.ping`。

## 头像

浏览器用 cropperjs 裁出正方形，导出 512×512、质量 0.92 的 JPEG，超过 `app.avatar.maxSizeMb` 就在本地拒绝，然后以 FormData 上传。

服务端直接读取共享设置的 `app.avatar.maxSizeMb`，在读取文件字节和写存储前拒绝超限文件（413）；恰好达到上限允许。大小限制由服务自身执行，调用方不传上限。按 MIME 或扩展名接受 JPG、PNG、WebP，不重新编码。对象键是 `avatar/<UID>-<随机 UUID>.<扩展名>`，每次上传都是新键。先写对象再更新数据库，然后尽力删除旧对象，删除失败只记日志。对象在 OSS 上是私有的，经 ESA 公开读取。

头像存储走 [static-storage.ts](../../../server/lib/static-storage.ts)，与蠢猪档案的附件是两套代码。

## 通知与轮询

本板块的写操作在数据库写入后直接调用 `publish_refresh()`。通知可能丢失，所以相关查询都带轮询。

| 资源键 | 何时发布 | 谁订阅 | 轮询 |
| --- | --- | --- | --- |
| `auth_user:<UID>` | 资料、头像、手机号、密码、认证、权限、管理员身份、封禁状态变化；退出和强制下线 | `useAccountIdentity`，挂在 `app.vue` | `app.auth.syncPollIntervalSeconds` |
| `profile:<UID>` | 资料、头像、手机号、认证、权限、管理员身份、封禁状态变化；强制退出某设备 | 个人主页 | `app.online.pollIntervalSeconds` |
| `profile_sessions:<UID>` | 登录、退出、强制退出、封禁；认证时发现会话刚过期 | 主页的登录记录 | `app.online.pollIntervalSeconds` |
| `otp_cooldown:<手机号>`、`otp_cooldown_by_identity:<设备身份>` | 验证码发送预约成功 | 表单里的发送按钮 | 无 |

两个冷却资源键里是手机号和设备身份，发布前由 [wire_resource](../../../server/lib/sync-channel.ts) 换成带密钥的摘要。浏览器算不出频道名，只能用 `auth.getOtpCooldown` 返回的那两个。

验证码发送流程结束时，本页按手机号重新查询各可用字段的冷却，补上漏掉的通知。发送失败也重新查询，因为服务端可能已经完成预约。

`useAccountIdentity` 的取数函数是 `profile.getMe`。会话失效后这个请求得到 401，传输层据此退出登录并重载页面，被封禁、被强制下线的页面就是这样自动回到未登录状态的。

登录时浏览器经 BroadcastChannel 发 `login`，其他标签页让全部查询失效重读。退出时发 `logout`，其他标签页清掉展示用户信息并重载。

## 前端结构

| 入口函数 | 位置 | 职责 |
| --- | --- | --- |
| `useAccountIdentity()` | `auth.ts` | 订阅 `auth_user`，把最新资料写回展示用户信息 cookie。只在 `app.vue` 调用一次 |
| `useAccountAuthFlow()` | `auth.ts` | 登录、注册、发验证码，连同人机验证和 pending 状态 |
| `useAccountProfile(id)` | `profile.ts` | 主页资料查询，给出 `is_viewing_other`（看的是别人）和 `is_operating_other`（看的是别人且自己是管理员） |
| `useAccountProfileDetails()` | `profile.ts` | 生日、删除头像 |
| `useAccountSecurity()` | `profile.ts` | 改密码、换手机号及其验证码 |
| `useAccountSessions()` | `profile.ts` | 登录记录查询和强制退出；`sensitive_readable` 为假时不订阅也不请求 |

表单用 `@primevue/forms` 加 Zod resolver，schema 和默认值取自 `form_schema`、`form_default`。带发送按钮的验证码输入由 [MyFormField](../../../app/components/MyFormField.vue) 提供，冷却查询的查询键是当前填写的手机号，频道名随查询结果更新。

资料标题、认证说明、字段标题和登录记录筛选项的图标与文字放在同一行内框中，沿用全站图标基线。首次设密在登录弹窗退场后打开，提交期间禁止关闭，失败保留输入，成功提示『密码设置成功！』后关闭。

[useCaptcha()](../../../app/composables/useCaptcha.ts) 封装阿里云验证码控件，同一时刻只允许一个验证在进行。

## 配置

| 配置 | 当前值 | 作用 |
| --- | --- | --- |
| `app.auth.jwt.expiresInDays`、`renewBeforeDays` | 14、7 | 令牌有效期，剩余多少天开始换发 |
| `app.auth.session.maxAgeDays`、`maxTokenGenerations` | 14、8 | 会话空闲多久过期，每个会话保留几代令牌 |
| `app.auth.cookie.maxAgeDays` | 14 | 令牌 cookie 和展示用户信息 cookie 的寿命 |
| `app.auth.syncPollIntervalSeconds` | 30 | 身份轮询周期 |
| `app.otp.expiresMinutes` | 10 | 验证码有效期 |
| `app.otp.tier1`、`tier2` | 各 5 次；冷却 60 秒、30 分钟 | 发送分档 |
| `app.identity.cookieMaxAgeDays` | 30 | 设备身份 cookie 的寿命 |
| `app.online.timeoutSeconds`、`pingIdleIntervalSeconds`、`pollIntervalSeconds` | 16、4、4 | 在线判定和保活 |
| `app.avatar.maxSizeMb` | 1 | 头像大小上限 |

以上都在 [app-settings.yaml](../../../config/app-settings.yaml)。JWT 密钥、短信和人机验证的凭据属于部署配置，见 `SID#1.0`。

## 向其他板块提供的能力

| 能力 | 入口 |
| --- | --- |
| 认证当前请求 | `require_auth_user(event)`、`optional_auth_user(event)` |
| 声明接口的访问要求 | `public_procedure`、`protected_procedure`、`permission_procedure(field, level)` |
| 解析代操作目标 | `resolve_operate_target(event, operate_for, level)` |
| 判定权限 | `has_permission(user, field, level)` |
| 前端读取当前身份 | `useAuth().user` |
| 用户资料查询与裁剪 | `select_profile_row_sql`、`format_profile_row()` |
| 让某账号全部设备下线 | `logout_all_user_sessions(user_id)` |

## LAW 没写的细节

LAW 只讲大意。下面这些是现在的具体做法，LAW 没有写，由本文约束。

### 用户名

- 2 到 32 个字符，按 JavaScript 字符串长度计。
- 允许的字符：汉字、英文字母、数字、横杠、下划线，全角 ASCII 变体（U+FF01–FF60、U+FFE0–FFE6），中文标点（U+3001–303F）。空格、全角空格、其他符号和表情不允许。
- 用户名须含非数字字符，组合附标不计。全角数字、〇及杭州数字 `〡` 到 `〩` 都按数字处理，和 `utf8mb4_unicode_ci` 的比较一致。
- 全站唯一，注册后不能改。
- 规则在 `form_schema.register`，只在注册时检查，前后端共用。
- 密码登录以同一输入查手机号和用户名。如果两者命中不同账号，优先选手机号对应的账号，再核验该账号的密码和封禁状态。仅命中用户名时继续按用户名登录。发生碰撞的旧用户名账号可用自己的绑定手机号登录。

### 密码

- 8 到 64 位，不能是纯数字。
- 不能有同一字符连续 4 次。
- 不能含 4 位连续的顺序字符：字母序、数字序（含 `8901` 这样的回绕）、键盘上横向或斜向相邻的键，正反向都算。
- 注册、首次设密、改密码、管理员重置密码用同一条规则 `password_policy_schema`。
- 用 [密码哈希入口](../../../server/lib/password.ts) 对完整输入生成 Argon2id 哈希。维护迁移清空旧 bcrypt 哈希。短信登录回执标记未设密码时，登录弹窗关闭后打开设密弹窗，用户可以点右上角关闭按钮跳过。设密凭据与短信验证码使用相同的有效时长，保存成功后清除。跳过后可从个人主页经短信验证码设密。
- 首次设密同时核对手机验证凭据和数据库更新条件。凭据失效时提示重新用手机号验证码登录，账号在请求期间已设密码或状态变化时提示从个人主页安全区重试。未设密码的账号使用旧密码改密也会被拒绝，并指引验证码方式。

### 登录与退出

- 没有“忘记密码”入口。忘了密码可以用验证码登录，再凭验证码改密码。
- 账号不能注销。
- 退出登录需要二次确认。退出后本页重载，同一浏览器的其他标签页一起回到未登录状态，其他设备不受影响。
- 改密码不会让其他设备下线。
- 登录保持的时间由三个配置共同决定：令牌有效 14 天，剩余不超过 7 天时换新，会话每次访问后顺延 14 天。相邻两次访问间隔不超过 7 天时一定保持登录，连续 14 天没访问一定要重新登录，介于两者之间取决于上次换发的时间。人类已确认保持这样。
- 被封禁、被强制下线、会话过期后，已打开的页面在通知送达时立刻回到未登录状态；通知丢失时，可见的页面在下一次身份轮询（30 秒）时发现，隐藏的页面在重新可见时发现。

### 验证码与人机验证

- Nuxt 开发模式额外接受以 `10` 开头的 11 位测试手机号。测试号码的短信发送和验证仅走开发调试流程。
- 验证码 6 位，10 分钟有效。
- 同一设备或同一手机号合并计数，按 UTC 日清零：当日第 1～6 次发送后冷却 60 秒，第 7～9 次后冷却 30 分钟，第 10 次后当日不能再发。
- 短信服务报错或超时的那一次也占用次数和冷却。
- 发验证码、密码登录、注册、验证码登录、改密码、换手机号，都要过人机验证并由服务端校验。

### 个人主页

- 所有人可见：头像、用户名、认证标记和说明、UID、注册时间、最近活跃时间、生日、在线状态、是否被封禁、权限。
- 16 秒内有过请求算在线。
- 手机号和登录记录：本人和『控制台·只读』以上可见。
- 修改入口、安全区块、登录记录里的强制退出：本人和管理员可见。
- 头像：接受 JPG、PNG、WebP，浏览器裁成 512×512 的 JPEG，不超过 1 MB。删除前二次确认。
- 换手机号：新手机号已被别的账号使用时被拒。管理员直接换时不需要验证码，但同样不能换成已被使用的号码。
- 认证说明最多 255 个字符。

### 权限与账号状态

- 权限显示在主页上，对所有人公开。
- 设为管理员时清空其权限列表，撤销管理员时不恢复。
- 管理员不能撤销自己的管理员身份，也不能封禁自己。在控制台按账号操作时可以强制自己下线；在登录记录里按设备操作时，只能强制退出当前会话以外的会话。
- 权限变更从对方的下一个请求起生效，对方页面上的入口随身份轮询或通知更新。
- 被封禁账号的主页仍可访问。

## 验收标准

LAW 只用大白话讲行为，可检验的标准放在这里。最后一列列出对应测试，剩余验收见 [AGENT 的待办](AGENT.md#待办)。

| # | 标准 | 现有测试 |
| --- | --- | --- |
| 1 | 用错误验证码注册被拒；用正确验证码注册后顶栏出现用户菜单，刷新后仍在 | `tests/e2e/accounts-lifecycle.spec.ts` |
| 2 | 手机验证码登录：错误验证码被拒，正确验证码登录，刷新后仍在 | `tests/e2e/accounts-otp.spec.ts` |
| 3 | 冷却期内再次请求验证码返回 429，发送按钮不可点 | `tests/e2e/accounts-otp.spec.ts` |
| 4 | 发送次数的分档、每日上限、设备与手机号合并计数、短信服务失败仍计数 | `server/services/auth.service.test.ts` |
| 5 | 旧密码错误时改密码被拒；改密码后旧密码登录失败，新密码登录成功 | `tests/e2e/accounts-lifecycle.spec.ts` |
| 6 | 退出登录后刷新，顶栏显示『登录 / 注册』 | `tests/e2e/accounts-lifecycle.spec.ts` |
| 7 | 被强制下线后，对方已打开的页面无需操作即回到未登录状态，其接口返回 401；通知丢失时约 30 秒内同样收敛，页面隐藏期间不轮询 | `tests/e2e/account-sync.spec.ts` |
| 8 | 权限变更后，对方已打开的页面无需刷新即出现或消失控制台入口 | `tests/e2e/account-sync.spec.ts` |
| 9 | 访客和普通用户在他人主页看不到编辑入口；直接调用接口修改他人资料分别得到 401、403 | `tests/e2e/pages-restricted.spec.ts` |
| 10 | 生日保存后刷新仍在 | `tests/e2e/accounts-lifecycle.spec.ts` |
| 11 | 头像裁剪上传后是 512×512，刷新后仍在；删除后刷新仍没有 | `tests/e2e/accounts-lifecycle.spec.ts` |
| 12 | 令牌剩余不足 7 天时自动换新，并发请求中只有一个拿到新令牌，其余请求不会被踢下线；SSR 预取请求不换新 | `server/services/auth-guards.service.test.ts`、`server/services/session.service.test.ts`（无端到端） |
| 13 | 登录、注册的响应体不含令牌，令牌 cookie 脚本不可读 | `server/services/auth.service.test.ts`、`server/lib/session.test.ts` |
| 14 | 访客和普通用户看不到他人的手机号；『控制台·只读』看得到但不能编辑；本人和管理员既能看也能改 | `server/services/profile.service.test.ts`（无端到端） |
| 15 | 更换手机号须新旧验证码都正确；新手机号已被使用时被拒 | `server/services/profile.service.test.ts` |
| 16 | 凭验证码修改密码 | `server/services/profile.service.test.ts` |
| 17 | 强制退出另一台设备后，那台设备回到未登录状态，本设备不受影响。接口拒绝强制退出操作者的当前会话 | `tests/e2e/accounts-lifecycle.spec.ts` 已验证两个独立浏览器会话，`server/services/profile.service.test.ts` 已验证普通用户和管理员均无法强退本机 |
| 18 | 本标签页退出登录后，同一浏览器的另一标签页也回到未登录状态 | `tests/e2e/accounts-lifecycle.spec.ts` 已在 Chromium 验证 |
| 19 | 封禁后对方全部设备下线且不能登录，解封后可以登录 | `server/services/admin.service.test.ts`、`auth.service.test.ts`、`auth-guards.service.test.ts`、`session.service.test.ts`、`tests/e2e/account-sync.spec.ts`（两个独立浏览器会话） |
| 20 | 管理员直接修改他人密码、手机号、生日、头像 | `server/services/profile.service.test.ts`、`app/features/account/profile.test.ts` |
| 21 | 直接调用上传接口时，超过大小上限的头像被拒（413）且不写存储和数据库，恰好等于上限的被接受 | `server/services/profile.service.test.ts` |
| 22 | 『蠢猪档案·完全』包含『机密可读』；只有『机密可读』不能通过任何档案写接口 | `server/shared/permissions.test.ts`、`server/trpc/router.test.ts`、`server/services/content/workspace-command.service.test.ts` |
| 23 | 『控制台·完全』不能授予：授权接口拒绝，已存的这一条不起作用；封禁、设管理员、改权限只有管理员能做 | `server/shared/permissions.test.ts`、`server/trpc/routers/admin.test.ts`、`server/services/auth-guards.service.test.ts` |
| 24 | 『控制台·只读』能读别人的登录记录，不能强制下线 | `server/services/profile.service.test.ts`、`server/services/auth-guards.service.test.ts`（无端到端） |
| 25 | 『控制台·只读』在用户列表里看得到手机号，也能按手机号筛选 | `server/trpc/routers/admin.test.ts`、`server/services/admin-filter.test.ts` |
| 26 | 管理员不能封禁自己 | `server/trpc/routers/admin.test.ts` |
| 27 | 注册和验证码登录先校验人机验证，再核验验证码 | `server/services/auth.service.test.ts`、`app/features/account/auth.test.ts` |
| 28 | 用户名的字符范围；纯数字用户名被拒 | `server/trpc/schemas.test.ts` |
| 29 | 已存授权记录按迁移规则转换 | [隔离 MySQL 发布专项](../../../scripts/verify/deployment.ts)已验证旧机密读权转换、控制台权限降级与档案权限合并、移除未知项、保留现行格式 |
