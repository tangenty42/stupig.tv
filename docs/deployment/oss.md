# OSS 桶、上传与对象保留

Content、头像和站点静态资源统一使用本环境的阿里云 OSS 桶与 `ALIYUN_OSS_*` 身份。头像写入使用官方 `ali-oss` 适配器；`oss.buckets.public` 保留为静态 URL 兼容配置，与 `aliyun.oss` 指向同一新桶，历史 private 源默认 null。日常运行不需要旧 S3 凭据。

事实源：[适配器](../../server/lib/aliyun-oss.ts)、[配置](../../config/shared.yaml)、[RAM 策略](ram.md)、[对象生命周期](../modules/content/object-lifecycle.md)。

## 桶与地域

| 环境 | Content 桶 | API endpoint | 读取域名 |
| --- | --- | --- | --- |
| dev | `stupig-static-dev` | `https://oss-cn-shenzhen.aliyuncs.com` | `stupig-static-dev.oss.tangenty.cn` |
| prod | `stupig-static` | 同深圳 endpoint | `stupig-static.oss.tangenty.cn` |

2026-10-25 云 API 已确认两桶与上述声明一致，均 private、ZRS、版本控制 Enabled，阻止公共访问均已开启，两桶历史版本当前均保留 7 天；完整差异及调整建议见[资源台账](aliyun.md#oss保留什么调整什么)。SDK endpoint 使用 OSS API 地址，不能替换成 ESA 加速域名。当前适配器拒绝通过 `URLLIB_PROXY` / `URLLIB_ENABLE_PROXY` 启用 urllib 代理。

Content 对象位于 `content/att/`。全部对象创建/完成时显式 private，普通附件与机密附件的区别由应用 ACL 和在线授权控制，**公开业务附件也不把 OSS ACL 改为公有读**。默认桶 ACL 也应私有，避免非预期对象继承公开访问。

源对象原图、展示 AVIF/JPEG、删减版和暂存数据的角色见[图片模型](../modules/content/images.md)。对象 key 为不可变身份，逻辑改名/移动不对应 OSS 前缀搬运。

## 站点静态资源与头像

`imgs/` 存放 Logo、评级等图标，`avatar/` 存放公开头像，均通过同一 ESA 域名公开读取。它们不走 `/content/` 的签名与在线授权规则；OSS 对象自身仍为 private，ESA 通过私有源站授权回源。不要把 Content 鉴权规则扩大到这两个公开前缀，也不要把桶改为公有读。

头像先上传新对象再发布用户行，新上传使用带 UUID 的 key，避免固定 key 被 ESA 长缓存复用；旧头像通过可恢复删除移除。头像不使用 Content 图片模型或退役账本，删除失败会记录日志，需人工核对。

2026-10-25 两环境各 13 个既有静态对象已复制到新桶，保留 key 和 MIME，完整字节 SHA-256 与 private ACL 均通过。旧源配置与凭据只保留在受保护的恢复备份，日常 `.env.dev/.env.prod` 和模板已移除旧凭据。历史数据恢复须使用对应版本和历史源配置，不能用当前新桶配置假装旧源。

## 当前上传协议

应用创建持久化上传会话并初始化 multipart，浏览器只收到一个或一批具体 UploadPart V4 URL；签名绑定 key、uploadId、partNumber、MD5、长度、MIME、方法和有效期。分片请求的 MIME 固定为 `application/octet-stream`，不要按原文件图片类型改成 `image/png` 等；最终对象 MIME 由后端初始化/对象创建过程设置。后端负责列举、完成、终止以及最终发布，Complete 时明确 private。

浏览器没有长期 AccessKey，也没有可自行签发任意 PUT/Complete 的 STS。`uploadRoleArn` 是保留字段，不能按旧文档改成向浏览器发角色凭据。权限见 [RAM](ram.md)，业务过程见[上传](../modules/content/uploads.md)。

## CORS

在桶的跨域设置中，为实际上传页面来源创建规则。开发已经使用 `http://localhost:3042`；端口修改、局域网域名或生产 `https://www.stupig.tv` 都是不同 Origin，应分别核对。

| 字段 | 现行分片上传所需值 |
| --- | --- |
| Allowed Origins | 精确页面来源，dev/prod 分开 |
| Allowed Methods | PUT；当前浏览器不负责 Initialize/Complete |
| Allowed Headers | `*`，覆盖 Content-Type、Content-MD5、SDK 所需头 |
| Expose Headers | `ETag`、`x-oss-request-id` |
| Max Age | 按部署策略设置；调试修改后注意浏览器预检缓存 |
| Vary: Origin | 多来源规则按官方 CORS 指引启用 |

来源、方法、请求头与暴露头的含义见 [OSS 官方 CORS 文档](https://help.aliyun.com/zh/oss/user-guide/configure-cross-origin-resource-sharing)。CORS 允许浏览器读取响应，不会授予对象权限。Content 读取经过 ESA，另由[ESA 出站响应头](esa.md)满足预览和 Canvas；不能用 OSS 上传 CORS 代替 ESA 读取规则。

验收必须在真实浏览器中执行一个分片 PUT、读取 ETag、完成后全量下载对比；只用 Node 或 curl 成功不能证明 CORS 可用。浏览器不会手工设置 Content-Length，由 Blob 请求体提供。

## 版本控制与生命周期

为目标桶启用版本控制，核对 GetBucketVersioning 返回状态后再验收删除。当前应用 DeleteObject 不指定历史 versionId，使用删除标记；应用策略显式拒绝 DeleteObjectVersion。

版本控制下不带 versionId 的删除会保留历史对象；指定版本删除和非当前版本生命周期到期则是永久删除。见[版本对象管理](https://help.aliyun.com/zh/oss/user-guide/manage-objects-in-a-versioning-enabled-bucket)与[生命周期管理版本](https://help.aliyun.com/zh/oss/user-guide/configure-lifecycle-rules-to-manage-object-versions)。

部署时单独记录并审查三类规则：

1. 未完成 multipart 的清理：保留时间要覆盖正常暂停/续传和迁移维护窗口，避免云生命周期提前终止仍有效的上传。
2. 非当前版本保留：本次读回 dev/prod 都是 7 天；生产应按实际备份恢复窗口决定是否延长，不能认为 1Panel 数据库备份同时保住远端对象。
3. 过期删除标记清理：与历史版本规则一起审查；不能对正式当前对象设置不加区分的短期删除。

生命周期执行不理解数据库引用、上传预约或迁移 pin。不得按 `content/` 整段定时删除，也不能用『对象在数据库当前 row 中找不到』立即判断为垃圾；有暂存、未知提交结果、历史迁移和预热在途责任。

## 交付与回收验收

- 无签名访问 OSS 的普通/机密/暂存对象均拒绝；合法应用读取成功。
- 上传、复制和图片转换生成对象的 ACL、ETag、大小与版本可核对。
- 禁止显式公有 ACL，禁止应用身份永久删历史版本。
- 替换/删除事务写退役账本，后台确认 OSS 删除和 ESA 刷新；读取撤销不等待清理完成。
- 已提交预热、未确认 multipart、迁移源 pin 等阻塞项不得绕过。

OSS 历史版本本身不是业务回收站。恢复还需要数据库元数据、权限和引用关系；当前没有自助恢复 UI，见[备份恢复](../operations/backup-recovery.md)。
