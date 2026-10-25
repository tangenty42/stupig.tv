# 阿里云资源台账与生产收敛方案

本页记录 ACR、OSS、ESA、RAM 的实际配置与生产准备差异。操作细节见 [ACR](github-acr.md)、[OSS](oss.md)、[ESA 规则](esa.md)、[函数发布](esa-functions.md)和 [RAM](ram.md)。

## 核对范围与证据边界

2026-10-25 先使用 `tmp.env` 临时 RAM 身份只读核对云资源，随后按用户授权重建项目 RAM、收紧生产桶和 Content 规则、发布并验收开发函数；之后按用户授权进入生产维护窗口，完成数据副本预演、停写备份、Content 正式迁移、新应用和生产函数上线。下文以最新状态为准。

- 账号 `1225000469589595`，审计身份 RAM `tmp`，附加 `AdministratorAccess`。凭据只在本机进程内加载，输出与快照均脱敏。
- OSS：核对两个 Content 桶的 ACL、版本、生命周期、CORS、桶策略、阻止公共访问、加密、日志和基础元数据；后续正式迁移生成并完整读回 297 个生产目标对象，旧源对象未删除。
- ESA：共享站点全部 11 条解析、原生规则、两个函数的路由/版本/变量元数据和源码指纹、TLS、证书元数据、缓存层级及预热额度。分页数量未超过返回页容量，桶列表没有截断。源码仅在内存比较，未输出或保存源码正文。
- RAM：清理前核对前缀范围、外部绑定及角色信任；删除 4 用户、2 旧上传角色、5 旧策略，创建 10 用户、7 策略和 8 组应用 AccessKey。没有输出任何 AccessKey 值。
- ACR：个人版目标仓库、标签、构建规则、latest 元数据；企业版列表另行查询，不能以其为空推断个人版不存在。
- 新凭据已原子写入 `.env.dev` / `.env.prod`，SiteId 已补齐，`.env.prod.gpg` 已重新加密并解密逐字节核对。8 个新应用身份调用者及 OSS/ESA 权限已验证；生产 Compose 的 34 项环境值与本机解析结果一致。未发送短信或提交预热；GitHub Secrets 的值和 1Panel 备份任务未验收。
- 开发回调 POST、合法下载、HEAD/Range、动态中文文件名、跨域 Canvas、匿名机密拒绝、删减版读取及会话撤销通过。生产迁移后，候选实例及正式入口的完整下载摘要、HEAD/Range、重复读取、无签名及篡改拒绝、匿名机密拒绝与删减版读取通过。生产健康入口返回 200，24 项迁移完成。迁移与备份详情见[切换记录](../operations/content-cutover.md)。

云基础快照在 `.data/aliyun-audit-20261025/`，RAM 重建记录在 `.data/ram-setup-20261025/`，本轮收紧与在线验收记录在 `.data/esa-hardening-20261025/`，发布收据在 `.data/esa-deploy/`；均不记录密钥或完整签名 URL。这些忽略目录不是新检出仓库的依赖，旧快照不能覆盖最新读回结果。

## 环境资源对应关系

| 项目 | 开发 | 生产 |
| --- | --- | --- |
| 应用配置 | `config/dev.yaml` + `.env.dev` | `config/prod.yaml` + `.env.prod` |
| Content OSS | `stupig-static-dev` | `stupig-static` |
| 地域 / 存储 | `oss-cn-shenzhen`，Standard / ZRS | 相同 |
| Content 读取 host | `stupig-static-dev.oss.tangenty.cn` | `stupig-static.oss.tangenty.cn` |
| ESA 站点 | `tangenty.cn`，SiteId `181553031729356` | 与开发共用 |
| 套餐 / 缓存层级 | basic，`edge_regional` | 与开发共用 |
| 函数 | `stupig-content-auth-bypass-dev` | `stupig-content-auth-bypass-prod` |
| 在线发布槽位 | 本函数的 `production` | 本函数的 `production` |
| 云端普通变量中的回调 | `https://stupig-content-auth-dev.cina.cs.tangenty.com/api/content/authorize` | `https://www.stupig.tv/api/content/authorize` |
| OSS 应用 RAM | `stupig-oss-dev`，权限限开发桶 | `stupig-oss-prod`，权限限生产桶 |
| ESA 缓存维护 RAM | `stupig-esa-purge-dev`，共享站点级权限 | `stupig-esa-purge-prod`，相同策略、独立凭据 |
| ESA 发布 RAM | `stupig-esa-publish-dev`，账号级权限 | `stupig-esa-publish-prod`，相同策略、独立凭据 |
| 短信 RAM | `stupig-sms-dev` | `stupig-sms-prod`，仅发送/核验两项动作 |

原生交付规则合并覆盖两环境已生效，身份和配置文件仍需按环境管理。静态资源也已迁入两环境新桶；旧 Rains S3 只保留历史恢复材料，不再承担日常业务读取或写入。

## 上线结果与待补验收

| 优先级 | 当前事实 | 关闭条件 |
| --- | --- | --- |
| 已完成 | 生产函数已发布当前协议并同步生产变量、密钥 | 当前 production 版本 `1792910878247505140`，合法读取与签名拒绝通过 |
| 已完成 | 新应用与正式授权回调运行，主站结束维护 | `/healthz` 为 200，迁移 completed 24 项 |
| 已完成 | 生产对象复制及完整读回 | 9 篇档案、107 个文件、297 个目标对象，旧文件指针为零 |
| 待协作 | 真实生产用户的上传、替换、编辑、删除与会话撤销 | 使用合法生产账号验收；未使用开发账号或发送测试短信 |
| 已完成 | 两环境各 13 个图标和头像对象迁入新桶，静态配置与头像写入已切换 | 28 项交付检查、头像写读删除探针通过；生产首页所有图标加载，旧存储请求为零 |
| 待交付 | 本次镜像来自尚未提交的工作区快照 | 下次自动 Deploy 前提交当前代码、配置及密文，避免部署旧实现 |

初次只读审计的随机不存在路径 HEAD 为 dev 503 / prod 599；这是发布前快照，不代表当前状态。开发正式发布后，无签名、篡改、过期、未来时间、失效引用版本及已撤销会话均返回 403。生产正式发布后合法读取为 200/206，无签名及篡改为 403；未重做的生产会话撤销不得引用开发结果代替。

## OSS：保留什么，调整什么

| 配置 | 当前 dev / prod | 建议 |
| --- | --- | --- |
| ACL / Bucket Policy | 均 private；均无自定义桶策略 | 保持私有 |
| 阻止公共访问 | dev true / prod true；生产已从 false 改为 true 并读回 | 保持；未改账号级开关 |
| 版本控制 | 均 Enabled | 保留；应用继续禁止永久删除历史版本 |
| 非当前版本 | 两桶均 7 天，全桶范围 | 确定对象恢复窗口，保证能覆盖数据库备份的保留期；可评估 30 天成本后调整 |
| 过期删除标记 | 自动清理 | 结合历史版本保留审查 |
| multipart 生命周期 | 均无云端兜底规则 | 若添加，过期时间必须长于合法暂停/续传与维护窗口，先核对[上传模型](../modules/content/uploads.md) |
| CORS 来源 | localhost:3042 / www.stupig.tv，精确对应环境 | 保持精确来源 |
| CORS 方法 | 均 GET/POST/PUT/DELETE/HEAD | 当前浏览器上传路径只需 PUT，可收窄后实测；CORS 不授予对象权限 |
| CORS 其他 | Headers `*`，Expose `ETag,x-oss-request-id`，MaxAge 0 | 保留必要暴露头，可评估适度预检缓存 |
| 默认服务端加密 | 均无，算法 None | 可选 OSS 管理 AES256 静态加密，单独评估，不替代 ACL |
| 日志 / AccessMonitor | 均未开 | 可按排障需求启用并限制保留期 |

阻止公共访问的多层级关系见[官方说明](https://help.aliyun.com/zh/oss/user-guide/block-public-access/)。本轮没有重新读取账号级开关，不能将桶级 false 扩大解释为所有匿名请求都允许。版本到期会永久清理历史对象，见[版本生命周期](https://help.aliyun.com/zh/oss/user-guide/configure-lifecycle-rules-to-manage-object-versions)；1Panel 数据库备份不能保证远端 OSS 历史对象仍存在。

## ESA：规则差异与收敛目标

### 已合并的原生交付规则

下表业务规则都启用，并覆盖精确的 dev/prod 两个 Content host。除文件名规则外，路径条件均为 `starts_with(http.request.uri, "/content/")`；没有将其他项目域名并入本业务范围。

| 规则 | ConfigId | 当前值 |
| --- | --- | --- |
| Cache `stupig-content-cache` | `524586192056320` | cache_all、override_origin、ignore_all query、TTL 94608000；4xx/5xx TTL 0，浏览器 follow_origin |
| Origin `stupig-content-range` | `524586192062464` | Range force，1 MiB |
| Rewrite `stupig-content-origin` | `524937324517376` | query 静态改写；值字段省略，仍需 MISS 验收实际清空效果 |
| Response `stupig-content-response` | `524939084019712` | private/no-store、CORS、交付标识，删除 Allow-Credentials |
| Response `stupig-content-filename` | `524939241297920` | 两 host AND `/content/` 前缀 AND full_uri 中 `?` / `&` 参数条件，动态 Content-Disposition；已读回并验证中文文件名不串头 |

缓存 `test` / `test2` 和响应头 `test` 均已停用。已修改 filename 的路径范围及 Content Range 规则的 OriginScheme=https；Range force / 1MB 和其他项目的回源规则读回保持不变。

文件名规则已采用[ESA 手册](esa.md#规则匹配与已知兼容边界)中的整体 AND 结构。相同对象连续使用中文、空格、`#`、`%` 下载名，响应头分别匹配且字节摘要一致。出站响应头按顺序执行，后续同名头会覆盖前项，见[官方说明](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/modify-outgoing-response-header)。

旁路 `http.request.uri.path` 历史问题未重做字段对照实验；继续用 `uri` 匹配路径、`full_uri` 匹配文件名参数。Content 回源规则已显式设置 HTTPS；开发定点刷新后冷请求仍为 200，第二次 Age 为 2，源文件与两次下载摘要一致。生产冷回源仍待验收，见[回源协议](https://help.aliyun.com/en/edge-security-acceleration/esa/user-guide/back-to-source-protocols-and-ports)。

### 函数现状与回退限制

| 环境 / 槽位 | 在线版本与流量 | 源码核对 |
| --- | --- | --- |
| dev production | `1792908841699827968`，100% | 当前仓库代码；源码摘要一致，绑定 production 变量，回调超时已恢复为 5000 ms |
| dev staging | `1792861832639509322`，100% | 与生产示例代码相同的 321 字节版本 |
| prod production | `1792910878247505140`，100% | 当前仓库代码，已绑定生产变量，真实鉴权和交付通过 |
| prod staging | `1792862221572355804`，100% | Hello World 示例，不含当前回调协议；不可作为安全回退 |

以 LF 规范化比较，仓库与两环境当前 production 槽位源码摘要均为 `be077ae8d38700cb609cab376a16f41e72fb549ca5f0d46e4a8f59a9270039b6`。最新双环境读回在 `.data/content-prod-20261025/final-code.json`，生产发布收据在 `.data/esa-deploy/prod-2026-10-25T06-47-46-452Z-46ed1fe0-897f-4f98-b4ec-b81cb8596a1c.json`。

两条路由均为 custom、RouteEnable on、Bypass on、Fallback off、全 `/content/` 范围。dev ConfigId `526293271689216`，prod `526294458679296`，分别为 Sequence 1/2，不存在当前两函数之间的 host 重叠。

两函数的普通变量包含对应回调和超时 5000，密钥为不可读回的 secret_text；当前 production 版本均已绑定相应变量。变量存在不证明代码使用了它们，仍需合法读取和拒绝检查，见[官方说明](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/function-variable)。

开发在线验收已通过 17 项读取与拒绝检查：完整下载与 OSS 源对象 SHA-256 一致、HEAD、Range、重复读取、无签名/篡改/过期/未来时间拒绝、失效引用版本拒绝、两个中文文件名独立、匿名普通版机密拒绝、删减版允许、管理员机密读取，以及会话退出后 GET/HEAD/Range 均为 403。浏览器图片渲染和匿名 CORS Canvas 读取通过。定点刷新后的冷下载和后续 Age=2 的读取字节一致。

生产候选实例和正式入口分别通过 8 项真实读取与拒绝检查：完整下载与迁移回执 SHA-256 一致、HEAD、Range、重复读取、无签名拒绝、文件名篡改拒绝、匿名机密原版拒绝及删减版读取。浏览器生产档案页打开、签名图片加载和匿名 CORS Canvas 读取通过；未模拟生产登录身份。

另短暂发布 1 ms 回调超时进行真实失败关闭测试：已缓存对象的 GET/HEAD/Range 均返回 503；随后恢复 5000 ms 并确认下载恢复 200。两次控制面到数据面的传播约 10–11 秒，不能在部署 ACK 后立即断言业务版本已切换。记录见 `.data/esa-hardening-20261025/acceptance.json`、`cold-read.json` 和 `fail-closed-confirmed.json`；首次未等待传播的试验保留在 `fail-closed.json`，不作为成功证据。

当前 staging 示例和旧开发代码均不能作为当前授权协议的安全回退。回退需要同环境变量、代码协议与应用版本兼容，不能为了恢复下载切换到示例或只验签的实现。

### 共享站点设置

- 两个 Content DNS 均启用代理，分别指向正确 OSS 桶，AuthType `private_same_account`，Host 跟随源站。私有源站授权让 ESA 能读取对象，不等同于应用授权边界。
- HTTPS、强制 HTTPS、HTTP/3 开；TLS 1.0 关，TLS 1.1/1.2/1.3 开；HTTP/2 关、OCSP stapling 关、cipher group all。建议关闭 TLS 1.1、开启 HTTP/2；这是共享站点变更，需覆盖其他域名验收。
- HSTS max-age 15552000，未覆盖子域或 preload；不因本次上线盲目扩大。
- 证书仅读取了元数据，不能替代目标域名 HTTPS 实际验收。规则、证书与私有回源仍需一起维护。

### 预热额度

当前 basic / edge_regional。`GetPurgeQuota(Type=preload)` 为 Quota 10000、Usage 0、Quota30Day 0、Usage30Day 7；0 的 30 天配额表示未设置，见[额度 API](https://help.aliyun.com/zh/edge-security-acceleration/esa/api-esa-2024-09-10-getpurgequota)。

开发、生产和其他业务共享站点，不能按环境重复计算额度。保留应用默认每日 500 / 云额度预留 1000，生产继续 `enabled=false`、`deliveryVerified=false`；在代码与合法交付、鉴权和预热缓存复用验收完成后再开启。

## RAM 与 ACR 的收敛

### 已配置的身份与验证

- 用户与策略按 [RAM 清单](ram.md)全部建立：8 个 OSS/ESA/短信用户各有 1 个活动 key，2 个 ACR 用户未创建 AccessKey。后续用户曾实际登录 push 控制台；当前两个 ACR 用户保留备用，不参与交付。各用户仅绑定 1 份原定策略，无用户组附加权限。
- 7 份云策略与 config/ram 对应 JSON 语义一致；两份 OSS 策略已升为 v3：v2 增加 `imgs/*`、`avatar/*` 对象操作，v3 增加指定桶的 `ListObjects` 元数据盘点，其余策略仍为 v1。后补的 ACR 初始化策略已从两个用户解绑并删除；撤销收据为 `.data/ram-acr-console-20261025/rollback-receipt.json`。OSS dev/prod 分桶，缓存策略固定账号与 SiteId，发布/短信保持接口要求的账号级范围；未改动原推拉策略或任何 Registry 密码。
- 旧 4 用户、2 上传角色和 5 旧策略已删除；当前全部 `stupig-` 用户/策略恰好等于新清单，没有额外前缀角色。当前上传不需要 STS 角色，因此未另建替代上传角色。
- 新凭据实际验证：8 个 STS 调用者均匹配对应用户；OSS 两环境各自 GetBucketVersioning 返回 Enabled，读取另一环境桶均 403 AccessDenied；ESA 额度与层级读取成功；两个 `esa:deploy:* --check` 均通过。
- 非 `stupig-` 用户及角色的名称和 ID 均保留，包含 `tmp`、其他项目身份和 `AliyunESAAccessingPrivateOSSRole`。旧 `acr-admin` / `dypns-admin` 未纳入删除范围；短信应用本机配置已切到新身份。
- 新个人版仅允许一个 RAM 子账号设置 Registry 密码，用户确认此前一直使用主账号 Tangenty 的 Registry 密码，因此已按用户要求撤回双 RAM 方案。CI 与主机共用 `ACR_USERNAME/PASSWORD`，保留 SSH stdin 传递及 Docker `--password-stdin`；本轮通过服务器既有 Registry 登录完成镜像推拉，未修改 GitHub Secrets 或 Registry 密码。见 [ACR](github-acr.md#推拉身份)。

上述身份验证不代替上传/替换/删除或短信发送验收。删除旧身份后，任何仍运行并缓存旧凭据的外部进程都需改用新配置；本次已重新部署生产应用并核对环境，未重启整台服务器或修改 GitHub Secrets。

### ACR 已确认状态

个人版仓库仍为 PRIVATE/NORMAL，广州，ID `5065568`：

```text
crpi-kadmhbmp7xfn6991.cn-guangzhou.personal.cr.aliyuncs.com/tangenty42/stupig-tv
```

2026-10-25 已推送并拉取不可变 tag `20261025-033a7961`，将 `latest` 同步为 digest `sha256:d8b15fa90044f636dec9c5dfda9a00797ecd69e8cf3f6cde0bfd81bed33ae98a`，正式容器镜像一致。旧 digest `sha256:99c79b2bcf9a476e2d3afd204ef4ab3dd04d4fcf3bd4c118414532409fc77660` 保留为 `pre-cutover-20261025`。本次通过 SSH 交付工作区快照，未触发 GitHub 自动部署；构建规则为空，repoBuildType=AUTO_BUILD 不证明有运行中的自动构建规则。

后续静态资源切换已上线 tag `20261025-abbaa0e9`，当时镜像身份为 `sha256:a004616641295594d7b1656a5ed9d87c216b2b8df217f31964fcc4018f94821e`。源码快照摘要为 `f52ee7c70dd1c0d3f07fc9bb5c58f1f579b13af3e35956ab672e4671e10bf0ad`；运行环境不含 `OSS_PUBLIC_*` / `OSS_PRIVATE_*`。静态迁移与交付回执在 `.data/content-prod-20261025/static-copy.json`、`static-delivery.json`、`static-release/public-smoke.json`。

当前 `latest` 和正式容器已更新为全桶对账版本 `20261025-e9f50d4e`，镜像身份为 `sha256:0d6b0331172631f908d017f189becc3b92ca96d028039574991bad080c5f69c1`，源码快照摘要 `23255c1c34127ae82b900de66c80fc4d3fa68e3c207fe713e4c5e21ffd67b8d2`。迁移账本 25 项 completed，候选与公开入口各 8 项交付检查通过，生产首轮对账检查 405 个引用和 313 个对象且无异常。应用 OSS RAM 策略 v3 增加指定桶的 `oss:ListObjects`；函数版本未改动。该工作区仍需提交后才能由后续 CI 正确交付。

后续建议保留不可变发布 tag/digest。个人版目标资源形如 `acs:cr:cn-guangzhou:1225000469589595:repository/tangenty42/stupig-tv`；仓库 RAM 策略见[官方访问控制](https://help.aliyun.com/zh/acr/user-guide/repository-access-control)。当前 workflow 仍只推 latest，CI 与服务器共用 GitHub `ACR_USERNAME/PASSWORD`，不需要独立 pull Secrets。Registry 密码不能用 `tmp.env` 的管理员 AccessKey 代替。

## 配置怎样统一

保留 shared → dev/prod + `.env.dev/.env.prod` 分层。相同的 ESA 原生行为已通过一套双 host 规则共用，无需再复制一套生产规则；函数、回调、桶、读取密钥仍按环境区分。

| 项目 | 当前来源及下一步 |
| --- | --- |
| 共同超时、URL TTL、后台预算 | `config/shared.yaml` |
| 桶、域名、函数名、回调 | dev/prod YAML，声明与云端目标吻合 |
| OSS 应用凭据 | dev/prod env 已分别写入新身份；分桶正向/越界读取验证通过 |
| ESA 维护 / 发布凭据 | dev/prod env 已分别写入独立用户的新凭据，两环境只读预检通过 |
| SiteId | 两环境已写入 `ALIYUN_ESA_SITE_ID=181553031729356`；这是非秘密资源标识 |
| 共享读取密钥 | 本机两环境均有合法格式、彼此不同；云端只可确认存在，正式发布同步绑定 |
| 发布入口 | `pnpm esa:deploy:dev/prod` 共用实现；计划/检查不自动部署 |
| RAM 策略 | [config/ram](../../config/ram/) 已应用并读回一致；后续改文件仍需显式应用，不会随代码自动改云端 |

本轮已重建 RAM、同步凭据和密文、收紧云规则、发布两环境函数、完成生产迁移及应用上线；未提交预热。临时执行脚本带有目标约束及收据，不是长期云管理入口。

## 推生产的操作顺序

1. **核对交付**：本机生产身份、SiteId 和密文已更新；另核对 GitHub 解密口令、ACR Registry 登录及目标服务器接入，不能假定本机文件已进入线上进程。
2. **保持开发验收结果**：当前已发布并通过读取、签名拒绝、会话撤销、回调超时、冷回源、缓存复用、HEAD/Range、文件名及 Canvas 检查；后续代码/权限链变动需复测对应组合。
3. **核对生产云配置**：生产桶阻止公共访问、文件名 Content 路径和显式 HTTPS 回源已完成并读回；生产真实上传及读取在部署后单独验收。
4. **安排生产维护与数据切换**：备份旧镜像/配置、数据库和 OSS 对象恢复材料；按[完整 Content 切换](../operations/content-cutover.md)先在副本预演，再执行维护迁移。本次已完成；后续新增迁移仍按其独立前置要求执行。
5. **部署应用、发布生产函数**：CI 当前依次预检、推镜像、应用健康门、函数发布。本次已同步上线应用与正确函数版本；二者不是原子事务，失败按记录处理，不盲目回滚任一侧。
6. **业务验收后开放**：普通/机密/删减版、上传替换、不同下载名、Canvas、缓存命中后撤权、删除、会话撤销和回调中断；预热最后单独开启。
7. **保留恢复窗口**：按[备份恢复](../operations/backup-recovery.md)人工操作，同时保留可用对象版本与镜像材料；恢复数据库不代表对象、函数和应用自动一致。

## 文档如何维护

本页维护云端读回事实和优先级；[配置](configuration.md)维护字段来源；产品页维护操作步骤；[部署总览](README.md)维护跨服务顺序。每次变更记录环境、资源、版本、规则 ID、读回结果和业务验收，禁止保存密钥、完整签名 URL、回调证明或对象正文。临时管理员凭据不加入应用、CI 或函数变量；不再需要时由用户停用，本轮未撤销。
