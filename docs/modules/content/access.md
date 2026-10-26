# Content 权限、预览与下载

『机密』是应用访问控制状态。当前新 Content 对象在 OSS 中都保持 private，公开附件也不是匿名开放桶对象；公开与机密由应用和 ESA 授权链路区分。`.good` 是逻辑路径的 ACL 标记，不表示新文件经过 AES 加密。

## 机密声明与继承

路径任一段以 `.good` 结尾时，该路径具有机密属性。文件可以独立声明，目录可以使全部后代继承：

| 路径 | 有效状态 |
| --- | --- |
| `docs/a.pdf` | 公开 |
| `docs/a.pdf.good` | 文件自行声明机密 |
| `private.good/a.pdf` | 从父目录继承机密 |
| `private.good/sub/a.pdf.good` | 父目录继承，同时保留自身声明 |

直接多文件上传和文件夹上传使用同一判定。目录设为机密／取消机密通过工作区通道更新后代的有效状态和读取版本。子文件不能单独取消来自父目录的继承；移出机密目录后按新路径重新计算，自身 `.good` 声明仍生效。

`content_manage:full` 负责内容管理，`content_private:read` 负责机密读取；涉及机密像素或权限改变的服务操作需要相应权限。客户端的颜色和锁只是有效状态的展示。

## 正文与附件投影

无机密读取权限时，`getStoryBody` 在服务端删减 `<good>` 片段，再返回 Markdown；正文响应不包含附件数组或解密材料。附件工作区单独返回当前访问者可以使用的地址和图片表示。

机密图片已有删减版时，无权限访问者获得删减表示；没有删减版时保留权限占位，不下发正常图地址、尺寸或 LQIP。删减版属于本附件行，不能通过它追溯读取正常版本或归档。

编辑页『天子上朝』表示当前用户实际获得的内容，『微服私访』模拟无机密权限的正文和附件视图；两者在全屏和普通布局共用规则。这是预览视角，不是提升用户权限的开关。

## 明确的读取操作

| 操作 | 对象与权限 |
| --- | --- |
| 预览 | 当前正常表示；无权限时不可执行普通预览 |
| 预览删减版 | 已存在的删减表示，对无机密权限访问者也开放 |
| 下载 | 处理图片的当前正常 AVIF；原图直传类型／普通文件的原始对象；不会降级成删减版 |
| 下载原图 | 本行独立归档，要求正常版本读取权限及可用归档 |
| 下载删减版 | 明确读取删减 AVIF |

无正常读取权限时，普通『下载』保留禁用态。双击图片先尝试普通预览，不可用时尝试删减版预览；都不可用时不执行。正文正常展示的 `auto` 表示可以根据访问权限和浏览器格式支持选择删减／JPEG 回退，这与用户明确点击『下载』的语义不同。

## 在线授权链路

1. 应用读取当前附件行及访问者，选择对象角色，并生成包含附件 ID、读取版本、角色、会话及 token generation 的签名 grant。
2. 浏览器请求 ESA。函数先验证请求签名、时间和规范化路径，再回调 `/api/content/authorize`。
3. 回调从数据库读取当前附件及会话状态，核对权限、封禁、generation、对象 key 和 revision，返回绑定请求 nonce、URL 和方法的授权证明。
4. 授权通过后由 ESA 原生缓存／OSS 交付内容；函数不代理完整对象字节。授权失败或回调故障时拒绝请求。

每次 GET／HEAD（包括 Range 请求）都重新授权，不缓存成功决定。缓存 HIT 不能跳过应用回调。删除、替换、机密切换、删减版删除、会话退出和权限撤销都可能使旧 grant 不再匹配。

URL 仅接受 `auth_key=v2-<签发秒>-<过期秒>-<32位十六进制nonce>-<64位十六进制HMAC>`。HMAC-SHA256 的输入为固定顺序 JSON 数组：用途标识 `content-url-v2`、URL origin、编码后的 pathname、`["GET","HEAD"]`、签发秒字符串、过期秒字符串、nonce、下载响应头值和 access grant；缺失的响应头或 grant 使用空字符串。域名、路径、时间、文件名与访问凭据都不可替换。GET 和 HEAD 共用读取能力，Range 不改变该能力，但每次请求仍须在线授权。

有效期不得超过服务端配置，最多接受 30 秒未来签发偏差，到达过期秒立即拒绝。URL 签名和回调证明采用不同用途标识（`content-url-v2` / `content-read-v1`）；后者是独立的回调证明协议，不表示兼容旧 URL。两类摘要均先校验固定长度和十六进制格式，再做恒定时间比较。MD5 URL、未知版本及无版本链接一律拒绝，没有 legacy 开关或回退。

签名 URL 在有效期间仍是持有者可使用的能力地址；授权回调验证它绑定的会话与对象事实，不代表证明当前拿到 URL 的人就是签发时的浏览器。不要把可复制链接等同于不可转发的客户端身份凭据。

在线撤权约束作用于后续经过该链路的新请求，不能撤回已经下载的文件、浏览器已保存的像素或正在完成的响应。物理删除和缓存刷新是另一个异步过程，不是授权撤销的前提。

本合同依赖正确的 ESA 路由、私有回源和缓存规则。另一个能匿名直读对象的域名会绕过应用边界，部署时必须核对[ESA](../../deployment/esa.md)、[边缘函数](../../deployment/esa-functions.md)及 [OSS](../../deployment/oss.md)。

## 历史加密数据

仍含 `encryption_key` 或旧 storage provider 的 Content 行必须先迁移，当前读取入口不会自动回退到浏览器解密。AES-256-GCM 只用于[历史迁移](../../operations/content-cutover.md)读取旧密文并认证，不是 `.good` 文件当前的上传机制。历史源和解密材料是否退役由迁移恢复流程管理。

## 源码与验证

- 权限：[`permissions.ts`](../../../server/shared/permissions.ts)、[`workspace-auth.service.ts`](../../../server/services/content/workspace-auth.service.ts)。
- 表示与签发：[`attachment-access.service.ts`](../../../server/services/content/attachment-access.service.ts)、[`upload.service.ts`](../../../server/services/content/upload.service.ts)。
- 每请求校验：[`edge-read.service.ts`](../../../server/services/content/edge-read.service.ts)、[`content-auth.mjs`](../../../config/esa/content-auth.mjs)。
- 正文删减：[`content-private.ts`](../../../server/shared/content-private.ts)。

自动测试覆盖公开／机密／删减角色、错误版本、旧存储、会话撤销和回调证明。部署验收必须包含缓存 HIT 后撤权、匿名请求、退出会话、删除删减版、Range 和回调中断；单次下载成功不能证明整个授权边界正确。
