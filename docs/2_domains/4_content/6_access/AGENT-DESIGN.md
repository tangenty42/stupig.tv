# AGENT-DESIGN：附件读取的实现

- 本文档状态：PENDING（初稿，待人类审阅）
- 覆盖范围：谁能读哪个附件、固定链接与签名地址、边缘鉴权、下载、无权时的显示
- 对应 LAW：[SID#2.4.6.LAW](LAW.md)；原图的权限见 `5_images`；删减版的判定见 `4_attachments`；存储与 ESA 配置见 `7_storage` 和 `SID#1.0`

## 入口

| 位置 | 内容 |
| --- | --- |
| `server/api/links/attachments/[id].ts` | 固定链接 `/api/links/attachments/<id>?version=…&role=…`，302 到签名地址 |
| `server/services/content/attachment-access.service.ts` | `attachment_redirect`、`resolve_attachment_role`、`resolve_attachment_delivery`、`require_attachment_read`、`require_original_read` |
| `server/services/content/upload.service.ts` 的 `sign_attachment_download` | 附件目录右键「下载」；tRPC `content.signAttachmentDownload` |
| `server/lib/esa.ts`、`server/lib/esa-access.ts` | 签名地址和其中的读取凭据（grant） |
| `config/esa/content-auth.mjs` | ESA 边缘函数：验签名，再回调本站鉴权 |
| `server/api/hooks/esa/authorize.post.ts`、`server/services/content/edge-read.service.ts` | 鉴权回调 `authorize_edge_read` |
| `server/services/content-attachments.service.ts` 的 `format_row`、`attachment_object_url`、`attachment_access_version` | 下发给前端的附件数据和固定链接 |
| `server/shared/content-placeholder.ts` | 无权时的占位文字，样式见 [SID#2.4.2.AGENT-DESIGN](../2_markdown/AGENT-DESIGN.md#统一占位) |

## 谁能读

| 对象 | 条件 | 无权时 |
| --- | --- | --- |
| 公开附件、删减版 | 任何人，不用登录 | — |
| 机密附件 | 『机密可读』（『完全』包含它） | 有删减版就给删减版，没有就 403“你没有机密附件的读取权限” |
| 原图 | 『机密可读』，不论附件是否机密 | 403“你没有原图的读取权限”，没有删减版代替 |
| 文件夹 | 不能读，固定链接只查 `is_folder = 0` 的行 | 404 |

- 附件目录数据含机密附件的名称、大小和 `version`（ETag）。无机密读取权限时，完整版的 `url` 为空，存在删减版时仍下发 `redacted_url`。正文的无权占位适用于没有可读删减版的引用。
- 图片默认给显示版（WebP）；`Accept` 不含 `image/webp` 时给备用版（JPEG）。

## 固定链接与签名地址

1. 正文和附件数据里只放固定链接，不放会过期的地址。`version` 是 `attachment_access_version`：ETag、对象键、桶、机密状态、OSS 版本号和删减版修订号的 sha256。对象键和 OSS 版本号不下发，没有权限的人算不出机密附件的当前 `version`；
2. `attachment_redirect` 按顺序检查：
   - 行不存在、`version` 不对：一律 404“附件不存在或已变化，请刷新后重试”；
   - 机密、无权且没有删减版：403；
   - 其余交给 `resolve_attachment_delivery` 选对象并生成 grant；
3. 版本必须先于权限检查，否则任何人逐个试编号就能分出已删、机密、公开（人类 2026-11-19 裁定）；
4. grant 记下附件编号、签出人的会话和令牌代次、读取角色，以及当时授权所依赖字段的哈希（`revision`），一起签进地址；
5. 签名地址有效期为 `min(请求的有效期, aliyun.esa.urlTtlSeconds)`：页面读取 `app.content.read.urlTtlSeconds` 为 3600 秒，下载 `app.content.download.urlTtlSeconds` 为 300 秒，上限 3600 秒。上限须与边缘函数的 `TTL_SECONDS` 一致。

## 边缘鉴权

每个到 ESA `/content/` 的请求，包括缓存命中、HEAD 和 Range，都先进边缘函数：

1. `authorize_content_request` 验签名、有效期（允许 30 秒时钟偏差）、参数名和编码；
2. `create_content_authorizer` POST 到 `CONTENT_AUTH_URL`（本站 `/api/hooks/esa/authorize`），超时 5000 ms；
3. `authorize_edge_read` 在主库事务里重新查签出人的会话、令牌、封禁和权限，再查附件行，用 `resolve_attachment_delivery` 重算对象键和 `revision`，都一致才回 204 加 `X-Content-Authorization` 证明；
4. 边缘函数核对证明后放行（`ResponseBypass(true)`），字节由 ESA 缓存或回源送出；任何拒绝、超时或证明不符都不放行，不缓存允许结果。

签名格式（`content-auth.mjs`、`server/lib/esa.ts`）：

- `auth_key` 为 `v2-<签发时刻>-<到期时刻>-<32 位十六进制 nonce>-<64 位十六进制签名>`；
- 签名是 HMAC-SHA256，内容为 JSON `['content-url-v2', origin, pathname, ['GET','HEAD'], 签发, 到期, nonce, 文件名参数, access]`，按恒定时间比较；
- 查询参数只允许 `auth_key`、`response-content-disposition`、`access`，各最多一个；编码与签名方生成的不一致就拒绝；
- 旧的 MD5 式签名链接一律拒绝。

由此：

- 签出人退出登录、被封禁、权限变了，附件被替换、改机密、删减版变了，下一次请求就失败；
- 边缘只核对签出人，不核对打开的人。有效期内签名地址转给别人也能打开，机密附件也一样（人类 2026-11-19 接受）；
- 鉴权只在请求开头做一次。一次 GET 开始后过了有效期不会中断；ESA 回源的 1 MB Range 分片对浏览器不可见。但浏览器的新请求（播放器续读、拖进度、续传下载）用的还是那个签名地址，过期后失败。

## 下载

- 档案详情和编辑页都能从附件目录发起下载。详情页目录为只读，仍可下载有权读取的附件。双击普通文件也会发起下载。
- `sign_attachment_download` 按档案和路径找行，签 `Content-Disposition: attachment`，有效期 300 秒；
- 下载名：图片显示版和备用版换成实际格式的扩展名（`image_download_name`），原图用上传时记下的名字，其他用附件名（`attachment_download_name`）；
- 附件目录里双击图片：能读显示版就预览显示版，否则有删减版就预览删减版；其他附件不做这种回退（`app/features/content/attachments/panel.ts`）。

## 无权时的显示

- 正文里的 `<good>` 内容在服务端换成占位“你无权查看此处的机密内容”（`redact_private_content`），原文不出服务端；
- 无权、且没有删减版的机密附件卡片和图片，渲染成占位“你无权查看此处的机密附件”；有删减版时渲染删减版，见 [SID#2.4.2.AGENT-DESIGN](../2_markdown/AGENT-DESIGN.md#正文里的机密附件)；
- 档案详情页也展示附件目录。机密条目的名称和项目正常显示，能打开、预览或下载的内容随读取权限决定。
- 双击附件行或按 Enter 时先判断当前读取权限。存在可预览的图片删减版时按上面的回退规则打开。附件行及正文普通链接因机密权限拦截打开时，提示「无权打开此机密附件！」。
- 前端收到机密权限变化后，正文按当前权限处理目录快照中的附件引用。有公开删减版时换成删减版，否则换成无权占位。点击正文中仍指向已知不可读机密地址的普通链接时拦截导航并提示。固定链接的服务端鉴权仍按请求时的权限执行。
