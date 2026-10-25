# ESA 解析、缓存、回源与响应头

本页定义当前 Content 交付所需的原生 ESA 规则，与[边缘函数](esa-functions.md)共同生效。规则范围只覆盖对应环境的 Content 域名和 `/content/`；主站 API、旧静态资源域名和 MQTT 不应套用这些缓存设置。

核对日期：2026-10-25。缓存、Range、query 重写及响应头共用精确 dev/prod 两 host；文件名规则已补齐 Content 路径，Content 回源已明确 HTTPS。开发与生产函数均已发布当前回调协议。生产新应用及 Content 迁移已完成，完整下载、HEAD/Range、匿名权限和删减版读取通过；开发另完成会话撤销、回调故障与 Canvas 冒烟。见[资源台账](aliyun.md#esa规则差异与收敛目标)，未执行的生产登录操作需单独验收。

## 请求链路

```text
浏览器签名 GET / HEAD（含 Range）
  → ESA Content 旁路函数校验签名、请求当前授权
  → 放行后进入原生缓存查找
  → MISS 时清除回源 query、用私有 OSS 授权回源
  → 原生缓存对象字节
  → ESA 到客户端规则设置当前文件名、CORS、private/no-store
```

边缘长缓存只缓存对象，不能缓存『用户仍被授权』这个决定。权限修改/删除成功后的新请求应被在线回调拒绝，即使原对象已经 HIT。对象清理和刷新负责存储/缓存治理，不是授权撤销的等待条件。

## DNS、TLS 与源站

1. 将站点以账号实际的 NS 或 CNAME 接入方式接入 ESA，确认站点可用。
2. 为 `aliyun.esa.baseUrl` 中的精确主机创建启用代理的 DNS 记录，并关联当前环境 OSS 源站。dev/prod 域名与桶不能交叉。
3. 客户端证书覆盖该域名，应用配置只允许 HTTPS base URL。OSS 回源协议同样使用 HTTPS。
4. 使用桶的官方域名作为源站/Host/SNI 对照值，例如 `<bucket>.oss-cn-shenzhen.aliyuncs.com`；若改用自定义回源 Host，须先完成相应 OSS 域名绑定并验证。不要将加速域名回源到自身。
5. 开启该记录的私有 OSS 回源授权；客户端传来的应用签名不能替代 ESA 对 OSS 的授权。不要把 OSS 桶改成公有读来绕过配置问题。

ESA 私有回源会赋予加速链路读取私有桶的能力，所以必须同时保证 Content 路由无法绕过。首次一键授权的范围可能覆盖账号下多个桶，应核对生成的角色/策略及替代自定义授权方式。产品说明见[私有 OSS 加速](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/use-esa-to-accelerate-oss-resource-access)。

## 规则匹配与已知兼容边界

2026-10-24 用户确认：旁路模式下原生规则的 `http.request.uri.path` 匹配异常仍然存在。现有规避是用 `http.request.uri` 匹配路径前缀；这是兼容写法，不代表平台问题已经修复。本轮只读审计没有重跑该问题的在线对照实验，迁移规则时继续保留并验证。

2026-10-25 读回：业务规则使用 `http.request.uri` 和 `/content/`，两 host 共用配置。缓存 `test` / `test2` 与响应头 `test` 已停用；文件名规则已补齐下述 Content 路径范围。未修改其他项目的规则。

原生缓存/回源/出站规则的开发范围示例：

```text
(http.host eq "stupig-static-dev.oss.tangenty.cn"
 and starts_with(http.request.uri, "/content/"))
```

生产将 host 换成已确认的生产 Content 域名。这里的 `http.request.uri` 是路径加查询串，不含 origin。边缘函数路由自身也必须覆盖全部 Content 请求；函数路由的实际条件和三个安全开关见[函数路由](esa-functions.md)。不要把原生规则的历史问题推导成可以缩小鉴权覆盖范围。

动态文件名规则再叠加精确参数边界，保留云端审计快照中使用的 `full_uri` 字段：

```text
(http.request.full_uri contains "?response-content-disposition="
 or http.request.full_uri contains "&response-content-disposition=")
```

该 OR 条件须与 host/Content 前缀整体 AND，避免匹配其它域名。授权前不重排、删除或重新编码签名查询参数；函数严格校验参数名、编码和签名元数据。

2026-10-25 控制台截图显示，将上述两个参数条件改成 `http.request.uri contains ...` 后提示『表达式不受生成器支持』。这不能单独证明规则引擎拒绝该表达式：官方区分能力受限的图形生成器和更灵活的表达式编辑器，实际保存结果及运行匹配仍需分别核对。这里继续使用已有云端配置的 `full_uri` 参数条件，不为字段命名统一而替换。路径前缀仍使用 `uri`；`full_uri` 还包含协议和主机，不能直接替换进 `starts_with(..., "/content/")`。见[规则编辑方式](https://help.aliyun.com/zh/edge-security-acceleration/esa/rules-engine)和[字段定义](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/phase-list)。

## 缓存规则

| 项目 | 需要的行为 |
| --- | --- |
| 范围 | 精确 Content host + `/content/`，优先于冲突的宽泛规则 |
| 缓存键 | 忽略全部 query，使同一不可变对象的不同签名和下载名共用缓存 |
| 边缘 TTL | 对成功对象设置明确的长 TTL；实际生产值由控制台核对，不从 URL 300 秒有效期推导 |
| 源站 Cache-Control | OSS 对象是 private/no-store；需要在受鉴权保护的此范围采用忽略源站策略/自定义边缘 TTL，并用 MISS→HIT 验证 |
| 浏览器 TTL | 不强制长缓存；最终响应保持 `private, no-store` |
| 错误/授权响应 | 不缓存 403/5xx 或授权回调；不得启用正向授权缓存 |

『缓存键忽略 query』与『回源清除 query』是两项独立设置。当前对象 key 不可变，因此图片覆盖产生新的对象身份，不靠短 TTL 更新旧字节。缓存功能与源站策略处理见[全局缓存配置](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/global-cache-configuration-overview/)及[缓存异常说明](https://help.aliyun.com/zh/edge-security-acceleration/esa/support/cache-exception-or-stale-content)。

本次共用业务缓存规则读回 TTL 为 94608000 秒，覆盖开发和生产；该值不是所有站点的硬编码要求。部署记录应写明最终有效 TTL 与规则 ID，函数代码和授权配置完成后重新验证 MISS→HIT。

## 回源 URL 与 Range

在转换规则的重写 URL 中：保留路径，查询字符串改为静态空串。此改写只能在回源阶段发生，不能剥掉送往鉴权函数的原始 `auth_key`、`access` 或文件名参数。官方明确 URL 重写发生在缓存查找之后，且不改变缓存键，见[重写 URL](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/rewrite-url)。

开启 Content 的 Range 回源；开发曾采用 1 MiB 分片，生产应结合源站和大文件实测确认大小。源站必须能正确返回 206，参考 [Range 分片](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/range-requests/)。Range、If-Range、ETag、Content-Range 的语义保持一致，不能把一次局部 206 当完整对象缓存返回。

## ESA 到客户端响应头

在规则 → 转换规则 → 修改响应头中选择 **ESA 到客户端**，对上述 Content 范围添加/覆盖：

| Header | 值 |
| --- | --- |
| `Cache-Control` | `private, no-store` |
| `Access-Control-Allow-Origin` | `*` |
| `Access-Control-Expose-Headers` | `Content-Disposition, Content-Length, Content-Range, Accept-Ranges, ETag` |
| `X-Content-Delivery` | `esa-bypass`，用于辨认交付路径 |
| `Access-Control-Allow-Credentials` | 删除，不设为 true |

这是匿名跨域的签名 URL 读取方式，前端不需要跨域 Cookie。不要把浏览器的 `private, no-store` 写成同一条入站缓存禁止规则，否则会破坏边缘缓存目标。

文件名规则动态设置 `Content-Disposition`，按现有接口使用的参数读取：

```text
concat("", http.request.uri.args["response-content-disposition"])
```

参数值的协议由应用签名保护；云端表达式的可保存性、实际解码层数及回源重写后的取值仍须在目标站点验证。不要追加没有依据的 `[0]` 或把文件名静态缓存进对象。必须验证中文、空格、`#`、`%`，同一缓存对象连续用不同文件名下载不串头。

出站规则会按列表依次执行，同名 header 可能被后续规则覆盖；不能假定命中第一条后停止。将全局宽泛规则和 Content 专用规则一起检查最终效果，见[官方出站响应头](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/modify-outgoing-response-header)。

## 自动预热与额度

每轮扫描在首个待提交项读取 ESA 日额度、30 天额度及缓存架构快照，随后逐项在事务内核算本地预算。预算按 UTC+8 自然日记账，30 天窗口包含当天及前 29 天；默认每日最多提交 500、预留云端额度 1000、单对象不超过 20 MiB。一张双格式图片可能消耗两条提交预算。最多提交 3 次含首次，只有明确失败才重提，未知结果先对账。关闭 enabled 会停止新提交，但已进入 submitting/polling 的任务继续对账并保留对象退役保护。配置和对账见[对象生命周期](../modules/content/object-lifecycle.md)。

官方套餐表在本次查阅时列出基础版即时预热支持量 10000，免费版不支持；本账号读回 basic、每日 Quota 10000，Quota30Day 0 表示未设置 30 天配额。dev/prod 共用站点；提交时仍以 `GetPurgeQuota(Type=preload)` 最新值为准，不把应用的 500 当成套餐限制。[预热说明](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/warm-up-cache)、[额度 API](https://help.aliyun.com/zh/edge-security-acceleration/esa/api-esa-2024-09-10-getpurgequota)。

仅 edge 单层缓存时应用不提交预热。官方还说明预热不应用 URL 重写规则；本项目提交的是无签名/无 query 的规范对象 URL，不能依赖重写把另一个路径变成真实 key。预热 URL 的 hostname 必须是目标站点内启用代理的 DNS 记录，见[PreloadCaches](https://help.aliyun.com/zh/edge-security-acceleration/esa/api-esa-2024-09-10-preloadcaches)。

```powershell
pnpm content:preload:check --policy
pnpm content:preload:check
```

这两条不提交预热。生产 `enabled` 和 `deliveryVerified` 仍默认 false；只有原生预热完成、合法请求复用缓存、无权限仍拒绝、OSS 仍私有都验收后才开启。

## 必须验收的组合

冷 GET → 新签名 HIT → HEAD → 冷 Range 206 → 完整下载校验；改名后新文件名；图片跨域 Canvas；无签名/篡改/过期/未来时间拒绝；缓存 HIT 后机密切换、删除、替换、会话撤销导致旧授权拒绝；回调中断时 GET/HEAD/Range 都不能交付字节。

仅有 HIT 不能证明鉴权安全，仅有 403 也不能证明合法交付正常。规则调整后两组都需检查。
