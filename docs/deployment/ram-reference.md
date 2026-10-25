# RAM 策略范围与依据

实际配置按[操作清单](ram.md)；本页用于审阅权限，不是要求逐项手动勾选的第二套步骤。策略文件只授予当前运行或交付所用动作，云端应用和读回状态见[台账](aliyun.md#ram-与-acr-的收敛)。

## OSS 应用

[dev](../../config/ram/stupig-oss-app-dev-access.json) / [prod](../../config/ram/stupig-oss-app-prod-access.json) 只在桶名上不同：

| 范围 | 动作 |
| --- | --- |
| 目标桶 `content/att/*` | GetObject、PutObject、Get/PutObjectAcl、DeleteObject、ListParts、AbortMultipartUpload |
| 目标桶 `imgs/*`、`avatar/*` | GetObject、PutObject、Get/PutObjectAcl、DeleteObject；只操作本环境前缀 |
| 目标桶 | ListMultipartUploads、GetBucketVersioning |
| 目标桶清单 | ListObjects，仅供全桶元数据对账；不授予未知前缀的对象内容读取 |
| 显式拒绝 | 非 TLS、Content 的 public-read/public-read-write ACL、DeleteObjectVersion 永久删版本 |

不允许任意列举桶对象、改桶配置或操作另一个环境。软删除保留版本，生命周期的清理责任另见 [OSS](oss.md)。普通分片请求可能没有 ACL header，策略不要求每片都带 private，初始化/完成和精确签名由后端控制。依据：[OSS RAM Policy](https://help.aliyun.com/zh/oss/user-guide/ram-policy/)。

日常运行已不使用旧 Rains S3 凭据。历史恢复所需的 `OSS_PUBLIC_*` / `OSS_PRIVATE_*` 仅保留在受保护的备份，本账号 RAM 策略不能授予另一个提供方的访问能力。两份 OSS 策略的 v2 已增加精确 `imgs/*` 与 `avatar/*` 对象操作；需要永久删除历史版本等恢复维护能力时，单独授权维护身份，不扩入应用策略。

## ESA 缓存维护

[策略](../../config/ram/stupig-esa-cache-access.json)包含 PurgeCaches、DescribePurgeTasks、PreloadCaches、DescribePreloadTasks、GetPurgeQuota、GetTieredCache，资源固定为 `acs:esa:cn-hangzhou:1225000469589595:site/181553031729356`。没有修改规则、函数或 DNS 的能力。

站点内所有域名共用这个范围，包括其他项目；独立 dev/prod 用户用于凭据生命周期管理，不保证 host 隔离。应用的预算也不能代替云端额度。依据：[刷新](https://help.aliyun.com/zh/edge-security-acceleration/esa/api-esa-2024-09-10-purgecaches)、[预热](https://help.aliyun.com/zh/edge-security-acceleration/esa/api-esa-2024-09-10-preloadcaches)、[额度](https://help.aliyun.com/zh/edge-security-acceleration/esa/api-esa-2024-09-10-getpurgequota)、[层级](https://help.aliyun.com/zh/edge-security-acceleration/esa/api-esa-2024-09-10-gettieredcache)。

`pnpm content:preload:check --env=prod --policy` 可按当前配置打印策略草案；它使用账号通配符，本目录的可审阅版本进一步固定账号。该分支仍需完整应用配置，不作为 RAM 初始化的前置步骤。

## ESA 发布

[策略](../../config/ram/stupig-esa-publish-access.json)供锁定官方 CLI 与仓库发布编排使用，允许：

- GetErService、GetRoutine、ListRoutineEnvironmentVariables、SetRoutineEnvironmentVariables。
- CreateRoutineWithAssetsCodeVersion、GetRoutineCodeVersionInfo、ListRoutineCodeVersions、CreateRoutineCodeDeployment。
- ListRoutineRoutes，仅检查路由。

Resource `*` 对应接口支持的账号级范围，不能发明函数名 ARN 来声称隔离。依据：[GetRoutine](https://help.aliyun.com/zh/edge-security-acceleration/esa/api-esa-2024-09-10-getroutine)、[变量写入](https://help.aliyun.com/zh/edge-security-acceleration/esa/api-esa-2024-09-10-setroutineenvironmentvariables)、[路由列表](https://help.aliyun.com/zh/edge-security-acceleration/esa/api-esa-2024-09-10-listroutineroutes)。

策略没有 CreateRoutine、路由写入、删除函数或整站管理动作。dev/prod 两个发布用户绑定同一份策略，但都有账号级发布影响范围；目标保护来自[发布工具](esa-functions.md)，不能当作 RAM 隔离。

## 短信与图形验证

[短信策略](../../config/ram/stupig-sms-access.json)仅包含 `dypns:SendSmsVerifyCode` 和 `dypns:CheckSmsVerifyCode`。这是号码认证 PNVS/DYPNS，不是 Dysms SendSms；不授予产品管理权限。官方两动作均使用 Resource `*`，不支持按模板或 scheme 构造自定义 ARN。[发送依据](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-dir-sms-authentication-service/)、[核验依据](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-checksmsverifycode)。

当前图形验证使用产品 appKey 的 HMAC 二次核验，不调用 RAM OpenAPI，因此不另建 CAPTCHA RAM 策略。产品开通、签名/模板/方案与域名设置见[短信及图形验证](sms-captcha.md)。

## ACR 个人版

[push](../../config/ram/stupig-acr-push-access.json)允许 PushRepository + PullRepository；[pull](../../config/ram/stupig-acr-pull-access.json)只允许 PullRepository。资源都限制到 `acs:cr:cn-guangzhou:1225000469589595:repository/tangenty42/stupig-tv`。

上述两份策略及用户保留备用，当前交付不使用它们。按用户决定，CI 与服务器恢复共用 Tangenty 现有的 Registry 固定密码，均读取 GitHub `ACR_USERNAME/PASSWORD`，不调用企业版 GetAuthorizationToken。[个人版推拉](https://help.aliyun.com/zh/acr/user-guide/use-a-container-registry-personal-edition-instance-to-push-and-pull-images)、[仓库授权](https://help.aliyun.com/zh/acr/user-guide/repository-access-control)。

新个人版仅允许一个 RAM 子账号设置 Registry 密码，不能直接采用双 RAM 推拉方案。排查时额外创建的控制台初始化策略已从两个用户解绑并删除，原有仓库策略不变；实际 GitHub 凭据及 Docker 推拉仍待验收，见[推拉身份](github-acr.md#推拉身份)。

## 云端资源初始化与角色

RAM 用户/策略、OSS 桶、ESA 函数/路由/规则、PNVS 产品开通，由获授权管理员通过控制台准备。日常身份不需要 AdministratorAccess 或产品 FullAccess。

ESA 私有 OSS 回源沿用产品授权的服务角色。不要手工给应用增加 AssumeRole，也不要把长期 AccessKey 下发浏览器；当前浏览器只获取精确分片签名 URL，不需要另建上传角色。旧上传角色已按授权清理，ESA 系统回源角色保留；后续若引入 STS，应作为独立功能设计。

## 验收与轮换

修改策略后读回云端配置，并用实际身份验证目标操作及越界拒绝，不要用超时当拒绝通过。轮换时协调应用、worker、GitHub 及函数变量的新版本；新消费者确认成功后再撤销旧凭据。审计状态只保留在[云端台账](aliyun.md)，避免操作清单夹杂过期快照。

## 凭据交付边界

目前发布与应用共用 `.env.prod`，工作流解密后把它送到服务器，Compose 用 `env_file` 全量注入。`esaFunction` 不进入应用配置 schema，不等于它的环境变量没有进入容器。要让应用不持有发布凭据，需要另行拆分工具环境或收窄 Compose 注入字段，同时保持 CI 预检/发布与加密交付一致；本轮未修改交付实现。对运维工具按用途创建用户是第一步，不代表已经完成进程间凭据隔离。
