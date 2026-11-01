# 图片、编辑与删减版

图片是附件行的一种表示。一次上传或编辑产生多个物理对象，但附件列表和 Markdown 中仍只有一个逻辑附件。头像等其他模块不使用本页的 Content 图片模型。

## 图片类型与对象角色

静态 JPEG、PNG、WebP、AVIF 进入 Sharp 处理管线；GIF、SVG 等其他图片按原始字节存储，浏览器支持时可以预览，但不压缩、不进入画布编辑。处理管线验证字节、单帧、尺寸和资源预算，不能靠改后缀绕过限制。

| 字段／角色 | 含义 |
| --- | --- |
| `object_key` | 当前正式内容；处理图片指向当前 AVIF，原图直传类型指向原始对象 |
| `original_key` | 本附件自己的初始归档，用于下载原图和回退画布 |
| `avif_key` | 当前正常版本的展示、普通下载与继续编辑输入 |
| `jpeg_key` | 从最终 AVIF 生成的持久化 JPEG 回退 |
| `parent_avif_key` | 正常覆盖时记录的来源快照身份，不是新附件的原图继承关系 |
| `redacted_avif_key` / `redacted_jpeg_key` | 同一行的可公开删减表示，首次保存时才建立 |

正常与删减表示各有自己的 revision、尺寸、大小、摘要和 LQIP。无机密读取权限时，服务端不把正常版本的图片元数据或 LQIP 一并下发。

原图归档保留上传字节，不保证源文件本身是无损编码。上传输入先进入 `content/att/staging/`；正式原图和图片产物分别位于 `content/att/originals/` 与 `content/att/images/`。这些前缀不是用户路径，改名不改对象 key。

## 处理与发布

图片尝试先记录任务、尝试身份及来源，生成 AVIF，再从该 AVIF 生成 JPEG 与小尺寸 LQIP。首次上传还把原始字节独立归档。对象私有权限、身份、大小与摘要经过验证后，才允许在数据库事务中采用一组完整角色。

失败、取消或过期尝试不覆盖正式行；旧尝试的迟到写入由账本继续跟踪和清理。对象发布同时登记预热及旧对象退役意图，见[对象生命周期](object-lifecycle.md)。

## 画布与保存

普通编辑和删减编辑共用全屏 `ImageEditor`。同一画布提供画笔／橡皮擦、旋转、裁剪、撤销／重做和视口操作，没有平移／裁剪／画笔三套互斥编辑模式。

- 桌面端 Ctrl + 滚轮缩放；Ctrl／⌘ 或空格 + 拖动平移画布。裁剪框靠边框和手柄移动／调整，不再通过修饰键拖动整个框内区域。
- 双指缩放／平移在整个画布区域生效，不仅限图片像素范围；双指开始不能重置已有裁剪区域。
- 『适应窗口』允许小图放大；『原始比例』恢复 1:1，旁边百分比显示当前视口倍率。视口缩放不改变导出尺寸。
- 橡皮擦只修改当前编辑笔迹层，不能恢复已烘焙到源 AVIF 的遮挡。裁剪／旋转属于编辑历史，撤销／重做按历史可用性禁用。
- 『应用裁剪』立即进入本地编辑历史；『回退原图』有确认，读取本行归档、替换画布并重建本地编辑基线。二者都不等于已经保存。

普通编辑默认『覆盖』，也可『另存为』。覆盖时名称输入仍显示原名称并禁用，避免布局跳动；另存为只修改主体名称，固定 `.avif` 后缀。保存确认明确模式及目标。

| 保存方式 | 行与归档 |
| --- | --- |
| 覆盖 | 更新原行的正常 AVIF／JPEG，保留该行原图归档 |
| 另存为 | 创建独立新行，将首次输出 AVIF 另作自身归档；新行不依赖源附件 |
| 编辑删减版 | 更新当前行删减 AVIF／JPEG，不改正常版本或归档 |

回退原图只改变当前前端画布，所有保存方式都可以使用。取消编辑不会删除已保存版本；没有本行可读归档时不能执行回退，也不会追溯其他附件的原图。

## 删减版的生命周期

『编辑删减版』从机密图片菜单进入，固定保存到当前行；普通编辑的保存模式中没有『创建删减版』。已有删减版时以其当前 AVIF 为输入，否则以正常 AVIF 为输入。

删减版初始不存在，首次保存才创建两个 key；没有独立附件行或额外原图档案。『删除删减版』经确认清空删减字段及元数据、推进版本，并登记旧对象退役。编辑器不提供另一套『恢复正常版本』删除入口。

列表和引用补全仅将『机密且自身存在删减版』的行标蓝，普通附件使用正常图标与颜色。Markdown 的删减展示也只读取同一 row 的删减字段，不再按同名 `.good` 文件或历史 `redaction_source_id` 配对其他附件。

机密切为公开会保留删减 key，重新设为机密可以再次使用。覆盖／替换正常图片遇到已有删减版时必须 resolve 选择保留旧删减版、删除旧删减版或取消此次覆盖，不能默默替用户决定。

下载与预览的正常／原图／删减角色是明确区分的，详见[访问控制](access.md)。

## 加载和失败占位

公开封面只使用指定附件本身：公开附件使用正常表示，机密附件使用同一行的删减表示。没有可用表示时返回空封面并显示占位，不去掉 `.good` 查找另一个同名公开附件；删除删减版或目标附件后也遵守这条规则。

首页封面、档案页头和正文中的档案引用卡片共用封面渲染器与加载状态处理。档案列表和正文接口在封面 URL 旁返回对应表示的尺寸、LQIP，用于提前占位和渐进加载；机密封面只返回可公开删减版自身的元数据，没有删减版时不下发正常图片占位。封面走现有附件入口，按浏览器 Accept 协商 AVIF／JPEG，SVG／GIF 等保持原格式。首页保持 eager 加载，避免筛选／排序移动卡片时出现浏览器 lazy load 停滞；本轮未新增首页专用缩略图。

封面和正文图片共用加载状态与动效样式。已处理图片先显示透明度缓慢呼吸的对应版本 LQIP，并提供旋转的加载图标；没有 LQIP 的 GIF／SVG 等也使用加载反馈。图片淡入期间保留其下方的 LQIP，遮罩随之淡出，避免切换时露出底色；系统启用减少动态效果时立即切换。解码失败或引用无效时替换图片区域为占位符，保持原有图片项与 caption 结构。编辑预览增量更新时复用未变化的媒体节点，避免每次输入都重载整篇图片。

## 转换性能基线（2026-11-01）

本轮按用户选择先测量，正式画质、处理提供方和云资源均未调整。基线为 #61 后的 `15ac9f4`，使用真实 `process_image_variants`，只在独立基准进程中计时；不连接数据库、不访问生产对象。脚本不进入应用启动或 CI 性能门禁。

### 重复测量

```powershell
$env:NODE_ENV = 'development'
pnpm exec tsx --tsconfig scripts/tsconfig.json scripts/verify/image-performance.ts --output .data/image-performance.json
pnpm exec tsx --tsconfig scripts/tsconfig.json scripts/verify/image-performance.ts --input .data/photo.jpeg --efforts 4,2 --runs 2 --quality --output .data/photo-performance.json
```

输出目录需预先存在。默认顺序处理两张确定性纹理图（1280×800、2400×1600），每个 effort 4／2／0 各运行两次；`--input` 可重复指定自备文件，`--runs` 限制为 1–5。只加载图片配置子树，不需要数据库或云端凭据。报告保留输入 basename、配置、环境、耗时、输出字节、进程 CPU 时间、采样 RSS 和事件循环延迟，不保存转换产物；自行选用不含敏感名称的测试文件。

阶段为源 metadata、AVIF、JPEG、LQIP、最终 metadata。AVIF 阶段包含解码、方向和色彩转换及编码；JPEG／LQIP 阶段各自包含最终 AVIF 的解码，不能把阶段值当作纯编码器耗时。工具委托真实管线，并校验阶段调用数量；管线调整后必须复核标签。`--quality` 另作 sRGB／白底像素 PSNR 诊断，诊断不计入处理耗时，但可能影响后续缓存状态；PSNR 不能代替视觉验收，`null` 表示诊断像素完全一致。

### 本机结果与边界

环境为 Windows ARM64、Node 24.22.1、Sharp 0.35.5／libvips 8.18.7／AOM 3.15.1，12 个可用逻辑处理器，Sharp concurrency 12，libuv 线程池默认。保持 quality 65、JPEG quality 85、24px LQIP，仅比较 effort；后台领域并发 1 不代表编码器只用一个线程。

| 输入 | effort | 全管线 ms | AVIF 阶段 ms | JPEG ms | LQIP ms | AVIF 字节 |
| --- | --- | --- | --- | --- | --- | --- |
| 2400×1600 纹理 | 4 | 2,059 | 1,525 | 281 | 251 | 1,116,774 |
| 同上 | 2 | 702 | 212 | 265 | 223 | 1,068,000 |
| 2400×1560 照片 | 4 | 872 | 639 | 125 | 106 | 198,228 |
| 同上 | 2 | 434 | 156 | 147 | 129 | 241,634 |
| 3924×2550 照片 | 4 | 1,837 | 1,222 | 335 | 276 | 552,331 |
| 同上 | 2 | 1,080 | 366 | 392 | 320 | 619,108 |

纹理计时取不启用 `--quality` 的两次均值，照片启用诊断；1000 万像素组每种 effort 仅一次，其余组各两次。未隔离其他进程负载，顺序固定，未做随机顺序／冷缓存对照，不具备 p95 或生产 SLA 含义。照片来自[阿里云高级压缩示例](https://www.alibabacloud.com/help/en/oss/user-guide/advanced-compression-of-heif-or-avif-images)中的[公开原图](https://image-demo-oss-zhangjiakou.oss-cn-zhangjiakou.aliyuncs.com/pics/compression-demo.jpeg)，2,195,428 字节，SHA-256 为 `c0e0bf371f74023ead5bb1c394b19ff7a4a715ea023a4062cdcd20a963b2c6c6`；小图由其 `resize({ width: 2400, height: 1600, fit: 'inside' }).jpeg({ quality: 92 })` 生成。没有下载生产附件。

两组照片的 effort 4 → 2 减少约 50%／41% 墙钟时间和约 79%／78% 进程 CPU 时间，AVIF 分别增大约 22%／12%；PSNR 分别从 40.38 → 40.20、39.99 → 39.82 dB。纹理在 effort 2 下反而更小，PSNR 则从 33.85 降到 32.88 dB；不能将某一张图的体积变化推广到全部输入。effort 0 的两组较小输入为 543／344ms，仍须另评画质；[Sharp 的 effort 定义](https://sharp.pixelplumbing.com/api-output/#avif)是速度与压缩投入的取舍，不是画质保证。

首次探索的 380 万像素纹理耗时 9.8 秒，随后两组复测约 2.06／2.07 秒，产物字节一致；首轮异常的负载／缓存原因未隔离，不能当稳定基线。1000 万像素组观察到进程 RSS 约 500–584MiB，包含此前任务、分配器／缓存及质量诊断的影响；25ms 采样也不能保证捕捉绝对峰值，更不能据此认定每张图固定占用该内存。尚未测试 2400 万像素上限、生产机器、并发压力或前后台混合负载。

### 排队、I/O 与云端选择

代码确认当前是每 5 秒扫描、图片并发 1、单批最多 20 个任务，扫描期间占用 runner 的 image／OSS 资源槽。长批次处理完才释放，处理中新到任务也不在已有快照里；可感知等待可能同时包含轮询和排队，不能把上述编码时间当作选择文件到最终发布的总耗时。输入下载／Buffer 拼接、两个产物顺序上传、原图归档、数据库采用和预热也未纳入本基准。下一步先记录排队年龄及各外部阶段耗时，再评估入队唤醒和有界批次；数据库池／在线授权延迟目前只是待测风险。

当前 JPEG 与 LQIP 分别解码一次最终 AVIF；effort 降低后这部分占比更高。可实验复用解码，但必须保持二者源自最终 AVIF 的合同，并复测内存和像素。`image-processing.ts` 属于冻结迁移依赖，未来运行时优化需另建入口并按需推进处理 profile；不能直接改历史实现或重算 digest。

阿里云标准 OSS IMG 的[公开限制](https://help.aliyun.com/zh/oss/user-guide/overview-17/)为原图不超过 20MB、AVIF 输出宽不超过 4096px 且总像素不超过 9,437,184。当前应用接受 50MiB／2400 万像素，上述 3924×2550 照片也超过标准 AVIF 像素限制，因此不能直接全量替换；需本地回退、其他计算服务或工单确认更高限额。没有测量云端实际速度、费用或本账号权限。

若选云端持久化处理，还须保留私有对象、尝试身份／租约、完整角色后原子采用及迟到结果清理；JPEG／LQIP 仍须从最终 AVIF 派生。[sys/saveas](https://www.alibabacloud.com/help/en/oss/user-guide/sys-or-saveas)需要来源处理权限及目标写权限，输出继承目标桶 ACL，不能用公开转换 URL 绕过当前读取授权。

## 源码与验证

- 图片领域：[`image-job.service.ts`](../../../server/services/content/image-job.service.ts)、[`image-original-object.ts`](../../../server/services/content/image-original-object.ts)、[`redacted-variant.ts`](../../../server/services/content/redacted-variant.ts)。
- 本地转换基准：[`image-performance.ts`](../../../scripts/verify/image-performance.ts)；真实 CLI 回归检查报告、资源参数及失败后的计时恢复，不以耗时数值作为通过门槛。
- 画布：[`ImageEditor.vue`](../../../app/components/MyContent/Attachment/ImageEditor.vue)、[`useImageEditSession.ts`](../../../app/composables/useImageEditSession.ts)、[`useImageEditorViewport.ts`](../../../app/composables/useImageEditorViewport.ts)、[`image-edit.ts`](../../../app/utils/content/image-edit.ts)。
- 展示：[`image-presentation.ts`](../../../server/services/content/image-presentation.ts)、[`lqip.ts`](../../../app/utils/content/lqip.ts)。

自动测试覆盖角色完整性、发布围栏、原图归档、独立副本、删减版和纯编辑历史。画布像素、触摸、滚轮、裁剪手柄和浏览器解码需另做真实浏览器验证；Node 测试不代替该部分。
