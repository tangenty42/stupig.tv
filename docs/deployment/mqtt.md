# EMQX 生产配置与权限验收

当前浏览器匿名连接 WS/WSS，只订阅刷新事件；服务端用用户名/密码连接内网 TCP，发布刷新事件。消息不是业务数据源，客户端收到后通过 API 重新授权、读取数据，协议见[实时同步](../modules/realtime.md)。

事实源：[生产 Compose](../../docker-compose.yml)、[Dockerfile](../../Dockerfile)、[生产初始化](../../scripts/deploy/emqx-entrypoint.sh)、[共享账号初始化](../../scripts/dev/emqx-entrypoint.sh)、[ACL](../../emqx-acl.conf)、[服务端 MQTT](../../server/lib/mqtt.ts)、[浏览器连接](../../app/composables/useDataSync.ts)。

生产 EMQX **6.2.2** 由本项目 Compose 管理，与应用分容器、同批部署；MySQL 和 Redis 继续使用外部网络中的实例。账号初始化、认证器、listener、ACL 和健康检查自动交付，只需手动配置 HTTPS/WSS 反代。生产旧 1Panel 实例不由部署脚本停止、修改或删除。本地验收不代替生产验收。

## 6.2.2 版本基线与默认值

| 项目 | 6.2.2 已核对行为 | 本项目配置 |
| --- | --- | --- |
| listener `enable_authn` | 默认 true；支持 false、quick_deny_anonymous | TCP true，浏览器实际接入的 WS/WSS false |
| `authorization.no_match` | 默认 deny；5.x 默认值不同 | 仍显式设 deny，不依赖升级后的默认值 |
| `authorization.deny_action` | 默认 ignore | 显式设 disconnect，否则拒绝操作后不一定断开连接 |
| superuser | 认证成功后绕过 topic 授权 | 仅专用 broker 的服务端发布账号使用 |
| 文件授权 | 仍按顺序匹配；前置 Allow 可直接放行 | 替换默认示例，最后 `{deny, all}`；默认 no_match=deny 不会否定已经命中的 Allow |
| 外部资源节点缓存 | 认证和授权的 node_cache 默认启用 | 内置数据库认证、File 授权不使用这层外部缓存；仍需处理客户端授权缓存 |
| 配置覆盖 | 环境变量优先于 emqx.conf 和运行期配置 | Dashboard 保存后仍需读回、重启验证 |

字段、枚举和默认值以[官方 6.2.2 配置手册](https://docs.emqx.com/en/enterprise/v6.2.2/hocon/)为准；权限和缓存语义见 [v6.2 授权说明](https://docs.emqx.com/en/emqx/v6.2/access-control/authz/authz.html)。当前 `latest` 文档还包含更晚版本行为，不把 `EMQX_SECURITY_PROFILE` 等后续配置当成 6.2.2 已启用的安全保障，也不因为数字以 6 开头就复制整个最新版配置。

## 先分清三种账号与两道检查

| 项目 | 用途 | 配置位置 |
| --- | --- | --- |
| Dashboard 用户 | 管理 EMQX 控制台 | System / Users；不是应用发布账号 |
| MQTT 用户 | CONNECT 时认证服务端发布者 | Access Control / Authentication 的内置数据库用户管理；对应 `.env.prod` 的 `MQTT_USERNAME/PASSWORD` |
| REST API Key / Secret | 管理 API 身份 | Dashboard 的 API Keys；不是 MQTT 用户名/密码 |
| Authentication（认证） | 是否允许建立 MQTT 连接、身份是什么 | 认证链 + 实际接入 listener 的 `enable_authn` |
| Authorization（授权） | 是否允许发布/订阅某个 topic | superuser 属性、认证附带权限、授权源/ACL、缓存 |

`is_superuser=true` 指 MQTT 用户绕过全部 topic 授权检查，不是授予 Dashboard 管理员。认证通过也不自动拥有发布权；WebSocket HTTP 101 只表示升级成功，后续还有 MQTT CONNECT 和 SUBSCRIBE。[官方认证用户管理](https://docs.emqx.com/en/emqx/v6.2/dashboard/authn.html)、[授权优先级](https://docs.emqx.com/en/emqx/v6.2/access-control/authz/authz.html#authorization-check-priority)。

## 项目需要的权限矩阵

| 连接 | 认证 | 订阅 `stupig/sync/#` | 发布 | 其他主题 |
| --- | --- | --- | --- | --- |
| 浏览器实际接入的 WS/WSS listener | `enable_authn=false` | 允许 | 全部拒绝 | 拒绝 |
| 服务端 TCP，正确发布账号 | `enable_authn=true`，内置数据库验证成功 | 当前 superuser 可订阅 | 允许 | 当前 superuser 也可访问；仅用于本应用专用 broker |
| TCP，无凭据或错误密码 | 拒绝连接 | 不适用 | 不适用 | 不适用 |

当前 topic 前缀由 [`config/app-settings.yaml`](../../config/app-settings.yaml) 的 `integrations.mqtt.topicPrefix=stupig/sync` 提供；实际主题是 `stupig/sync/<resource>`，例如 `content_story:<id>`。修改前缀必须同步 ACL，不存在 `MQTT_TOPIC_PREFIX` env 覆盖。

浏览器没有 MQTT 密码，也不按站点登录身份划分 topic 权限。匿名订阅者可以观察这些刷新通知及其中的资源标识；消息中不能加入正文、敏感用户数据、机密对象 URL 或凭据。API 权限仍由应用判断。

**`web_` / `server_` 只是客户端 ID 命名习惯，不是可信身份。** 不能靠前缀授予发布权。尤其不能在匿名 WS 上只用 `{username, "发布账号"}` 放行：用户名也可由客户端自行填写。本方案的发布权来自 TCP 上的真实认证结果，WS 跳过认证后保持非 superuser。

## 自动构建与部署

Check 的 `mqtt` 作业构建 Dockerfile 的 `mqtt` 目标，并运行[真实集成测试](../../scripts/deploy/emqx.integration.test.ts)。测试使用随机 Compose 项目、临时账号和卷，不连接生产；覆盖账号初始化、实际收发、拒绝矩阵、失效凭据健康检查及重启后账号可用，结束时清理自己的资源。

main 的 Check 全部成功后，[Deploy](../../.github/workflows/deploy.yml) 构建并推送 `${ACR_IMAGE}:latest`（应用）和 `${ACR_IMAGE}:mqtt`（broker），上传 Compose 与解密后的 `.env.prod`，由[远端脚本](../../scripts/deploy/remote.sh)拉取、启动并检查两个服务。镜像包含 ACL、初始化和健康检查脚本；密码只在运行时注入，不进入镜像。

首次启动从 `MQTT_USERNAME/PASSWORD` 创建内置数据库超级发布账号。认证器、TCP/WS 开关、唯一 File 授权源及 deny/disconnect 策略由 Compose 环境变量统一管理，不需要进 Dashboard 配置。不要再通过 Dashboard 改同一批字段；当前 HTTP Dashboard、SSL 和 WSS listener 均关闭。

应用等待 broker 的凭据健康检查通过后才启动。已有托管部署失败时脚本恢复两个旧镜像及旧配置；首次引入 broker 失败时只移除本次新增容器，保留卷，不碰旧 1Panel 实例。此回滚不恢复数据库迁移，也不修改外部反代；回滚失败会报告需要人工介入。

### 网络与持久化

```text
应用容器 -> 项目 mqtt bridge -> emqx:1883（需要发布凭据）
浏览器 -> WSS 443 -> HTTPS 反代 -> 宿主机 127.0.0.1:8085 -> emqx:8083
```

broker 只加入项目专用 `mqtt` bridge，不加入 MySQL/Redis 的外部网络；应用同时加入两个网络。TCP 1883、Dashboard、SSL/WSS 不映射宿主机，WS 只映射回环 `${MQTT_WS_PORT:-8085}`。这是普通 bridge，不承诺阻断 broker 出站流量；不能设置 `internal: true` 后仍假定宿主机端口可正常发布。

`mqtt-data` 和 `mqtt-log` 命名卷保存数据和日志；节点名固定为 `stupig@127.0.0.1`。不要使用 `down -v`、清空 Mnesia、修改节点名或换空卷排除故障。备份数据时保留节点身份，并在隔离副本验证恢复；旧 1Panel 节点的数据不直接挂到新节点上。[官方备份恢复](https://docs.emqx.com/en/emqx/v6.2/operations/backup-restore.html)。

### 首次从 1Panel 切换

用户提供的旧实例为专用 `1panel-EMQX`、镜像 `emqx/emqx:6.2.2`、尚无认证器，反代域名为 `mqtt.stupig.tv`。这些不是已经在生产读回的验收结果。

1. 在维护窗口前保存旧 Compose、数据备份与反代配置。确认 `.env.prod` 已有强 `MQTT_USERNAME/PASSWORD`，`MQTT_WEB_URL=wss://mqtt.stupig.tv/mqtt`；`MQTT_WS_PORT` 选择空闲宿主机端口，建议 8085，避开旧实例的 8083。旧加密文件若没有这个变量，Compose 使用 8085；若已有 8083，必须先改为空闲端口并重新加密。
2. 通过 PR、Check 和部署流程启动新 broker。应用的 Compose 显式覆盖 `MQTT_HOST=emqx`、`MQTT_TCP_PORT=1883`，不会继续使用旧外部 broker 地址。确认两个服务均健康。
3. 手动把反代 `/mqtt` 切到新 WS 上游。此时浏览器和应用才会使用同一个新 broker；部署完成到反代切换之间允许短暂通知中断，需安排维护窗口。不要把应用健康当作 WSS 切换完成。
4. 完成本页[上线验收表](#上线验收表)，包括公网真实收发、拒绝和应用跨标签同步。确认 Content outbox 恢复派发；业务数据源仍是 API/数据库，不迁移旧 MQTT 会话或 retained 消息。
5. 验收通过后，在 1Panel 手动停止旧 broker，保留旧数据和配置到回滚窗口结束。自动部署不停止、删除旧容器或其挂载。

若切换后需要退回旧架构，需同时恢复匹配的应用版本、Compose/env 和反代上游，不能只把反代指回旧 broker。不要为恢复而清空新旧数据卷。

## 凭据与配置维护

bootstrap **只初始化，不覆盖已存在用户**。改 `.env.prod` 后重启不等于轮换 Mnesia 密码，健康检查会拒绝与内置库不匹配的凭据。当前不是自动改密或通用用户管理工具。

轮换前保留旧发布账号：通过受控管理 CLI/API 创建第二个超级发布账号，在内网验证后更新应用与 broker 的 `MQTT_USERNAME/PASSWORD`、重新加密生产环境并部署。确认新连接发布和健康检查成功后，再撤销旧账号并让旧连接断开。Dashboard 默认不开放，不要为省事把 18083 映射公网。账号管理操作须先在隔离实例验证，不打印或提交密码。

诊断使用生产部署目录中的同一份 Compose/env，通过包装入口运行 CLI，以使用一致的节点 Cookie：

```sh
docker compose --env-file .env.prod ps
docker compose --env-file .env.prod logs --tail 80 emqx
docker compose --env-file .env.prod exec emqx /bin/sh /opt/emqx/etc/production-entrypoint.sh --cli ctl status
docker compose --env-file .env.prod exec emqx /bin/sh /opt/emqx/etc/production-entrypoint.sh --cli ctl conf show authorization
```

完整认证配置和引导文件只在服务器本地查看，不能分享其中的凭据。配置、ACL 改动走仓库和新镜像；用户权限变化需断开旧连接后重新验收。应用通过可信 Docker 网络使用明文 MQTT TCP，单改端口为 8883 不会启用 TLS，不要跨不可信网络直接使用。

## WSS 反代与应用参数

应用 TCP 地址由生产 Compose 固定为 `emqx:1883`；`MQTT_WEB_URL` 是浏览器访问的完整 URL，例如 `wss://mqtt.stupig.tv/mqtt`。以下上游默认使用宿主机回环的 8085，与 `MQTT_WS_PORT` 保持一致。

以下合并到实际 HTTPS server，upstream 按反代所在网络替换：

```nginx
location /mqtt {
    proxy_pass http://127.0.0.1:8085;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

**先确认反代的网络模式。** 宿主机进程或 host 网络反代可以使用上述回环上游；bridge 容器里的 `127.0.0.1` 是反代自身，且只接入旧外部网络的反代不能解析新 broker 的 `emqx` 服务名。此时需要单独规划反代到项目网络的接入或宿主机代理，不能直接复制示例或把 TCP/Dashboard 一并暴露；本次没有替生产更改该网络。

保持 MQTT 子协议和 `/mqtt` 路径，不缓存升级请求；不要加需要登录或浏览器挑战的网关。公网只开放 HTTPS/WSS。浏览器业务登录令牌不参与 broker 认证。[Nginx WebSocket 官方说明](https://nginx.org/en/docs/http/websocket.html)。

## 上线验收表

用随机、无业务含义的测试主题，例如 `stupig/sync/__permission_probe_<random>`。测试消息不 retain，不对真实资源发送伪造刷新或修改正文。测试结束主动关闭连接。外网无法到达 TCP 不能算『TCP 认证拒绝』，认证测试应从获准内网执行。

| 测试 | 必须观察到的结果 |
| --- | --- |
| 匿名浏览器 WS/WSS CONNECT + 订阅测试主题 | MQTT 连接和订阅成功，不仅是 HTTP 101 |
| 正确生产账号从 TCP 发布 QoS 1 | 发布成功，订阅者确实收到对应随机消息 |
| 匿名 WS 发布 | broker 拒绝，订阅者没有收到，按配置断开 |
| WS 填发布用户名、错误密码、`server_*` Client ID | 可按匿名方式连接，仍不能发布 |
| WS 填正确发布凭据 | 仍不能发布；WS 的跳过认证不会授予 superuser |
| WS 订阅其他前缀、`#`、`$SYS/#` | 拒绝并断开 |
| TCP 不填凭据 / 错误密码 | MQTT CONNECT 被拒绝，broker 有相应认证结果 |
| 修改配置后重连、broker 重启后再测 | 权限矩阵保持一致 |
| 应用实际行为 | 登录/退出、权限和 Content 修改在相关页面/标签触发重读；Content outbox 恢复派发 |

MQTT 5 可以观察 Not authorized（135）、Bad User Name or Password（134）等原因；本应用 MQTT.js 默认 MQTT 3.1.1，不能要求它返回 MQTT 5 原因码。以 broker 拒绝记录、连接状态、SUBACK 和实际接收共同判断，不能仅凭 publish 回调未报错宣称授权成功。

本次本地验收：从 5.10.5 停机备份并升级到 6.2.2，保留原卷与节点，读回认证、listener、ACL 和 durable_sessions 状态；MQTT 3.1.1 与 MQTT 5 各 10 项连接/收发/拒绝测试全部通过。没有生产 WSS 验收，证据范围不能扩展为『生产权限已配置』。本机升级与备份说明见[本地开发](../development/README.md#emqx-版本与升级)。broker 中断后 Content outbox 会保留重试，恢复后检查[后台任务](../modules/background-jobs.md)，不要清空积压掩盖问题。

## 常见故障定位

| 现象 | 优先检查 |
| --- | --- |
| 浏览器 MQTT 连接被要求密码 | 反代究竟到 WS 还是 WSS，实际 listener 的 enable_authn 是否为 false |
| 匿名 TCP 也能连接 | 实际接入 listener 的认证开关、认证器是否启用、是否查错认证链，不能只看 no_match=deny |
| 应用认证成功却不能发布 | 真实 MQTT 用户是否 superuser、是否仍为改权限前的旧连接、是否连错 broker |
| WS 伪造用户名就能发布 | 删除以客户端可控 username/client ID 直接授予发布的规则，核对前置授权源和认证附带权限 |
| 订阅成功但无通知 | topicPrefix、实际业务资源主题、服务端 TCP 发布、反代超时与 outbox 积压 |
| 手动修改配置后重启回退 | Compose 的 EMQX_* 是声明配置来源，不通过 Dashboard 重复管理 |
| 修改挂载 ACL 后无效果 | 实际 sources.path 是否已切到 data/authz/acl.conf，是否清缓存并重连 |
| 改 .env.prod 后密码仍不对 | 应用已重启、broker 内置库用户是否同步轮换；bootstrap 不覆盖旧用户 |

## 共享 broker 不能直接套用全局规则

仓库两条 ACL 和 superuser 发布账号以专用 broker 为前提。若生产 EMQX 与其他站点共用：

- 全局 `{deny, all}` 可能阻断其他业务；全局匿名订阅允许也会对其他连接开放本应用通知。
- superuser 可读写所有业务 topic，不能声称已经实现按项目最小权限。
- 应使用本应用专用发布/浏览器 listener，将发布者改为非 superuser，按 **已认证 listener + 真实用户名 + topic** 联合授权，并审查整条授权源链与其他项目规则。
- 匿名 WS 上单独匹配发布用户名仍不安全。不能把它当成共享环境的简化方案。

5.10.5 的 ACL 已支持 listener 条件，依据[固定版本规则实现](https://github.com/emqx/emqx/blob/e5.10.5/apps/emqx_auth/src/emqx_authz/emqx_authz_rule.erl)。具体共享配置必须结合实际 listener ID、其他项目认证链与规则设计并完整验收；本轮没有替生产更换模型。若没有共享要求，保持专用 broker 能减少这些交叉影响。
