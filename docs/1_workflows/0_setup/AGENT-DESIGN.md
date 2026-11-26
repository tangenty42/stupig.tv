# AGENT-DESIGN：初次配置工作流

- 本文档状态：DONE
- 覆盖范围：本机、阿里云、开发回调隧道、生产服务器、GitHub 和 ACR
- 被权威文档引用：[SID#1.0.DESIGN](DESIGN.md)（初次配置完整说明）
- 编写依据：仓库配置及 [2026-11-09 云端复核](AGENT.md#2026-11-09-复核与待办)
- 初配示例整理：2026-11-11 20:55:43 +08:00（Asia/Shanghai），提交 722c1cd3392cb4cdb5c8b051f3354c8e3905e355 及工作区
- 目标用户：Agent 接手本项目初次搭建，或人类按此核对现有配置

从头搭建时按下面的顺序做。接手现有项目时，先确认自己要接开发还是生产，沿用该环境的资源和配置。两个环境各有一套 OSS 桶、边缘函数和 RAM 凭据，当前共用一个 ESA 站点。带日期的云端读回与部署衔接项见 [初配记录](AGENT.md#2026-11-09-复核与待办)。

只接开发环境，完成第 1–6 节，再按第 9 节验收开发链路；需要交付生产时，再完成第 7–8 节和生产验收。下面给出的资源名是本项目现用名称，新账号按同样关系配置，并同步修改 YAML 和权限策略中的资源范围。

## 1. 准备本机

1. 装 Node.js 24 最新补丁版（密码哈希使用 24.7 起提供的 Argon2id）、pnpm（CI 使用 12.10.1）、Docker 和 Compose。要生成或校验生产密文，再装 GnuPG。拉取仓库，在根目录执行 `pnpm install --frozen-lockfile`。
2. 在本机执行 `pnpm env:build:dev`。需要交付生产时，再执行 `pnpm env:build:prod`。它们分别从共享模板和对应环境模板生成 `.env.dev`、`.env.prod`。已有资源的同事可从受保护渠道取得本环境凭据，新建资源时按后面的步骤补齐 `<required>`。明文 env 留在本机或受控运行环境。
3. 地址、桶名、函数名等放在 [共享配置](../../../config/shared.yaml) 和 [开发](../../../config/dev.yaml)／[生产](../../../config/prod.yaml) YAML 中。仅自己这台开发机需要改的值放 `config/local.yaml`，可参照 [local.example.yaml](../../../config/local.example.yaml)。密钥按 [环境变量模板](../../../.env.shared.layer) 填入 env 文件。
4. 先补齐本机启动用的 JWT、MySQL、Redis、MQTT 配置，云服务凭据按后面的步骤取得后再填。开发依赖由项目 Compose 启动，地址和端口沿用开发模板；生产填写实际容器网络内可达的地址。开发保持 `NUXT_OTP_DEBUG=true`、`NUXT_CAPTCHA_DEBUG=true`。
5. 首次在 Windows 使用该项目，执行 `pnpm dev:cert --install` 并确认当前用户的证书安装提示，再执行 `pnpm dev`。已有开发身份的电脑会复用原证书，同一用户的新检出可直接启动。证书只在本机生成、不入库；要在另一台机器复用同一身份，把 `ca.pem`、`localhost.pem`、`localhost.key` 一起放进 `.dev/https/`。生成、信任与轮换见[本机 HTTPS 证书](../1_develop/AGENT-DESIGN.md#本机-https-证书)。

## 2. 在 OSS 建桶

1. 在 OSS 控制台分别建一个开发桶和生产桶，访问权限选「私有」，开启「阻止公共访问」和「版本控制」。现有两桶都在深圳，开发是 `stupig-static-dev`，生产是 `stupig-static`。每个桶内的 `content/att/` 放档案附件，`imgs/` 和 `avatar/` 放站点图片和头像。对象 ACL 保持私有，公开图片经 ESA 访问。
2. 配置附件直传的 CORS 规则。在 OSS 控制台选中目标桶，进入『数据安全 → 跨域设置』。新桶点『创建规则』。已有开发桶编辑原规则，把来源 `http://localhost:3042` 替换为 `https://localhost:3042`。来源填上传页面的协议、主机和端口；自定义了 `APP_PORT` 时填实际端口。[阿里云 OSS 跨域设置](https://help.aliyun.com/zh/oss/user-guide/configure-cross-origin-resource-sharing/)

   | 控制台字段 | 开发桶 `stupig-static-dev` | 生产桶 `stupig-static` |
   | --- | --- | --- |
   | 来源 | `https://localhost:3042` | `https://www.stupig.tv` |
   | 允许 Methods | 勾选 `PUT` | 勾选 `PUT` |
   | 允许 Headers | `*` | `*` |
   | 暴露 Headers（每行一个） | `ETag`、`x-oss-request-id` | `ETag`、`x-oss-request-id` |

   保存后按第 9 节验证分片上传。现有开发桶的切换进度见[开发桶跨域待办](AGENT.md#开发桶跨域待办)。
3. 设置生命周期规则。开发桶 `stupig-static-dev` 和生产桶 `stupig-static` 均已在全桶启用的规则中配置：非当前版本满 7 天清理（`NoncurrentDays=7`）、过期删除标记清理（`ExpiredObjectDeleteMarker=true`）、未完成分片上传初始化满 7 天自动终止。未设置当前对象按天过期删除。应用已有基于上传会话和尝试账本的分片清扫（`server/services/content/upload-lifecycle.service.ts`），覆盖取消、过期、失败或被替换的上传，按已知 UploadId 和精确对象 key 发现分片并终止，失败后继续重试。OSS 生命周期规则用于应用长期停机、账本丢失或外部遗留分片的兜底。[OSS 生命周期规则](https://help.aliyun.com/en/oss/developer-reference/putbucketlifecycle)
4. 在各环境 YAML 填 `aliyun.oss.bucket`、`region`、`endpoint`、`publicBaseUrl`。SDK endpoint 用 OSS 官方 HTTPS 地址，`publicBaseUrl` 用对应 ESA 分发地址。把静态资源的 `oss.buckets.public` 也指到同一个桶。浏览器使用后端签发的 UploadPart URL，`uploadRoleArn` 保持 `null`。

## 3. 在 ESA 准备分发和授权

1. 把分发域名接入 ESA，按该站点的 NS 或 CNAME 接入方式完成 DNS 验证。当前站点是 `tangenty.cn`，SiteId 为 `181553031729356`。开发分发域名为 `stupig-static-dev.oss.tangenty.cn`，生产为 `stupig-static.oss.tangenty.cn`。在对应 env 填 `ALIYUN_ESA_SITE_ID`，在 YAML 的 `aliyun.esa.baseUrl` 填完整 HTTPS 分发地址。
2. 配置站点全局安全与协议设置。强制 HTTPS 开启。TLS 协议关闭 1.0 和 1.1，开启 1.2 和 1.3；加密套件组选 `strict`。启用 HSTS，`max-age` 设为 `15552000`（180 天），不包含子域，不启用 preload。开启源站证书校验（`OriginVerify=on`）和回源双向认证（`OriginMtls=on`），配套源站服务器 TLS 证书和客户端证书。HTTP/2、HTTP/3、HTTP/2 回源全部开启。OCSP Stapling 关闭。WebSocket 开启，IPv6 关闭。分层缓存 `edge_regional`。这些是共用 `tangenty.cn` 站点的全局设置；配置读回不等于实际协议协商、证书配套或冷回源性能已验收。[官方字段说明](https://help.aliyun.com/en/edge-security-acceleration/esa/api-esa-2024-09-10-listoriginrules)
3. 给两个分发域名各配一条开启代理的 DNS 记录和有效证书。源站选本环境桶的官方域名,例如 `stupig-static-dev.oss-cn-shenzhen.aliyuncs.com`。回源 Host 跟随源站,协议用 HTTPS。启用同账号私有 OSS 回源,由 ESA 产品授权 `AliyunESAAccessingPrivateOSSRole` 读取私有源站。为两个域名各核对一次源站,尤其是开发桶名的 `-dev`。
4. 在「边缘函数」里分别建 `stupig-content-auth-bypass-dev` 和 `stupig-content-auth-bypass-prod`。两个函数都用各自的 `production` 发布槽位。给每个函数建一条自定义路由,只匹配自己的分发域名和全部 `/content/` 请求。路由启用、Bypass 打开、Fallback 关闭。签名校验和授权回调先于缓存查找,所以无签名请求、HEAD 和 Range 也必须进入该路由。
5. 按下面四行设置 Content 规则。规则可以共用,但匹配条件必须同时限定两个 Content host 和 `/content/`。路径前缀用 `starts_with(http.request.uri, "/content/")`,这是现有旁路配置使用的写法。头像、静态图片和主站 API 各走自己的路径。[ESA 规则引擎](https://help.aliyun.com/en/edge-security-acceleration/esa/user-guide/overview-of-rules/)

   | 控制台设置 | 怎么填 |
   | --- | --- |
   | 缓存规则 | 缓存键忽略全部查询参数。给成功对象设置独立的长边缘 TTL，4xx 和 5xx 不缓存。现有边缘 TTL 为 94,608,000 秒，浏览器策略跟随源站，并由下方出站规则强制设置。 |
   | 回源规则 | HTTPS 回源，开启 Range 分片回源。现有分片大小为 1 MB。 |
   | 重写 URL | 保留路径，只在回源阶段把查询字符串改为静态空串。鉴权函数继续收到原始签名和参数。 |
   | 修改出站响应头（ESA 到客户端） | 设置 `Cache-Control: private, no-store`、`Access-Control-Allow-Origin: *`、`X-Content-Delivery: esa-bypass`，暴露 `Content-Disposition, Content-Length, Content-Range, Accept-Ranges, ETag`，删除 `Access-Control-Allow-Credentials`。给带 `response-content-disposition` 参数的 Content 请求另设动态文件名规则。 |

6. 动态文件名规则在 host 和 `/content/` 条件上再加参数判断：`http.request.full_uri` 包含 `?response-content-disposition=` 或 `&response-content-disposition=`。动态值填 `concat("", http.request.uri.args["response-content-disposition"])`。确认最终响应头没有被同站其他规则覆盖。
7. 在每套 env 中生成独立的 `ALIYUN_ESA_AUTH_KEY`（32–128 个不含空格的可见 ASCII 字符）。在 YAML 的 `esaFunction.name` 填目标函数名，`esaFunction.callbackUrl` 填完整 HTTPS 授权地址。开发使用第 6 节的专用回调域名，生产使用 `https://www.stupig.tv/api/hooks/esa/authorize`。等回调应用就绪后，发布工具会把密钥作为加密变量写入，同时同步回调地址和超时。生产部署在应用通过健康检查后发布 ESA 函数，由发布工具同步回调地址、超时和鉴权变量；部署后核对变量并验证真实附件授权读取。首次发布前，站点、函数、路由和规则要已经建好。

## 4. 建 RAM 用户并填各自的密钥

1. 在 RAM 控制台打开「权限策略」，用脚本编辑创建自定义策略，粘贴 [config/ram](../../../config/ram/) 里的对应 JSON。策略名就是文件名去掉 `.json`，例如 `stupig-oss-app-dev-access`。当前 9 个 JSON 文件的名称均与云端策略名一致。换账号、桶或站点时，先将 JSON 中的资源 ARN 改到新目标。更新已有策略时，核对新版本已成为默认版本。
2. 开发和生产各建四个仅用于 OpenAPI 的 RAM 用户。给每个用户绑定下表那一份策略，创建 AccessKey，把 ID 和 Secret 填到该环境的 env。接手已有用户时，核对直接授权和用户组，**确保 OSS 应用用户（`stupig-oss-{dev,prod}`）只绑定自己的 app 策略**，不附加盘点或其他多余策略。

   | 用途 | 用户名（`<env>` 为 `dev` 或 `prod`） | 策略文件 | env 变量 |
   | --- | --- | --- | --- |
   | OSS 对象与上传 | `stupig-oss-<env>` | [开发](../../../config/ram/stupig-oss-app-dev-access.json)／[生产](../../../config/ram/stupig-oss-app-prod-access.json) | `ALIYUN_OSS_ACCESS_KEY_ID`、`ALIYUN_OSS_ACCESS_KEY_SECRET` |
   | ESA 刷新与预热 | `stupig-esa-purge-<env>` | [stupig-esa-cache-access.json](../../../config/ram/stupig-esa-cache-access.json) | `ALIYUN_ESA_ACCESS_KEY_ID`、`ALIYUN_ESA_ACCESS_KEY_SECRET` |
   | ESA 函数发布 | `stupig-esa-publish-<env>` | [stupig-esa-publish-access.json](../../../config/ram/stupig-esa-publish-access.json) | `ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID`、`ALIYUN_ESA_PUBLISH_ACCESS_KEY_SECRET` |
   | 号码认证短信 | `stupig-sms-<env>` | [stupig-sms-access.json](../../../config/ram/stupig-sms-access.json) | `ALIYUN_DYPNS_ACCESS_KEY_ID`、`ALIYUN_DYPNS_ACCESS_KEY_SECRET` |

3. 核对权限范围。OSS 对象读写限于本环境的业务前缀，列举对象和未完成上传的元数据则覆盖本桶；策略拒绝非 HTTPS 请求，并对 `content/att/*` 拒绝公共 ACL 和永久删除历史版本。ESA 缓存用户只能刷新、预热及查询配额，不能改 DNS、规则或函数；发布用户能上传代码、设置变量和发布，不能新建函数或修改路由；短信用户只负责验证码发送和核验。具体动作以各 JSON 为准。
4. 两套 ESA 缓存凭据都能操作整个共用站点的缓存，两套发布凭据都能操作账号内相应的函数发布接口。独立用户用于区分使用方和轮换密钥；发布时由工具核对实际站点、域名和函数。
5. **盘点与 ACR 策略。** 专项盘点需要查询历史版本、生命周期及额外的分片元数据时，单独建 `stupig-oss-inventory-{dev,prod}` 用户并绑定 [开发盘点策略](../../../config/ram/stupig-oss-inventory-dev-readonly.json) 或 [生产盘点策略](../../../config/ram/stupig-oss-inventory-prod-readonly.json)，不绑到应用用户上。接手时如果发现应用用户挂了盘点策略，解绑后确认业务不受影响。ACR 的两个 RAM 策略用于备用，现行交付采用第 8 节的 Registry 凭据。[RAM 权限和绑定核对](../../../config/ram/CLOUD-AUDIT-2026-11-09.md)

## 5. 开通短信和图形验证

1. 在「号码认证服务」控制台开通短信认证，确认签名、模板均审核通过，并准备发送和核验使用的同一方案。模板须支持验证码 `code` 和有效分钟数 `min`。把签名、模板号、方案名分别填入 `aliyun.sms.signName`、`templateCode`、`schemeName`。
2. 在同一产品里配置图形验证应用，核对要用真实验证的页面域名已获允许。公开的 appId 填入 `aliyun.captcha.appId`，服务端 appKey 填入对应 env 的 `ALIYUN_DYPNS_CAPTCHA_APP_KEY`。
3. 开发保持 `NUXT_OTP_DEBUG=true`、`NUXT_CAPTCHA_DEBUG=true`，测试账号用调试流程或密码登录。生产两个开关都填 `false`，上线后用自己的受控号码验证发送和核验，再验证图形挑战。

重建开发库后，按日常开发需要另行注册账号并设置权限。`pnpm dev` 初始化数据库结构，E2E 启动器在自己的隔离测试库创建夹具账号。

## 6. 连上开发回调并启动

1. 要在开发环境真正读取附件，先准备一台有公网 HTTPS 入口的 frps 服务器。frps 内部控制端口用 7000，允许给本项目代理分配远程端口 15550。保留同一 frps 上其他项目的端口设置。为连接域名配置 WebSocket Upgrade，将 HTTPS 443 上的 WSS 转发到 frps 的 7000。
2. 给 ESA 另设一个 HTTPS 回调域名。只转发 `POST /api/hooks/esa/authorize` 到 frps 的 15550，其他路径返回 404。frpc 收到这条代理连接后交给本机 `127.0.0.1:55500` 上的授权专用代理，再由代理校验证书并转发到 `https://localhost:3042` 上的同一路径。
3. 本机安装与服务端匹配的 frpc 0.71.0。路径不同就用 `config/local.yaml` 覆盖 `devAuthTunnel.frp.executable`。在 `devAuthTunnel.frp.serverAddr` 填第一个域名，在 `esaFunction.callbackUrl` 填第二个域名加完整回调路径。frps token 填入 `.env.dev` 的 `DEV_FRP_TOKEN`。执行 `pnpm dev:tunnel --prepare`、`pnpm dev:tunnel --verify`。
4. 执行 `pnpm dev`。它会启动 Compose 依赖并等待 MySQL 就绪。空库执行基线及后续迁移，已有库查询迁移状态，查询失败时退出。数据库准备通过后启动授权通道与应用。回调就绪后先跑 `pnpm esa:deploy:dev --check`，首次正式发布再跑 `pnpm esa:deploy:dev`。本地仅做应用调试时可用 `pnpm dev:app`，真实附件读取需要可达的 ESA 回调。

## 7. 准备生产服务器

1. 在 Linux 主机装 Docker 和 Compose，准备部署用户、SSH 登录和可写的绝对部署目录。先建好或选定供应用连接 MySQL 和 Redis 的外部 Docker 网络，名字填 `EXTERNAL_DOCKER_NETWORK`。EMQX 由项目的生产 Compose 一起启动。
2. 建 MySQL 8.4 专用业务库和账号。字符集与排序规则用 `utf8mb4`／`utf8mb4_unicode_ci`，账号要能增删改查并执行项目迁移所需的 DDL。应用连接使用 UTC。准备启用密码的 Redis，限制网络访问。把容器网络内实际可达的地址和凭据填到 `.env.prod` 的 `MYSQL_*`、`REDIS_*`，填好服务端 MQTT 账号和密码。
3. 配主站 HTTPS 反代。宿主机上的反代转到 `127.0.0.1:APP_PORT`（默认 3042），反代也在容器里时用同网络的应用地址。保留 Cookie、请求体、方法和转发头，对 API 和授权回调关闭缓存。ESA 直接访问主站的 HTTPS 授权接口。
4. 配 MQTT 的两个 WSS 入口。将浏览器的 `/mqtt` 转给 `MQTT_WS_PORT`，将 `/mqtt-drafts` 转给 `MQTT_DRAFT_WS_PORT`，两个上游请求路径都用 `/mqtt`。保留 WebSocket Upgrade，完整公网地址填到 `MQTT_WEB_URL`、`MQTT_DRAFT_WEB_URL`。

应用容器中的回环地址指向应用自身。宿主机或 host 网络反代使用宿主机回环端口，bridge 反代接入应用外部网络后可用 `stupig-tv:<APP_PORT>`。保留其他项目的网络与服务。禁用旧 `cleanup --delete` cron，后台任务随应用运行时停用旧任务执行器。

## 8. 接上 GitHub、ACR 和生产发布

1. 在 ACR 个人版建命名空间和私有仓库。把完整镜像地址（`Registry 域名/命名空间/仓库名`，无 tag）填进 `.env.prod` 和 GitHub 仓库 Variable `ACR_IMAGE`。当前使用广州 `tangenty42/stupig-tv`。CI 用同一 Registry 凭据推送应用和 EMQX 镜像，生产主机用它拉取镜像。Registry 固定密码从 ACR 取得。
2. 在仓库 Settings → Secrets and variables → Actions 中添加下列项目。用服务器控制台或其他可信渠道核实 SSH 主机公钥后再填入 `SSH_KNOWN_HOSTS`。

   | 放在哪 | 填什么 |
   | --- | --- |
   | Repository Secrets | `ACR_USERNAME`、`ACR_PASSWORD`、`SSH_PRIVATE_KEY`、`SSH_KNOWN_HOSTS`、`ENV_PASSPHRASE` |
   | Repository Variables | `ACR_IMAGE`、`SSH_HOST`、`SSH_PORT`、`SSH_USER`、`DEPLOY_DIR`，维护备份按需填 `MYSQL_BACKUP_CONTAINER` |

3. 给 `main` 的 GitHub Actions 状态检查选 `check`，并启用合并前分支须为最新。核对仓库允许工作流使用的 GitHub 官方 Actions 和 `pnpm/action-setup`。工作流入口见 [Check](../../../.github/workflows/check.yml) 和 [Deploy](../../../.github/workflows/deploy.yml)。
4. 把 `.env.prod` 的占位符补齐。在本机设置与 GitHub Secret 相同的 `ENV_PASSPHRASE`，执行 `pnpm env:encrypt`、`pnpm env:check`，提交生成的 `.env.prod.gpg`。CI 使用解密后的完整配置做 ESA 预检和发布，交给服务器的运行 env 会移除 ESA 发布凭据。缓存维护凭据和应用签名密钥仍由服务器使用。
5. 首次空库先用待部署镜像和同一套 env、网络执行完整维护迁移，再启动应用。接管已有库时先备份并在副本预演，按维护发布流程做。应用通过健康门后，使用同一版本发布生产 ESA 函数。空库首次注册站点所有者账号后，由获授权的数据库维护人员设置首个管理员并验收登录：
   - 迁移只建结构，不建管理员或开发账号，也没有管理员初始化命令；
   - 站点所有者用可接收验证码的受控号码走正常注册，生产不能开启验证码调试；
   - 核对该用户的 ID、用户名和手机号，只把这一行的 `is_admin` 改为 1、`permissions` 改为 `NULL`（与控制台「设为管理员」相同），再读回确认。管理员拥有全部权限，不用拼权限列表；
   - 留下操作记录，重新登录后验证管理页和档案权限。已有库保留原身份数据，不重复初始化，也不复制开发账号的密码。

## 9. 检查一遍再开放流量

1. 用两个环境各自的 OSS 身份检查本桶可访问、跨环境拒绝。从该环境的页面上传一个测试附件，在浏览器『网络』面板检查发往 OSS 的请求。首次 `OPTIONS` 预检应成功，`Access-Control-Allow-Origin` 与页面来源一致，`Access-Control-Allow-Methods` 包含 `PUT`。随后分片 `PUT` 应成功，前端能读到 `ETag` 并完成上传。再验证图片保存和可恢复删除。
2. 跑两边的 `pnpm esa:deploy:dev --check` 和 `pnpm esa:deploy:prod --check`，确认函数和路由指向对的目标。还要看输出中的 `variables`：当前工具会报告回调地址等明文变量的差异，即使显示 `check: passed`，也要处理 `value-mismatch`；加密变量只能确认存在和类型。
3. 用测试附件验证冷读、缓存命中、HEAD、Range、不同文件名和图片跨域读取。再试无签名、会话撤销以及回调不可用，确认即使已缓存也拒绝交付。生产预热在这些检查通过后单独启用。
4. 验证生产首页与当前代码的 `/api/hooks/healthz`、两条 WSS 连接及各自的订阅权限、受控号码的短信和图形验证、ACR 推拉、首个管理员登录。生产验收前先确认应用、反代和 ESA 回调使用同一套路由。

## 初配字段与反代示例

以下示例按仓库配置整理。域名、证书和 upstream 按目标主机填写，端口与所选环境模板一起核对。

### 连接与凭据

| 配置 / 消费方 | 变量 | 含义 |
| --- | --- | --- |
| Node / Compose | NODE_ENV、APP_PORT | Compose 将 APP_PORT 映射为 Node PORT |
| db | MYSQL_HOST/PORT/USER/PASSWORD/DATABASE | 应用可达的数据库 |
| redis | REDIS_HOST/PORT/PASSWORD | 密码允许空，开发为空 |
| mqtt | MQTT_HOST/TCP_PORT/USERNAME/PASSWORD | 服务端可信内网 TCP 与发布身份 |
| mqtt.web.wsUrl | 开发 APP_PORT、MQTT_WS_PORT，生产 MQTT_WEB_URL | 开发浏览器通过同站 WSS 的 /mqtt 接收公开通知，MQTT_WS_PORT 为开发代理的回环上游端口 |
| mqtt.web.draftWsUrl | 开发 APP_PORT、MQTT_DRAFT_WS_PORT，生产 MQTT_DRAFT_WEB_URL | 开发浏览器通过同站 WSS 的 /mqtt-drafts 接收私有草稿通知，转发到专用的 8086 listener。生产反代须接到草稿 listener |
| oss.buckets.public/private | ALIYUN_OSS_* | public 与 aliyun.oss 指向同一新桶，提供静态 URL；private 默认 null，仅历史恢复时显式配置 |
| aliyun.oss | ALIYUN_OSS_ACCESS_KEY_ID/SECRET | 新 Content OSS 应用身份 |
| aliyun.esa.authKey | ALIYUN_ESA_AUTH_KEY | URL 签名/回调证明，32–128 个无空格可打印 ASCII 字符 |
| aliyun.esaPurge | ALIYUN_ESA_ACCESS_KEY_ID/SECRET、ALIYUN_ESA_SITE_ID | 维护凭据成对，启用时须提供 SiteId |
| esaFunction | ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID/SECRET、ALIYUN_ESA_SITE_ID | 仅发布工具，不进入应用运行配置 |
| aliyun.dypns | ALIYUN_DYPNS_ACCESS_KEY_ID/SECRET | PNVS 短信身份 |
| aliyun.captcha.appKey | ALIYUN_DYPNS_CAPTCHA_APP_KEY | 图形验证产品密钥，非 RAM key |
| app.auth.jwt.secret | JWT_SECRET | 至少 32 字符，轮换影响既有令牌 |
| app.otp / captcha | NUXT_OTP_DEBUG、NUXT_CAPTCHA_DEBUG | 开发默认 true；生产必须 false，loader 会拒绝生产 debug |
| Compose | ACR_IMAGE、EXTERNAL_DOCKER_NETWORK | 镜像地址不带 tag；外部网络须存在 |
| Compose / 发布回执 | APP_IMAGE、MQTT_IMAGE、CONTENT_DRAFT_PROTOCOL | Deploy 推送提交 SHA tag 并固定到实际 RepoDigest；cloud-v1 阻止跨回旧正文协议的自动恢复 |
| 开发依赖 | MYSQL_DEV_ROOT_PASSWORD、PHPMYADMIN_DEV_PORT、EMQX_DEV_DASHBOARD_PORT | 本地容器和诊断 |
| devAuthTunnel | DEV_FRP_TOKEN | 仅开发 launcher，不下发浏览器 |
| 本地 / CI 工具 | ENV_PASSPHRASE | env 密文口令，不是生产应用参数 |

变量后缀 `ID/SECRET` 表示分开的 `ACCESS_KEY_ID` 和 `ACCESS_KEY_SECRET`。具体身份与 JSON 对照只在 [RAM 清单](#4-建-ram-用户并填各自的密钥)维护。环境文件选择正确不证明云端授权成功。

### 环境 YAML

- site.url / indexable：主站地址与收录，开发关闭收录。
- oss.buckets.public：endpoint、region、bucket、publicBaseUrl，均指向本环境阿里云桶。历史 private 源默认 null；显式启用时不能与 public 指向同一桶。
- aliyun.oss：官方 OSS HTTPS endpoint、地域、桶及 Content 域名；SDK endpoint 不能填 ESA host。
- aliyun.esa.baseUrl：仅 HTTPS origin，无路径/query/用户信息，与 Content 交付域名一致。
- esaFunction.name / callbackUrl：两个不同函数、不同环境回调。开发隧道也共用此回调；只有发布命令才同步到云端。
- aliyun.oss.uploadRoleArn：保留字段，dev/prod 均为 null；当前上传不调用 STS，不需要配置上传角色策略。
- aliyun.dypns / sms / captcha：endpoint/region、签名/模板/方案、appId；迁账号时整体核对。
- aliyun.esaPurge：region 与 endpoint 成对，使用目标 ESA 接入地域。

### FRP 服务端配置

修改现有 frps 部署，保留其他代理、token 和端口。若已经配置 `allowPorts`，把本代理端口追加到原数组；不能用单条配置覆盖其他项目：

```toml
allowPorts = [
  # 保留已有项
  { single = 15550 }
]
```

`bindPort` 与代理监听地址分别由 frps 的 `bindPort`、`proxyBindAddr` 控制，详见 [frp 服务端配置](https://gofrp.org/en/docs/reference/server-configures/)。宿主机反代可映射 `127.0.0.1:15550:15550`；同一 Docker 网络中的反代使用实际服务名，例如 `http://frps:15550`。不要把反代容器的 `127.0.0.1` 当作另一个容器。

WSS 连接域名需要把 WebSocket Upgrade 转给 frps 的 7000；授权回调域名则转到本代理的 15550。TLS 在入口终止。回调路由不缓存响应，也不能绕回 ESA 的附件路由造成循环。

下面是授权 HTTPS 站点的 Nginx/OpenResty location 示例；证书和站点声明沿用现有部署管理方式，`proxy_pass` 按容器拓扑调整：

```nginx
location = /api/hooks/esa/authorize {
    limit_except POST { deny all; }
    client_max_body_size 8k;
    proxy_pass http://127.0.0.1:15550;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_connect_timeout 3s;
    proxy_read_timeout 5s;
    proxy_cache off;
    proxy_buffering off;
}

location / {
    return 404;
}
```

代理与应用还有各自的正文和签名校验。不要在反代日志中记录请求正文，其中可能含有仍有效的读取凭据。frp 的原生配置格式及环境模板见[官方说明](https://gofrp.org/en/docs/features/common/configure/)。

frpc 使用的控制域名在 HTTPS server 中转发 WebSocket 到 frps bindPort，按实际网络设置 upstream。

~~~nginx
location / {
    proxy_pass http://127.0.0.1:7000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
~~~

### 主站反代

生产主站在反代终止 TLS，以下示例中的域名、证书和 upstream 地址须换成生产主机的实际值。

```nginx
location / {
    proxy_pass http://127.0.0.1:3042;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 2m;
}
```

3042 仅为仓库默认应用端口，与 `APP_PORT` 一起核对。2 MiB 是已有网关建议值，发布前要核对允许提交的正文和批量元数据大小；若业务上限更大，应协调网关上限，不能让网关拒绝应用允许的请求。附件分片通过预签名 PUT 直接进入 OSS，不经过主站正文网关。

不要给 tRPC、登录、Content 授权回调套静态缓存。保留 Cookie、POST 请求体、请求方法及必要响应头。不要将数据库、Redis、EMQX Dashboard 或发布 TCP 端口暴露到公网。开发 Compose 对部分依赖使用宿主机端口映射，不是可直接复制的生产编排。

### 生产授权回调

回调为应用的 `POST /api/hooks/esa/authorize`，ESA 函数请求它获取当前读取决定。正常授权返回 204 并携带 `X-Content-Authorization`，拒绝返回 403；其它异常在 ESA 端按失败关闭处理。

生产可给现有应用配置独立 HTTPS 入口，或使用与 Content 读取域名不同源的主站入口。必须保持 POST JSON 与证明响应头，不重定向至登录页，不加需要浏览器交互的挑战，不缓存授权结果。该地址记录在 ESA 函数的 `CONTENT_AUTH_URL`，不是单靠修改 YAML 就能上线。

开发使用 frp 的限路径代理，生产回调不依赖开发机。函数发布见[单独发布 ESA](../3_deliver/AGENT-DESIGN.md#单独发布-esa)，开发隧道的启动与诊断见[授权隧道与 ESA 提示](../1_develop/AGENT-DESIGN.md#授权隧道与-esa-提示)。

### MQTT WSS 反代

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

草稿 listener 的上游请求路径也用 /mqtt，增加对应 location。端口与 MQTT_DRAFT_WS_PORT 一致。

~~~nginx
location /mqtt-drafts {
    proxy_pass http://127.0.0.1:8086/mqtt;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
~~~

### GitHub 仓库与 SSH 主机身份

在 GitHub 仓库 Settings → Secrets and variables → Actions 配置下表。当前 workflow 未声明 GitHub Environment，因此应配置 Repository Secrets/Variables，不能只放在尚未被 job 引用的 Environment 中。入口和权限说明见 [GitHub 官方文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variable | `ACR_IMAGE` | 完整 `registry/namespace/repository`，不带 tag；与生产 env 中同名项一致 |
| Variable | `SSH_HOST`、`SSH_PORT`、`SSH_USER` | 可从 GitHub runner 访问的服务器及部署账号 |
| Variable | `DEPLOY_DIR` | 服务器上已经创建、部署账号可写的绝对目录 |
| Variable | `MYSQL_BACKUP_CONTAINER` | 可选，维护备份使用的同主机 MySQL 容器名；省略时取应用 DB host |
| Secret | `ACR_USERNAME`、`ACR_PASSWORD` | CI 推送与服务器拉取共用的 Registry 登录凭据；当前沿用 Tangenty 的 ACR 固定密码 |
| Secret | `SSH_PRIVATE_KEY` | 部署账号对应私钥 |
| Secret | `SSH_KNOWN_HOSTS` | 经独立渠道核实的 SSH 主机公钥，采用 OpenSSH known_hosts 格式，含主机名和端口 |
| Secret | `ENV_PASSPHRASE` | 解密已提交 `.env.prod.gpg` 的口令 |

GitHub Ruleset 只要求 GitHub Actions 的 `check` 状态，仍启用“合并前分支必须最新”（strict），创建分支/仓库时不强制检查；签名、线性历史及 squash 合并约束保持独立。

调整工作流后，核对实际 Check Run 的 `name` 与来源 App，并读回 main 的有效规则；当前为 `check`、GitHub Actions（App ID 15368）。界面中的 `Check / … (pull_request)` 是展示组合，不作为完整 context 填入；无需给汇总门槛覆盖的每个分片重复添加 Required。重命名汇总 job 时必须同步规则，普通子检查改名仍由汇总依赖负责。

Check 作业组成、汇总门槛和 main 复用条件见 [SID#1.2 的 MQTT 镜像与 CI 汇总](../2_test/AGENT-DESIGN.md#mqtt-镜像与-ci-汇总)。

三个旧浏览器状态包装与独立 `verified-tree` job 已移除，普通代码 PR 展示 9 个实际 job。

Actions 权限选择 "Allow tangenty42, and select non-tangenty42, actions and reusable workflows"，勾选 "Allow actions created by GitHub"，允许列表加入 `pnpm/action-setup@*`（各工作流唯一的非 GitHub 官方 action，缺失它相关工作流会拒绝启动），并启用 "Require actions to be pinned to a full-length commit SHA"；各工作流的 action 引用已全部固定到完整提交 SHA。Linux 部署主机需有 Docker Compose、`flock` 和 `sha256sum`。

#### SSH 主机身份

启用此版本 Deploy 前，先通过服务器控制台等独立可信渠道读取 `/etc/ssh/ssh_host_ed25519_key.pub`，并用 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 核对指纹。将公钥类型和内容写入 GitHub Repository Secret `SSH_KNOWN_HOSTS`，格式为 `[主机名]:端口 ssh-ed25519 公钥内容`；端口为 22 时使用 `主机名 ssh-ed25519 公钥内容`。可放入多行以支持换钥过渡。主机公钥不是部署账号的公钥或私钥。不要直接信任部署时 `ssh-keyscan` 获得的值；如使用扫描结果，须先与独立渠道取得的指纹比较。

Deploy 在构建前检查该 Secret 含目标主机条目，SSH 和 SCP 强制验证主机密钥；Secret 缺失、主机或端口不匹配、密钥变更均会使部署失败。更换服务器或主机密钥时，先独立核对新公钥并更新 Secret，再进行部署。工作流使用的第三方 Action 固定到提交 SHA，更新版本时应核实上游提交后同步修改。
