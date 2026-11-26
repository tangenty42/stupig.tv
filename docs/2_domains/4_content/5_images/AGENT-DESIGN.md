# AGENT-DESIGN：图片的实现

- 本文档状态：PENDING（初稿，待人类审阅）
- 覆盖范围：图片处理、原图、删减版、图片编辑器
- 对应 LAW：[SID#2.4.5.LAW](LAW.md)；上传与冲突见 `4_attachments`；读取授权见 `6_access`；对象退役与预热见 `7_storage`

## 入口

| 位置 | 内容 |
| --- | --- |
| `server/shared/content-markdown.ts` 的 `processable_image_mime` | 上传受理时哪些格式进图片处理 |
| `server/shared/content-image-upload.ts`、`app/features/content/uploads/image-upload.ts` | 大小和尺寸上限；只读文件头取尺寸 |
| `server/lib/oss-image-processing.ts` | 生产唯一的图片处理，在阿里云 OSS 上转换 |
| `server/services/content/image-job.service.ts` | 图片任务：认领、处理、采用；`upload`、`copy`、`overwrite`、`redacted` 四种模式 |
| `server/services/content/upload-image.service.ts` | 上传后的图片任务扫描；多帧图片退回普通文件 |
| `server/services/content/{image-scheduler.service,image-attempt-cleanup.service,image-presentation,image-original-object,redacted-variant}.ts` | 调度、失败尝试清理、展示数据、原图对象、删减版字段 |
| `server/services/content/attachment-access.service.ts` | 原图和删减版的读取规则 |
| `app/features/content/image-editor/`、`app/components/MyContent/Attachment/ImageEditor.vue` | 图片编辑器 |
| `server/lib/webp-image-processing.ts` | 只供离线脚本 `scripts/verify/image-performance.ts`，生产不走 |

## 处理

| 项 | 值 | 来源 |
| --- | --- | --- |
| 进处理的格式 | PNG、JPEG、WebP、AVIF、HEIC/HEIF，单帧 | `processable_image_mime`；OSS 读回的格式和帧数再核一次 |
| 上传上限 | 20 MiB、宽高各 8192 像素、总像素 24,000,000 | `app.content.image`，后台同时检查 `app.contentImages.cloud.profile` 的文件大小和总像素上限 |
| 显示版 | WebP，质量 100，按 EXIF 方向决定是否转正 | `contentImages.cloud.profile` |
| 备用版 | JPEG，质量 85，由显示版转出；背景必须是白色 | 同上 |
| LQIP | 最长边 24 像素，JPEG 质量 40，不超过 8192 字节 | 同上；`app.content.image.lqipMaxBytes` |

- 阿里云转出的显示版和备用版不带 EXIF（人类 2026-11-16 核实）；
- 尺寸不缩小；
- 单边 8192 像素与图片编辑器的单边上限一致。上传校验和后台处理共用总像素上限，显示版保留原图分辨率。开发桶已验证 `auto-orient,1` 能转正最长边为 8192 像素的合成 JPEG。[OSS 图片处理限制](https://help.aliyun.com/zh/oss/user-guide/overview-17#使用限制)
- 上传后在后台处理。处理完之前，附件目录里显示为待处理项；失败的任务不自动重试，右键菜单有「重试」；
- OSS 读回的帧数大于 1 时抛 `AnimatedImageSourceError`。`upload` 模式下任务记为 `cancelled`、`error_code = 'image_animated_plain'`，再按普通文件发布；其他模式照常报失败；
- 处理完成后，上传的原件登记待删（`image-input`），原图另存到 `original_key`，显示版和备用版排进预热；
- 处理只在 OSS 上做（`oss-image-processing.ts`）：服务端只读 `image/info`（上限 32 KiB）和 24 像素的 LQIP，不下载整张图，也不把转换地址交给浏览器。每次读取都带 `If-Match` 当前 ETag。EXIF Orientation 为 1、0 或缺失时关闭自动转正，直接转码。方向 2–8 交给 OSS 自动转正，方向 5–8 的产物需交换宽高；
- 转出的对象采用前再核对 ETag、OSS 版本号和私有 ACL；原图用 OSS 条件复制，以复制回执的版本号为准；
- 上传封口后立即唤醒 `images` 扫描，不等下一个周期，见 `SID#2.5.AGENT-DESIGN`『扫描清单』。

| 对象 | 列 | 键 |
| --- | --- | --- |
| 上传的原件 | 处理期间的输入，采用后登记待删 | `content/att/staging/<会话>/<尝试>` |
| 显示版、备用版 | `display_key`、`fallback_key`；做过处理的图片 `object_key` 就是显示版 | `content/att/images/<任务>/<尝试>/…` |
| 原图 | `original_key` | `content/att/originals/<组>/<尝试>` |

改名和移动只改附件行，不改任何对象键。

- 附件数据里的 `image`（尺寸、LQIP、有没有原图）只在查看者能读这张图时下发（`image-presentation.ts`）。LQIP 超过 `lqipMaxBytes` 时省略。正文、编辑预览和封面共用图框与原生懒加载。有尺寸元数据就按比例预留空间，列表封面跟随卡片宽度，详情和编辑页封面遵守宽高上限。图框先显示统一纯色底和加载图标，有 LQIP 时在底色上每 2.2 秒呼吸一次。
- 正文和封面加载成功时，清晰图以 1.4 秒缓入缓出渐显，转圈同时淡出。失败采用 450 毫秒交叉淡化。正文和封面没有尺寸提示时先保留加载框，请求完成后用同一时长过渡到结果大小。系统开启减少动态效果时直接切换。
- 有 LQIP 的图加载成功后等待浏览器解码，先把清晰图铺在完全不透明的低清层下面。当前呼吸走到周期末尾时，低清层和转圈才开始淡出。低清层和清晰图的可见比例同时变化，透明图使用相同主题底色。缓存图先解析占位样式，再走这段交接。加载失败时淡入失败占位。系统开启减少动态效果时跳过呼吸与淡化。
- 大图在打开时请求，未缓存图片的加载画面只有暗色遮罩和居中转圈。ViewerJS 首次适配直接定位到最终尺寸和位置，等待 `viewed` 确认适配完成，并在浏览器支持时等待 `decode()`。两者就绪后，转圈淡出，图片以 600 毫秒缓入缓出渐显。已有健康缓存的图片可省略转圈并直接渐显。当前请求失败时，转圈与失败占位也采用 600 毫秒缓入缓出交叉淡化。系统开启减少动态效果时直接切换。失败占位显示 `image-off` 图标，读屏提示为『图片加载失败』。换图或重开会为新请求重新判断结果。固定链接按 `Accept` 选显示版或备用版，见 `SID#2.4.6`『谁能读』。

## 原图

- 读取原图要『机密可读』（`require_original_read`），『完全』包含它；没有权限返回 403“你没有原图的读取权限”。附件菜单的「下载原图」也只对有权限的人显示；
- 只有做过图片处理的图片才有单独的原图。不做处理的图片只有原文件，按普通附件读取；
- 覆盖保存沿用源图的完整路径和机密状态，只换显示版和备用版，`original_key` 保留。另存为的新图片以编辑结果的 WebP 作为原图，机密状态由实际落点决定。机密目录内的公开删减版另存为普通副本时，新图继承目录的机密状态。

## 删减版

- 删减版是同一文件夹里去掉 `.good` 的同名公开文件（`attachment_redaction_path`），不限图片；只有自己的名字以 `.good` 结尾的文件才有删减版；
- 读取时按 `redaction_rows` 找到它：附件列表把机密行的 `redacted_url`、`redacted_image` 指向删减版文件，封面也换成它；前端 `redacted_version_of` 据此渲染，正文里标「机密附件·删减版」；
- 编辑器「作为删减版」走 `copy` 模式，目标名就是删减版的名字（保留原扩展名，不强制 `.webp`）；受理时 `access` 为公开，图片任务的意图带 `redaction: true`，允许机密来源生成公开副本；重名按冲突处理；
- 编辑器保存时先确认该删减版将公开。上传受理通过 `save_as_redaction` 识别该选择，最终落点仍是源图的同名公开删减版时，从附件状态变更确认列表中省略这张新图。其它影响和冲突处理仍单独检查；
- 旧的删减版字段 `redacted_*`、`redacted` 任务模式、`delete_redacted` 命令和冲突类别 `redacted` 还在代码里，前端已不再使用，见 AGENT 待办；
- 迁移 `20261117220000_redaction_files.sql` 把旧字段里的删减版搬成同名公开文件，原图为空。

## 图片编辑器

| 项 | 值 |
| --- | --- |
| 最大像素 | 24000000（`app.content.imageEditor.maxPixels`） |
| 最多操作步数 | 200 |
| 单笔最多点数 | 100000 |
| 删减版最长边 | 8192 像素（`app.content.redact.maxDimension`） |

- 打开时以当前显示版为基底（`input_basis = 'display'`）。加载成功后，转圈用 `site-page` 的 180 毫秒淡出，工作区同时用 300 毫秒淡入。换源或关闭编辑器时立即清空旧画布。系统开启减少动态效果时直接切换，动画待人工验收。
- 「回退」只换编辑器的基底为原图（`input_basis = 'original'`），保存前不改存储；
- 保存输出无损 PNG。覆盖保存走 `overwrite` 模式，另存为和作为删减版走 `copy` 模式；「作为删减版」只对名字以 `.good` 结尾的图片出现；
- 源图未就绪、编辑处理尚未结束或普通另存名称为空时禁用「保存」。作为删减版使用固定目标名称。导出过程中，保存按钮显示转圈，保存模式和名称暂时锁定；
- 图片编辑器打开时接管 Ctrl+S / ⌘S，复用图片「保存」按钮和原有确认。加载、编辑处理或导出期间，快捷键仍由图片编辑器接管；
- 视口（`image-editor/viewport.ts`）：Ctrl／Cmd 加滚轮缩放，触控板双指捏合也走这条路，以指针所在处为中心；按住空格或 Ctrl／Cmd 拖动平移；「适应窗口」回到整图可见；
- 桌面工具栏下用三个描边 `MyBadge` 显示滚轮缩放、按键拖动平移和双指手势。
- 裁剪：八个把手调大小、拖边框移动，可锁定比例（按住 Shift 也锁），「应用」后成为一步操作，「重置」回到整图。拖动期间拦住保存、撤销和重做，松手、指针取消或失去指针捕获后恢复，Esc 可取消正在进行的裁剪；
- 涂抹、裁剪、旋转、清除都记入编辑历史，可撤销、重做（`image-editor/session.ts`）；历史只在编辑器内存里，关掉就没了。
