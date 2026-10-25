# EMQX 生产配置与权限验收

当前浏览器匿名连接 WS/WSS，只订阅刷新事件；服务端用用户名/密码连接内网 TCP，发布刷新事件。消息不是业务数据源，客户端收到后通过 API 重新授权、读取数据，协议见[实时同步](../modules/realtime.md)。

事实源：[ACL](../../emqx-acl.conf)、[开发初始化](../../scripts/dev/emqx-entrypoint.sh)、[开发 Compose](../../docker-compose.dev.yml)、[服务端 MQTT](../../server/lib/mqtt.ts)、[浏览器连接](../../app/composables/useDataSync.ts)。

2026-10-24 用户确认生产版本为 **EMQX 6.2.2**；本地也已升级并固定 `emqx/emqx:6.2.2`，保留原数据卷、日志卷与节点身份。本页已对照官方 **v6.2 文档与 6.2.2 配置 schema**，权限矩阵已在本地 6.2.2 复测。**尚未读取生产 broker 的有效配置、账号和共享情况**，本地验收不代替生产验收。

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

## 专用 broker 的配置步骤

以下与仓库现行方案一致；如果 broker 还服务其他项目，先看[共享 broker](#共享-broker-不能直接套用全局规则)，不要覆盖其认证链或全局 ACL。

### 1. 确定配置由哪里管理

先备份现有 EMQX 数据、认证用户、认证/授权链、listener 和反代设置。在 1Panel 查看实际镜像标签、挂载路径、环境变量及网络；应用的 `.env.prod` 不会替外部 EMQX 创建账号或设置 ACL。

建议 listener/ACL 由挂载配置维护，MQTT 用户通过 Dashboard 的内置数据库维护。也可以全用 Dashboard，但同一字段只选一处长期维护。本地和生产的 6.2.2 配置优先级为：

```text
base.hocon < data/configs/cluster.hocon < etc/emqx.conf < EMQX_* 环境变量
```

Dashboard/API/CLI 的运行期修改会持久化到 `cluster.hocon`；若 1Panel 环境变量或 `emqx.conf` 还有旧值，重启可能恢复旧行为。不要只看保存提示，必须读回并重启验收。[官方配置覆盖规则](https://docs.emqx.com/en/emqx/v6.2/configuration/configuration.html#config-override-rules)。

### 2. 建立发布认证器及账号

在 Dashboard 的 **Access Control → Authentication**：

1. 若已有 Password-Based / Built-in Database，先检查其配置和用户，不重复创建或删除认证器。
2. 新建时选择 **Password-Based → Built-in Database**，UserID Type 选择 **username**，启用认证器。UserID Type 不能选 clientid，服务端 client ID 会动态生成。
3. 新建认证器可采用与开发一致的 `sha256`、Salt Position `suffix`。不要为照抄示例而修改现有认证器的哈希算法、盐位置或 UserID Type，这会影响已有账号。
4. 在该认证器操作列进入 **Users / 用户管理**，建立独立生产发布账号，例如 `stupig-publisher-prod`，使用强密码，开启 **Super User / is_superuser**。这些值同步填入应用 `.env.prod`，不下发浏览器。
5. 核对实际 TCP listener 是否使用全局认证链，是否还有 listener 专属认证链覆盖。账号必须创建在该 TCP 连接实际使用的认证器内；链中其他放行机制也要逐项检查。

**仅设置 `enable_authn=true` 不算完成。** 这个字段把连接交给配置的认证链，并不证明链中已有可用认证器；必须核对实际链并实测匿名 TCP、错误密码被拒。开发 5.x 的空认证链可能放行，生产也不能仅凭 no_match=deny 判断连接认证安全，因为那是另一阶段的 topic 授权设置。[6.2 内置数据库](https://docs.emqx.com/en/emqx/v6.2/access-control/authn/mnesia.html)、[6.2 认证链](https://docs.emqx.com/en/emqx/v6.2/access-control/authn/authn.html)。

Dashboard 管理密码与这里的 MQTT 密码分别轮换。开发 bootstrap 只用于初始化，不覆盖已存在用户；改应用 env 或重启 broker 都不保证更新 Mnesia 中的旧密码。生产不要套用开发 bootstrap 生成逻辑来反复覆盖账号。

### 3. 分开 TCP 与浏览器 listener

在 **Management → Listeners** 核对 listener ID 和认证开关；不同界面翻译可能显示为监听器设置。典型反代拓扑：

```text
应用容器 ── TCP 1883（内网、需密码）── EMQX tcp:default
浏览器 ── WSS 443 ── Nginx/1Panel ── WS 8083 ── EMQX ws:default
```

| listener | 设置 | 网络要求 |
| --- | --- | --- |
| `tcp:default` | `enable=true, enable_authn=true, zone=default` | 仅应用可达的可信内网 |
| `ws:default` | `enable=true, enable_authn=false, zone=default`，MQTT path `/mqtt` | 只让 HTTPS 反代到达 |
| 未使用的 SSL/WSS/其他 listener | 停用或确认没有外部入口 | 不因 Docker 没映射宿主机端口就忽略同网络容器的访问 |

若 TLS 直接终止在 EMQX `wss:default`，浏览器认证开关要配到 **wss**；若 TLS 在 Nginx 终止，浏览器实际到 broker 的是 **ws**。不能只根据外部 URL 是 `wss://` 就修改 WSS listener。[官方 listener 配置](https://docs.emqx.com/en/emqx/v6.2/configuration/listener.html)。

固定配置的最小增量如下，可合并到专用 broker 的 `base.hocon`；这不是包含认证用户、证书、集群和持久化设置的完整配置，不应覆盖整个现有文件：

```hocon
listeners.tcp.default {
  enable = true
  bind = "0.0.0.0:1883"
  zone = default
  enable_authn = true
}
listeners.ws.default {
  enable = true
  bind = "0.0.0.0:8083"
  zone = default
  enable_authn = false
  websocket.mqtt_path = "/mqtt"
}
authorization {
  no_match = deny
  deny_action = disconnect
  sources = [
    {
      type = file
      enable = true
      path = "/opt/emqx/etc/acl.conf"
    }
  ]
}
```

配置源若使用环境变量，字段分别为 `EMQX_LISTENERS__TCP__DEFAULT__ENABLE_AUTHN=true`、`EMQX_LISTENERS__WS__DEFAULT__ENABLE_AUTHN=false` 等，双下划线表示层级。不要同时保留另一套相反的 Dashboard 设置。

应用目前明确使用 `protocol: mqtt`，连接可信内网 TCP；**仅把 `MQTT_TCP_PORT` 改成 8883 不会启用 MQTT TLS**。需要跨不可信网络发布时，应先实现并验证应用端 MQTT TLS 配置。

### 4. 配置授权源和规则

在 **Access Control → Authorization**：

1. 专用 broker 使用 File 授权源，启用并填入下面两条规则；删除默认示例中的放行所有、按 localhost 放行等规则。
2. 相关全局设置明确选择 **No Match Action = deny**、**Deny Action = disconnect**。6.2.2 的 no_match 默认 deny，但 deny_action 默认 ignore；仍明确设置两者，并检查升级前持久化值。
3. 核对完整授权源顺序。文件内从上到下命中即停止；授权源链也可能在更早的 Allow/Deny 上结束。前置宽泛 Allow 会绕开后面的拒绝；文件末尾 `{deny, all}` 则会阻止继续尝试后面的源。

直接复用仓库 [`emqx-acl.conf`](../../emqx-acl.conf)：

```erlang
{allow, all, subscribe, ["stupig/sync/#"]}.
{deny, all}.
```

这里没有为普通连接授予任何 publish。superuser 在检查这些规则之前就绕过授权，因此真实发布账号可以发布；WS `enable_authn=false` 只跳过认证，不跳过 ACL。即使 WS 客户端提交正确发布账号密码，也不会因这个被跳过的认证器获得 superuser。

File 授权在 Dashboard/API 编辑后，EMQX 会把新 ACL 保存到 `data/authz/acl.conf` 并切换读取路径；此后只改原来的只读挂载文件可能不生效。挂载文件和 Dashboard 二选一维护，并以有效 `authorization.sources[].path` 为准。[官方文件授权及路径行为](https://docs.emqx.com/en/emqx/v6.2/access-control/authz/file.html)。

### 5. 读回、重连并验证持久化

在服务器终端运行，`<emqx-container>` 替换为 1Panel 实际容器名：

```sh
docker exec <emqx-container> emqx ctl status
docker exec <emqx-container> emqx ctl conf show listeners
docker exec <emqx-container> emqx ctl conf show authentication
docker exec <emqx-container> emqx ctl conf show authorization
```

这些命令在本机 6.2.2 已核对可用，`conf show`、`authz cache-clean` 也已对照 [6.2 官方 CLI](https://docs.emqx.com/en/emqx/v6.2/admin/cli.html)；尚未在生产执行。只在本机查看必要子树，不分享完整配置；外部认证后端的配置可能包含敏感参数。检查所有集群节点及最终认证链、listener 开关、ACL 路径，不能只检查某份文件。

更新规则后优先清理本次测试客户端的授权缓存并断开重连：

```sh
docker exec <emqx-container> emqx ctl authz cache-clean <test-client-id>
```

命令中的 Client ID 是真实测试连接 ID。`authz cache-clean all` 会作用于所有节点，专用 broker 有必要时才使用；清授权缓存不会更新旧连接的认证属性。更改密码或 superuser 后还需让相关连接重连，不能只刷新浏览器页面。

6.2.2 还有外部资源节点缓存；本页的内置数据库认证和 File 授权不使用它。若生产额外接了 SQL/HTTP 等外部认证或授权源，须另查其缓存状态、TTL 和失效方式，不能把一次客户端授权缓存清理视为所有层都已失效。依据 [6.2 外部认证缓存](https://docs.emqx.com/en/emqx/v6.2/access-control/authn/authn.html#external-resource-cache)与[外部授权缓存](https://docs.emqx.com/en/emqx/v6.2/access-control/authz/authz.html#external-resource-cache)。

先用受控客户端按下表验收，再在维护安排下重启 broker，重复验收，确认环境变量/文件优先级及数据持久化没有使设置回退。不要通过删卷、清空 Mnesia 或重建认证器排除密码问题。

## WSS 反代与应用参数

`.env.prod` 中 `MQTT_HOST` 填应用容器可达的 EMQX 网络地址，`MQTT_TCP_PORT=1883`，凭据对应实际 MQTT 用户；容器内 `127.0.0.1` 是应用自己。`MQTT_WEB_URL` 则是浏览器访问的完整 URL，例如 `wss://mqtt.example.com/mqtt`。

以下合并到实际 HTTPS server，upstream 按反代所在网络替换：

```nginx
location /mqtt {
    proxy_pass http://127.0.0.1:8083;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

反代在容器中时用 EMQX 服务地址，不能照抄宿主机回环地址。保持 MQTT 子协议和 `/mqtt` 路径，不缓存升级请求；不要加需要登录或浏览器挑战的网关。公网只开放 HTTPS/WSS，发布 TCP 和 Dashboard 留内网/受控管理入口。浏览器签发业务登录令牌不参与 broker 认证。[Nginx WebSocket 官方说明](https://nginx.org/en/docs/http/websocket.html)。

## 1Panel 的持久化与轮换

保留当前数据和配置挂载，特别是 `/opt/emqx/data` 下的 Mnesia、`configs`、`authz`，以及 `etc` 的声明配置、外部挂载 ACL 和 TLS 材料。镜像标签、稳定 node name 与恢复流程也要记录；不能把换卷或改节点身份当成无损更新。

本机开发 Compose 没有显式命名 EMQX 数据卷；本次 inspect 确认镜像创建了 `/opt/emqx/data`、`/opt/emqx/log` 两个匿名卷。这不代表生产已做好持久化。生产按 1Panel 实际挂载进行备份，并在隔离环境验证账号、规则和节点状态能恢复；不要新挂空卷覆盖已有数据。[官方备份恢复](https://docs.emqx.com/en/emqx/v6.2/operations/backup-restore.html)。

密码轮换优先新建第二个受控发布账号，验证后更新应用 `.env.prod`、加密交付并重启应用，确认新连接发布成功，再撤销旧账号；在过渡期保持匿名发布拒绝。改认证器哈希算法不是正常的密码轮换操作。

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
| Dashboard 保存后重启回退 | 1Panel 的 EMQX_*、emqx.conf 与 cluster.hocon 优先级 |
| 修改挂载 ACL 后无效果 | 实际 sources.path 是否已切到 data/authz/acl.conf，是否清缓存并重连 |
| 改 .env.prod 后密码仍不对 | 应用已重启、broker 内置库用户是否同步轮换；bootstrap 不覆盖旧用户 |

## 共享 broker 不能直接套用全局规则

仓库两条 ACL 和 superuser 发布账号以专用 broker 为前提。若生产 EMQX 与其他站点共用：

- 全局 `{deny, all}` 可能阻断其他业务；全局匿名订阅允许也会对其他连接开放本应用通知。
- superuser 可读写所有业务 topic，不能声称已经实现按项目最小权限。
- 应使用本应用专用发布/浏览器 listener，将发布者改为非 superuser，按 **已认证 listener + 真实用户名 + topic** 联合授权，并审查整条授权源链与其他项目规则。
- 匿名 WS 上单独匹配发布用户名仍不安全。不能把它当成共享环境的简化方案。

5.10.5 的 ACL 已支持 listener 条件，依据[固定版本规则实现](https://github.com/emqx/emqx/blob/e5.10.5/apps/emqx_auth/src/emqx_authz/emqx_authz_rule.erl)。具体共享配置必须结合实际 listener ID、其他项目认证链与规则设计并完整验收；本轮没有替生产更换模型。若没有共享要求，保持专用 broker 能减少这些交叉影响。
