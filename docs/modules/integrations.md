# 外部内容与静态资源集成

本页描述业务集成的行为。阿里云、数据库、MQTT 等基础设施配置集中在[部署手册](../deployment/README.md)，不在这里复制凭据或控制台步骤。

## Bilibili 视频卡片

无标签 Bilibili 链接可以渲染视频卡片，带普通标签的链接保持文字链接。支持的地址和规范化规则由 [`server/shared/bilibili.ts`](../../server/shared/bilibili.ts) 定义，包括 BV、av 视频地址和 `b23.tv` 短链接。渲染器不会把任意外部地址交给该集成。

`content.getBilibiliVideoCards` 接收一组地址，服务端去重后返回以原始地址为键的结果。卡片包含规范视频地址、标题、封面、作者、时长、播放与点赞数据；解析失败或视频不可用时返回空结果，由预览保留对应占位。

服务端优先请求视频元数据接口，遇到实现识别的风控响应后尝试从视频观看页提取元数据。它依赖第三方当前返回结构，不保证所有网络、所有视频都可解析。

缓存保存在 Redis：成功卡片不设过期 TTL，24 小时内直接复用，过了 freshness 时间后按需重新验证；刷新失败继续返回旧卡片。同进程相同目标共用正在执行的请求，不同目标排队通过全局探测入口。

只有上游明确返回视频不存在（`-404`，或观看页状态明确的 404）才会用空结果替换旧卡片。HTTP 200 的风控页、缺少初始状态、元数据不完整、未知 API 错误码和短链接异常都属于刷新失败，记录日志并走 stale-if-error；没有历史卡片时仍以短缓存抑制重复请求。浏览器对当前展示的空卡片按 `negativeCacheTtlMs` 到期重试，多处预览共享请求；移除链接或卸载预览后停止该预览的重试，不因空结果永久停留在占位状态。

失败会开启 Redis 全局冷却，跨视频、跨应用实例、跨重启共用：基准依次为 30 分钟、1 小时、2 小时、4 小时，之后上限 6 小时。每次增加 0～20% 的正向随机抖动，总时长仍不超过 6 小时。冷却期内只返回已有卡片或占位，不访问 B 站，也不因占位读取而刷新成功卡片的保存时间。API 风控后即使观看页回退成功，也保留本轮风控冷却；只有未触发风控的成功探测才清除连续失败计数。

冷却到期后，通过带 TTL 的 Redis 租约仅放行一个探测，原持有者只能以自己的 token 更新冷却并释放租约。Redis 不可用时暂停上游请求，并在进程内冷却，避免基础设施故障引起请求放大。浏览器占位检查和不存在结果的缓存也已改为 30 分钟；浏览器请求本应用不代表实际请求 B 站，后者仍受全局冷却限制。

配置分组为 `integrations.bilibili`；超时、缓存时间等来自共享 settings 合并后的运行配置，见[配置说明](../deployment/configuration.md)。本集成不上传或转存视频本体。

## 外链、外图与静态资源

普通外链和外部图片由 [Markdown 方言](content/markdown.md)处理。图片能否显示仍取决于对方响应、浏览器策略及网络；外图不自动成为 Content 附件，也不获得 Content 下载授权、图片编辑或对象回收能力。

头像、站点 Logo、评级图标与 Content 共用本环境的阿里云 OSS 桶。静态 URL 仍由 `oss.buckets.public.publicBaseUrl` 提供，已经指向新的 ESA 域名；头像通过 `static-storage.ts` 写入 `avatar/`。`imgs/` 和 `avatar/` 公开交付，`content/` 继续在线鉴权。旧 S3 仅保留历史迁移和恢复材料，日常运行不使用旧配置或凭据。

## 源码与验证

- 元数据读取与缓存：[`server/lib/bilibili.ts`](../../server/lib/bilibili.ts)。
- 全局冷却与探测：[`server/lib/bilibili-throttle.ts`](../../server/lib/bilibili-throttle.ts)。
- 批量业务入口：[`server/services/bilibili.service.ts`](../../server/services/bilibili.service.ts)。
- 链接识别：[`server/shared/bilibili.ts`](../../server/shared/bilibili.ts)。
- 卡片渲染：[`app/utils/content/markdown/link-cards.ts`](../../app/utils/content/markdown/link-cards.ts)。
- 静态资源：[`useStaticUrl.ts`](../../app/composables/useStaticUrl.ts)、[`static-storage.ts`](../../server/lib/static-storage.ts)。

自动测试验证解析、缓存及错误边界；外部元数据服务的实际可达性需要网络冒烟，测试通过不表示第三方接口长期稳定。
