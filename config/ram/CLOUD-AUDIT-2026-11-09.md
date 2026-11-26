# SID#1.0 初次配置参考与 RAM 核对

本文保留初次配置调查与云端读回记录，当前配置操作见 [SID#1.0 初次配置完整说明](../../docs/1_workflows/0_setup/AGENT-DESIGN.md)。下文将云端读回与新环境的配置要求分开记录。RAM 策略、用户直接绑定及用户组、OSS 桶设置和 ESA 配置于 2026-11-09 01:15:19 起（Asia/Shanghai）使用 `.env.tmp` 只读身份复核；STS、AccessKey 状态、策略的组／角色绑定和服务角色存在性沿用 2026-11-08 的调查，本轮未重新验证。

## 云端核对结果

使用 `.env.tmp` 的只读凭证，经 STS 确认调用者属于策略所指账号。逐份读取 RAM 自定义策略的默认版本及其绑定，再反查 10 个项目用户的直接策略、用户组和 AccessKey 状态。比较时忽略字段和列表顺序，并将单个 `Action`／`Resource` 与等价的单元素数组统一处理。[RAM 查询接口](https://www.alibabacloud.com/help/en/ram/developer-reference/api-ram-2015-05-01-overview)

| 策略 | 云端默认版本 | 与仓库 JSON 对照 | 云端直接绑定 |
| --- | --- | --- | --- |
| `stupig-oss-app-dev-access` | v5 | 仅 `ForceTLS` 条件值的表示不同 | `stupig-oss-dev` |
| `stupig-oss-app-prod-access` | v4 | 同上 | `stupig-oss-prod` |
| `stupig-oss-inventory-dev-readonly` | v1 | 一致 | 已从 `stupig-oss-dev` 解绑 |
| `stupig-oss-inventory-prod-readonly` | v1 | 一致 | 已从 `stupig-oss-prod` 解绑 |
| `stupig-esa-cache-access` | v1 | 一致 | `stupig-esa-purge-dev`、`stupig-esa-purge-prod` |
| `stupig-esa-publish-access` | v1 | 一致 | `stupig-esa-publish-dev`、`stupig-esa-publish-prod` |
| `stupig-sms-access` | v1 | 一致 | `stupig-sms-dev`、`stupig-sms-prod` |
| `stupig-acr-push-access` | v1 | 一致 | `stupig-acr-push` |
| `stupig-acr-pull-access` | v1 | 一致 | `stupig-acr-pull` |

- 两份 OSS 应用策略的 `Bool.acs:SecureTransport` 在云端写为 `["false"]`，仓库写为 `"false"`。两种写法都匹配非安全传输，动作、资源、效果和其余条件一致，9 份策略的权限语义均与仓库一致。[RAM 策略元素](https://help.aliyun.com/zh/ram/policy-elements) · [RAM 单值示例](https://help.aliyun.com/zh/ram/access-alibaba-cloud-by-using-a-specified-method) · [OSS 单元素数组示例](https://help.aliyun.com/zh/oss/how-do-i-configure-an-https-request-and-an-ssl-certificate)
- **专项盘点策略已解绑。** 2026-11-09 01:37:23 起（Asia/Shanghai）重新读取两个 OSS 用户的直接策略及用户组：`stupig-oss-dev` 仅保留 `stupig-oss-app-dev-access`（v5），`stupig-oss-prod` 仅保留 `stupig-oss-app-prod-access`（v4），两者均无用户组。此前临时附挂的本环境 inventory 只读策略已解除授权，日常应用策略保留。后续专项盘点使用独立的 `stupig-oss-inventory-{dev,prod}` 用户，绑定及凭据注入见[专项盘点操作](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#准备权限)；本次读回没有核实这些独立用户是否存在。
- 10 个用户均无用户组，直接绑定仅有上表所列的当前绑定策略；两名 OSS 用户的解绑状态以 01:37:23 起的补充读回为准。8 个日常用户各有 1 把启用的 AccessKey，2 个备用 ACR 用户各有 0 把。9 份策略均无组或角色绑定。独立的 ESA 产品回源角色 `AliyunESAAccessingPrivateOSSRole` 存在，角色信任策略及实际回源链路留待业务验收。
- 两个 OSS 桶的 ACL 均为 `private`，版本控制为 `Enabled`，阻止公共访问已开启。开发 CORS 来源为 `http://localhost:3042`，生产为 `https://www.stupig.tv`。两边均允许 `GET`、`POST`、`PUT`、`DELETE`、`HEAD`，允许所有请求头并暴露 `ETag` 和 `x-oss-request-id`。现有规则满足浏览器分片上传所需的 `PUT`。
- 两桶均在原有同一条启用的全桶生命周期规则中，清理成为非当前版本满 7 天的对象（`NoncurrentDays=7`）、清理过期删除标记（`ExpiredObjectDeleteMarker=true`），并自动终止初始化满 7 天仍未完成的分片上传（`AbortMultipartUpload.Days=7`）。删除标记没有独立的 7 天期限，规则未配置当前对象按天过期删除，无需另建碎片规则。[OSS 生命周期配置](https://help.aliyun.com/en/oss/developer-reference/putbucketlifecycle)

当前应用的[上传清扫任务](../../server/services/content/upload-lifecycle.service.ts)依据上传会话与尝试账本，清理取消、过期、失败或被替换的上传；使用已知 UploadId 并按精确对象 key 发现未完成上传，再调用 AbortMultipartUpload，失败后继续重试。OSS 生命周期用于应用长期停机、账本丢失或外部工具遗留分片的兜底。这是当前仓库的代码能力，生产任务是否正常运行仍需验收。

### ESA 站点与交付配置

本轮读取了共享站点 `tangenty.cn`（SiteId `181553031729356`）的全部站点功能配置；`ListSiteFunctions` 返回 60 项、共 1 页。

| 站点全局配置 | 当前值 |
| --- | --- |
| HTTPS、强制 HTTPS | 开启 |
| HTTP/2、HTTP/3、HTTP/2 回源 | 全部开启（`Http2=on`、`Http3=on`、`Http2Origin=on`） |
| TLS 1.0、1.1 | 关闭 |
| TLS 1.2、1.3 | 开启 |
| 加密套件组 | `strict` |
| HSTS | 开启，`max-age=15552000`（180 天） |
| HSTS includeSubDomains、preload | 关闭 |
| 源站证书校验、回源双向认证 | `OriginVerify=on`、`OriginMtls=on` |
| OCSP Stapling | 关闭 |
| WebSocket | 开启 |
| IPv6 | 关闭 |
| 分层缓存 | `edge_regional` |

这些全局设置也影响站点下其他代理域名。开关读回不等于实际协议协商、回源证书配套或冷回源性能已验收。[TLS 配置](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/tls-encryption-suite-and-protocol-version-configuration) · [HTTP/2 与 HTTP/3](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/protocol-optimization)

- 两个分发域名均开启代理，分别指向本环境的深圳 OSS 桶，Host 跟随源站，采用同账号私有 OSS 回源。
- 两个 Content 函数路由均为 custom、启用、Bypass 开、Fallback 关，各自匹配本环境 host 的全部 `/content/`。
- Content 缓存键忽略全部查询参数，边缘 TTL 为 `94608000` 秒，4xx／5xx 不缓存；HTTPS 回源、强制 Range 分片（1 MB）、回源清空 query、浏览器 `private, no-store`、跨域及动态文件名响应头规则均已配置。
- 两函数的授权超时均为 5000 ms，鉴权变量均为 `secret_text`，只确认存在和类型。开发回调与仓库一致。
- **生产回调留到部署时同步。** 云端仍为 `https://www.stupig.tv/api/content/authorize`，仓库 [prod.yaml](../prod.yaml) 要求 `/api/hooks/esa/authorize`。用户已确认现在保留旧回调；下次生产部署在应用通过健康检查后发布 ESA 函数，由发布工具同步回调地址、超时和鉴权变量。部署后读回变量并验证真实附件授权读取，无需提前手动修改。
- 8 类站点 WAF 规则集查询均为空（白名单、自定义、托管、扫描防护、限频、IP 访问、Bot、安全规则），智能限频关闭；这不代表平台默认或账号级防护全部关闭。

本轮覆盖上述 RAM、OSS 和 ESA 控制面配置。实际应用凭据与进程对应关系、上传下载、冷回源、HEAD／Range、回调授权及生产清扫任务尚未重新验收；号码认证产品设置、GitHub、ACR 和生产健康接口也未在本轮复核，沿用各自原调查基线并按下文验收。

## 开发和生产共用的配置步骤

1. **确认资源和配置归属。** 当前账号为 `1225000469589595`，ESA 共用站点为 `181553031729356`。开发使用深圳桶 `stupig-static-dev`，生产使用深圳桶 `stupig-static`。换账号、桶、站点或 ACR 仓库时，同步核对策略资源 ARN 和环境配置。通用字段放 [shared.yaml](../shared.yaml)，资源目标放 [dev.yaml](../dev.yaml)／[prod.yaml](../prod.yaml)。密钥填本机 `.env.dev`／`.env.prod`，按 [共享模板](../../.env.shared.layer) 和 [开发](../../.env.dev.layer)／[生产](../../.env.prod.layer) 模板补齐。
2. **创建自定义策略和日常用户。** 用文件名去掉 `.json` 作为策略名，显式在 RAM 中创建或更新默认版本。每环境各建四个仅需 OpenAPI 访问的用户，按下表绑定。沿用用户时核对额外直接授权及用户组，避免原有宽权限继续生效。专项盘点另用 `stupig-oss-inventory-{dev,prod}` 用户绑定对应只读策略，应用用户保持各自的 app 策略。ACR 的两个备用策略和用户可按需保留，现行镜像交付使用 Registry 登录。[RAM 配置步骤](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#4-建-ram-用户并填各自的密钥)
3. **配置 OSS。** 每环境建一个私有桶供 `content/att/`、`imgs/`、`avatar/` 使用，启用版本控制及阻止公共访问。设置该环境页面 Origin 的 CORS，至少允许 `PUT`、允许请求头 `*` 并暴露 `ETag`、`x-oss-request-id`。配置非当前版本、过期删除标记和未完成分片的生命周期，保留期按恢复与续传窗口定，正式 Content 对象的当前版本须保留。填 `aliyun.oss` 的 bucket、region、HTTPS API endpoint 和 ESA 读取地址，同时同步静态资源兼容配置 `oss.buckets.public`。浏览器使用精确的 UploadPart 签名 URL，`uploadRoleArn` 保持 `null`。[OSS 初配](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#2-在-oss-建桶)
4. **准备 ESA。** 为两个分发域名配置代理 DNS、证书及对应桶的 HTTPS 私有回源，通过 ESA 产品授权服务角色。每环境手工创建一个授权函数，使用各自的 `production` 槽位。自定义路由覆盖对应 host 的全部 `/content/`，启用路由、Bypass 开、Fallback 关。缓存键忽略查询参数，回源时才去掉查询参数，开启 Range 回源。边缘可长缓存，发给浏览器的 Content 响应设为 `private, no-store`，同时配置跨域读取与动态文件名响应头。静态图片和头像通过同一分发域名公开交付。填 `ALIYUN_ESA_SITE_ID`、`aliyun.esa.baseUrl`、`esaFunction.name` 和完整 HTTPS `callbackUrl`。每环境生成独立的 `ALIYUN_ESA_AUTH_KEY`，发布工具同步该密钥、回调及超时。[ESA 初配](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#3-在-esa-准备分发和授权) · [函数发布](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#单独发布-esa)
5. **开通号码认证。** 准备已审核的短信签名、模板及方案。模板使用 `code` 和 `min`，发送和核验用同一方案，在 `aliyun.sms` 填入 `signName`、`templateCode`、`schemeName`。开通 PNVS 图形验证并核对允许域名，公开标识填 `aliyun.captcha.appId`，服务端密钥填 `ALIYUN_DYPNS_CAPTCHA_APP_KEY`。图形验证使用产品 appKey 验签，无需另外建 RAM 策略。[短信和图形验证](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#5-开通短信和图形验证)

| 用途 | 开发用户 | 生产用户 | 策略 | 各自环境的凭据变量 |
| --- | --- | --- | --- | --- |
| OSS 应用 | `stupig-oss-dev` | `stupig-oss-prod` | [dev](stupig-oss-app-dev-access.json)／[prod](stupig-oss-app-prod-access.json) | `ALIYUN_OSS_ACCESS_KEY_ID`、`ALIYUN_OSS_ACCESS_KEY_SECRET` |
| ESA 缓存维护 | `stupig-esa-purge-dev` | `stupig-esa-purge-prod` | [缓存维护](stupig-esa-cache-access.json) | `ALIYUN_ESA_ACCESS_KEY_ID`、`ALIYUN_ESA_ACCESS_KEY_SECRET` |
| ESA 函数发布 | `stupig-esa-publish-dev` | `stupig-esa-publish-prod` | [函数发布](stupig-esa-publish-access.json) | `ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID`、`ALIYUN_ESA_PUBLISH_ACCESS_KEY_SECRET` |
| 短信认证 | `stupig-sms-dev` | `stupig-sms-prod` | [短信](stupig-sms-access.json) | `ALIYUN_DYPNS_ACCESS_KEY_ID`、`ALIYUN_DYPNS_ACCESS_KEY_SECRET` |

OSS 策略按桶隔离，对象读写限于本环境的业务前缀，允许列举本桶对象元数据；对 `content/att/*` 明确拒绝公开 ACL 和永久删除历史版本。ESA 缓存权限覆盖共享站点，发布权限覆盖账号内相关函数操作，短信权限只包含验证码发送与核验。ESA 和短信的独立用户便于分环境保管和轮换凭据。初建函数、路由、站点规则仍由管理员完成。各策略的权限依据原写在 `docs-legacy/deployment/ram-reference.md`（2026-11-19 随旧文档删除，原文见 git tag `docs-legacy-final`），现行策略以本目录的 JSON 为准。

## 开发首次启动

1. 安装 Node.js 24、pnpm（CI 为 12.10.1）、Docker 与 Compose。执行 `pnpm install --frozen-lockfile` 和 `pnpm env:build:dev`，补齐 `.env.dev`，包括 JWT、数据库和上述云服务凭据。开发默认 `NUXT_OTP_DEBUG=true`、`NUXT_CAPTCHA_DEBUG=true`，测试账号使用调试流程或密码登录。[开发启动](../../docs/1_workflows/1_develop/DESIGN.md)
2. 需要真实附件读取时，安装与 frps 匹配的 frpc（当前项目为 0.71.0），本机路径可在 `config/local.yaml` 覆盖。公网 HTTPS 连接域名将 WSS 转发到 frps 的控制端口 7000，另一回调域名仅将 `POST /api/hooks/esa/authorize` 转发到 frps 的远程代理端口 15550。开发机通过 `DEV_FRP_TOKEN` 认证，在 `devAuthTunnel.frp.serverAddr` 填连接域名，`esaFunction.callbackUrl` 填完整回调地址。执行 `pnpm dev:tunnel --prepare`、`pnpm dev:tunnel --verify`。[开发隧道初配](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#6-连上开发回调并启动)
3. 执行 `pnpm dev` 启动本地依赖、应用和授权通道。当前开发启动脚本对空库自动执行迁移，已有库只检查迁移状态，待执行项按维护流程处理。回调可达后用 `pnpm esa:deploy:dev --check` 检查目标，首次正式发布运行 `pnpm esa:deploy:dev`。[开发入口](../../scripts/dev/cli.ts) · [开发迁移](../../scripts/migration/dev-bootstrap.ts)

## 生产首次上线

1. 准备 Linux、Docker、Compose、部署账号可写的 `DEPLOY_DIR` 和现存的 `EXTERNAL_DOCKER_NETWORK`。准备 MySQL 8.4 专用库和账号（CRUD 与迁移所需 DDL，`utf8mb4`／`utf8mb4_unicode_ci`，连接用 UTC）及受限网络上的带密码 Redis。EMQX 由生产 Compose 启动。主站 HTTPS 反代至应用回环端口（`APP_PORT` 默认 3042），保留 Cookie、POST 和转发头，API 与授权回调禁用缓存。`/mqtt` 和 `/mqtt-drafts` 分别反代到两个 WebSocket listener，两者上游路径均为 `/mqtt`。生产 ESA 直接回调主站的 `/api/hooks/esa/authorize`。[生产服务器与数据库](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#7-准备生产服务器) · [MQTT WSS 反代](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#mqtt-wss-反代)
2. 在 ACR 个人版准备命名空间和私有镜像仓库，CI 推送应用及 EMQX 镜像。GitHub 仓库 Variables 配置 `ACR_IMAGE`（无 tag）、`SSH_HOST`、`SSH_PORT`、`SSH_USER`、`DEPLOY_DIR`，维护备份可按需填 `MYSQL_BACKUP_CONTAINER`。仓库 Secrets 配置 `ACR_USERNAME`、`ACR_PASSWORD`（CI 和主机共用 Registry 凭据）、`SSH_PRIVATE_KEY`、`SSH_KNOWN_HOSTS`（经独立渠道核实的主机公钥）和 `ENV_PASSPHRASE`。给 `main` 配置 GitHub Actions 的必需状态 `check`，要求分支为最新。[GitHub 与 ACR](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#8-接上-githubacr-和生产发布)
3. 用 `pnpm env:build:prod` 生成并填好 `.env.prod`，两个调试开关设为 `false`，`ACR_IMAGE` 与仓库 Variable 一致。执行 `pnpm env:encrypt` 和 `pnpm env:check`，交付 `.env.prod.gpg`。加密口令与 GitHub Secret 相同。CI 解密后做 ESA 预检，发往服务器的运行配置会移除 `ALIYUN_ESA_PUBLISH_*`，仍保留应用所需的缓存维护凭据和链接鉴权密钥。[生产密文](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#生产密文与提交钩子) · [部署工作流](../../.github/workflows/deploy.yml)
4. 首次空库先按维护流程执行完整迁移；已有数据先备份并在副本预演。应用启动并通过健康门后发布生产 ESA 函数。空库通过正常注册建立站点所有者，由获授权的数据库维护人员按清单设置首个管理员，重新登录验收后开放流量。[迁移流程](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#迁移查询与失败恢复) · [首个管理员](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#8-接上-githubacr-和生产发布)

## 首次验收

- 用各环境的实际应用身份核对本桶读取和跨环境拒绝。用浏览器验证分片 PUT、读取 ETag、完成上传、图片原生保存、替换和可恢复删除。专项盘点按独立用户流程执行，临时授权结束后解除并读回绑定；应用用户保持各自的 app 策略。
- 使用 `pnpm esa:deploy:dev --check`／`pnpm esa:deploy:prod --check` 检查函数及路由。用实际附件验证合法读取、HEAD／Range、冷回源和缓存命中、撤权后拒绝及回调故障时拒绝交付。用 `pnpm content:preload:check:dev`／`pnpm content:preload:check:prod` 查询额度和账本，检查需要对应数据库可达，生产预热在交付验收后单独启用。[ESA 验收](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#9-检查一遍再开放流量) · [预热检查入口](../../scripts/content/preload-check.ts)
- 生产用受控号码验证短信发送与正确、错误和过期验证码的处理，验证图形认证、ACR 镜像推拉、应用健康、两个 WSS listener 及其授权行为。[上线验收](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#9-检查一遍再开放流量)
