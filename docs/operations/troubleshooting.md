# 故障排查

先定位失败层：应用进程、数据库／迁移、授权回调、对象存储、ESA 交付、后台扫描或浏览器状态。保留时间、动作、身份类别、请求 ID、安全错误码及状态变化；不要分享 token、完整签名 URL、请求正文或原始 SDK 凭据。

## 开发启动

| 症状 | 检查与处理 |
| --- | --- |
| `APP_PORT` 已占用 | 确认原终端和监听进程。复用已有应用时只补 `dev:tunnel`；不要启动第二套或让端口自动漂移 |
| 55500 被占用 | 查看是否为带 `X-Dev-Auth-Proxy: 1` 的已知代理。未知进程由操作者核实后处理，启动器不会接管 |
| frpc 不能执行／版本不符 | 核对 `devAuthTunnel.frp.executable`、版本 0.71.0 和操作系统实际错误；不通过关闭防护或跳过 TLS 校验解决 |
| Docker 依赖未启动 | `docker compose --env-file .env.dev -f docker-compose.dev.yml ps` 并检查对应服务日志；Compose 失败时组合入口不会继续启动应用 |
| `.env.dev` / `.env.prod` 仍有 `<required>` | 重跑对应环境生成命令或在目标文件补齐，然后重新加载进程 |
| 修改 MySQL／MQTT 密码后认证失败 | 环境值变化不保证现有数据库或 broker 账号被同步修改，核对真实账号；不要删除卷重建来掩盖差异 |

`NODE_ENV` 只能是 development 或 production，分别选择 `.env.dev` / `.env.prod` 和对应 YAML。工具可以用 `--env=prod` 明确选择生产；旧 `.env` 不再加载。进程变量优先于文件，遇到意外连接目标或 GPG 口令不一致时先核对终端继承的同名变量。

手动执行开发 Compose 的 `ps`、`logs`、`up` 等命令时都显式传 `--env-file .env.dev`；生产编排使用 `docker compose --env-file .env.prod -f docker-compose.yml …`。Compose 的 `${…}` 插值需要该环境文件，服务内的 `env_file` 不能代替命令行插值来源。

## 迁移与健康检查

`/healthz` 查询 `migration_runs` 的 completed 记录，数据库不可用或账本查询失败时返回 503。它不验证所有 OSS 对象、所有待执行版本、ESA 回调或 MQTT 消费健康；首页 200 的覆盖范围更小。

| 错误／状态 | 下一步 |
| --- | --- |
| `maintenance_required` | 停止业务写入、完成备份后使用维护入口；不是删除门禁 |
| `blocked_by` | 前序 schema／脚本未完成，按顺序阶段执行后重新预演 |
| checksum／artifact 不匹配 | 对照冻结摘要和产物；恢复历史字节，修复追加新迁移 |
| `lock_busy` | 查明另一执行者，不删锁或并行启动更多迁移 |
| SQL running／failed | 核对已落地 DDL，确认可重入后精确 `--retry-sql` |
| TS verify 失败 | 检查业务结果及回执，重跑只验证，不删除账本重做 apply |
| 旧 `schema_migrations` 再出现 | 查明是否启动了旧版本，核对账本协议，禁止自动重新 baseline |

恢复步骤见[迁移手册](./migrations.md)和 [Content 切换](./content-cutover.md)。2026-10-25 的回执记录生产 Content 已完成副本预演和正式迁移；后续版本仍须独立核对迁移链与发布回执，不能把新镜像重启成功当成切换验收。截至 2026-11-01 的生产发布信息与核验边界见[云端台账](../deployment/aliyun.md#截至-2026-11-01-的发布信息)。

## 授权回调和 ESA

按[隧道连接图](../development/auth-tunnel.md)逐段检查：本机应用 → 本机授权代理 → frpc 注册 → 公网回调 → ESA 函数变量／路由 → 原生缓存与 OSS。

- 回调域名根路径返回 404 是有意限制；空 JSON 授权返回 403 也是预期拒绝路径。二者都不证明合法授权成功。
- frpc running、WebSocket 101 只说明局部进程或通道条件，继续核对代理注册和回调响应。
- 合法授权应验证状态与 HMAC；再验 GET/HEAD/Range 及完整文件大小和摘要。
- 回调 URL 统一在环境 YAML 的 `esaFunction.callbackUrl` 修改，再运行 `pnpm esa:deploy:dev` / `pnpm esa:deploy:prod`；先用 `--plan` 看目标、`--check` 只读核查。失败阶段和脱敏记录位于 `.data/esa-deploy/`，不要直接粘贴 SDK 原始异常。
- 当前读取每次经过在线授权，回调故障会拒绝交付。不要为了恢复可用性改为缓存成功授权或只验证旧签名。
- 缓存 HIT 后拒绝旧 URL 属于业务撤权；对象删除和缓存刷新是后续物理清理，二者分开检查。

历史曾遇到 ESA 旁路与 URI 路径匹配／响应头规则组合异常。新的诊断必须记录当前发布版本、规则表达式、优先级、缓存状态和相同对象的对照结果。不能将旧工单的 URI 规避写法视作所有环境已验证的默认规则，也不能凭单次成功宣布云端问题已修复。现行配置及待核对项见 [ESA](../deployment/esa.md)。

## OSS 上传与图片

| 症状 | 检查范围 |
| --- | --- |
| AccessDenied | 先区分应用 RAM、分片签名上传、对象读取或 ESA 回源失败；核对桶／地域／Action，不混用凭据。当前上传不调用 AssumeRole |
| 浏览器上传失败但服务端探测正常 | 检查上传会话与分片签名有效期、MD5／分片身份、CORS 的 origin／方法／请求头及响应头暴露 |
| 网络断开后完成结果不明 | 保留会话和精确对象身份，让生命周期／对账处理；不要重复创建同目标或删除未知 multipart |
| 图片格式／像素预算拒绝 | 核对实际字节、静态处理白名单、预算和错误码。GIF/SVG 等应按原样附件路径判断，不能只看后缀 |
| 上传成功但列表／正文未同步 | 检查 publication 回执、workspace revision、引用桥接及通知 outbox；不要仅凭对象存在判定业务提交完成 |
| 删除后仍有历史版本 | 当前版本删除与历史永久清除不同，检查版本控制、生命周期及退役账本 |

具体合同见[上传](../modules/content/uploads.md)、[权限](../modules/content/access.md)与[对象生命周期](../modules/content/object-lifecycle.md)。

## 后台任务与实时同步

先运行 `pnpm background:status` 读取持久状态，再结合运行进程日志和管理员状态接口确认扫描。CLI 没有应用进程内存快照，`process: null` 正常；某个应用的扫描状态也不是整个集群状态。

- mode=worker 时应用不消费后台工作，必须有独立 worker；disabled 保留待办但不扫描。
- 检查有效租约、到期候选、重试时间、最老待办和资源槽，不手工把 running 改 pending。
- 预热暂停可能来自开关、交付未验证、额度预算或云端状态；区分预热与刷新权限。
- Content 通知经过事务 outbox 和 MQTT ACK；broker 暂时不可用时保留重试。普通页面重载不能证明 outbox 已清空。
- 浏览器仅活动标签维护连接，其他标签通过 BroadcastChannel 接收；登录身份变化和 SSR hydration 的状态交接也要纳入检查。

详见[后台工作](../modules/background-jobs.md)、[实时同步](../modules/realtime.md)及 [EMQX 部署](../deployment/mqtt.md)。
