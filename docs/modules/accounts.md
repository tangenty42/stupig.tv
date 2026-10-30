# 账号、会话与管理权限

账号相关业务通过 `auth`、`profile`、`admin` 和 `presence` 四个 tRPC router 提供。页面使用 `useApi()` 门面，服务端以当前会话和数据库权限为准；前端隐藏或禁用按钮只提供交互提示。

## 登录与验证码

- 注册要求通过表单、验证码及用户信息校验；密码使用 bcrypt 哈希保存。
- 登录支持用户名／密码和手机号／短信验证码。验证码发送、验证和冷却由认证服务统一处理，不能由浏览器自行决定是否通过。
- 发送前使用数据库范围的短暂互斥，按设备或手机号检查冷却和 UTC 当日配额，并先持久化发送预约。互斥不覆盖短信网络调用；争抢中的请求返回 429。冷却查询返回匹配记录中的最晚截止时间。
- 短信发送失败或超时仍保留预约并消耗配额，防止供应商已经发送、客户端却因未知结果反复重试。发送预约落库失败时不调用短信服务。多实例切换时应停止旧版本的发送入口，避免旧代码绕过新互斥。
- CAPTCHA 的客户端 challenge 与服务端校验是两个环节；只完成前端控件不代表认证成功。
- `app.otp.debug` 控制是否跳过真实短信发送和核验；`app.captcha.debug` 控制 CAPTCHA 调试路径。二者仅在开发环境允许开启，生产误开会拒绝启动。CAPTCHA 上游异常按拒绝处理；环境配置、响应状态及服务接入见[短信与 CAPTCHA](../deployment/sms-captcha.md)。
- 注册、登录及验证码错误使用 `ApiError` 传递状态和用户可读信息。表单校验与完整 API 参数校验分别由共享表单 schema 和 tRPC schema 负责。

## 会话模型

JWT 是请求凭据，数据库中的登录会话和 token generation 是可撤销的事实记录。`user_login_sessions` 保存设备、登录、活动、到期及退出状态；`user_login_session_tokens` 保存每次 token generation 的哈希及有效期。

登录通过设备上下文和 identity token 建立或复用会话。刷新会话时滑动更新会话有效期，按配置保留有限数量的 token generations。并发请求不要求同时换到最新一枚 token；旧 generation 在仍被保留且未到期时可以完成请求。

登出、踢下线、封禁等操作修改服务端事实。读取机密附件时，边缘授权回调也会检查会话、generation、封禁和权限，不能仅凭一个未过期的签名绕过撤权。详细读取规则见 [Content 访问控制](content/access.md)。

`last_login_at`、`last_seen_at` 与在线状态从会话记录计算，不写回 `users` 作为另一套活动事实。时间统一按 UTC 存储，在展示层转换时区。在线状态会随时间自然变化，相关页面保留[实时同步](realtime.md)中的可见页面轮询补偿。

## 权限

权限定义的唯一入口是 [`server/shared/permissions.ts`](../../server/shared/permissions.ts)。新用户默认没有额外权限；`is_admin` 覆盖全部权限。普通授权按同一字段的等级比较，高等级包含低等级。

| 权限 | 等级 | 业务范围 |
| --- | --- | --- |
| `admin_access` | `readonly` | 读取控制台、允许的用户私密资料和后台状态 |
| `admin_access` | `full` | 用户管理与代操作 |
| `content_manage` | `full` | 创建、编辑、删除档案及管理附件 |
| `content_private` | `read` | 读取机密正文及机密附件 |

Content 管理与机密读取是独立权限。服务端在敏感附件操作内部再次读取操作者权限，包括幂等请求回执重放，避免只凭进入页面时的权限执行后续操作。

共享云端草稿的列表、正文、占用和全部命令要求两项权限同时满足，避免未闭合机密标记的原始输入泄漏。草稿事务取得内容锁后，锁定读取当前用户、会话及请求实际携带的 token generation；退出、撤权或 session row 复用不会使排队旧请求重新有效。客户端换号时清空文本、恢复区与编辑器 undo。草稿 MQTT 的短期订阅凭据最多 30 秒失效，API 授权不等待该通知或断线，见[草稿手册](content/drafts.md)。

## 用户资料与控制台

用户主页提供公开资料，手机号等私密字段由服务端按访问者权限投影。资料、会话列表及部分操作通过 `operate_for` 表达代操作目标；省略时操作自己，指定他人时由 `resolve_operate_target()` 验证相应权限。重置他人密码和设置他人手机号有独立的完全管理权限入口。

控制台提供用户过滤、封禁／解封、强制退出、认证标记、管理员角色及细分权限管理。用户列表筛选支持限定字段与关键字，业务服务负责解析和白名单校验，不提供任意 SQL 执行能力。

头像选图不按原文件字节数限制；浏览器将选定区域裁成 512×512 JPEG，并在上传前检查裁剪结果的大小。服务端仍按配置限制上传的头像大小。头像通过阿里云 OSS 写入本环境桶的 `avatar/`，经 ESA 公开读取；新上传使用不可变 key，替换及删除旧头像使用版本化删除。不使用 Content 的原图／AVIF／删减版模型，见 [OSS 静态资源](../deployment/oss.md)。

## 源码与验证

- API：[`server/trpc/routers/`](../../server/trpc/routers/)、[`server/trpc/schemas.ts`](../../server/trpc/schemas.ts)。
- 业务：[`auth.service.ts`](../../server/services/auth.service.ts)、[`session.service.ts`](../../server/services/session.service.ts)、[`profile.service.ts`](../../server/services/profile.service.ts)、[`admin.service.ts`](../../server/services/admin.service.ts)、[`auth-guards.service.ts`](../../server/services/auth-guards.service.ts)。
- 会话与同步：[`server/lib/session.ts`](../../server/lib/session.ts)、[`app/composables/useAuth.ts`](../../app/composables/useAuth.ts)。
- 自动验证使用同目录的服务测试，重点检查权限、会话撤销、私密字段投影、管理员代操作和同步副作用。浏览器验收包含登录／退出、多标签会话变化和权限切换；测试账号和真实短信限制见[开发测试](../development/testing.md)。
