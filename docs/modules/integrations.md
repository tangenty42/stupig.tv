# 外部内容与静态资源集成

本页描述业务集成的行为。阿里云、数据库、MQTT 等基础设施配置集中在[部署手册](../deployment/README.md)，不在这里复制凭据或控制台步骤。

## Bilibili 视频卡片

使用图片语法和 `iframe://` 方言嵌入 Bilibili 分享播放器，例如：`![视频介绍](iframe://player.bilibili.com/player.html?isOutside=true&aid=117506496860624&bvid=BV1Pvnd6JEVD&cid=43069541932&p=1)`。分享地址中的参数直接保留，Markdown 标签作为不可点击的 caption；无标签时不显示 caption。播放器与普通图片可以组成同一个 carousel，加载期间使用共享的占位动效，加载完成后淡入。普通链接不能使用该方言，会产生 warning。浏览器直接加载播放器，正文预览不请求视频标题或封面元数据。

普通 Bilibili 视频地址和 `b23.tv` 短链接仍是普通链接。为限制嵌入来源，目前只放行 `player.bilibili.com/player.html`；其他 iframe 地址不会加载。播放器的可用性依赖用户浏览器与 Bilibili 的网络和服务。

## 外链、外图与静态资源

普通外链和外部图片由 [Markdown 方言](content/markdown.md)处理。图片能否显示仍取决于对方响应、浏览器策略及网络；外图不自动成为 Content 附件，也不获得 Content 下载授权、图片编辑或对象回收能力。

头像、站点 Logo、评级图标与 Content 共用本环境的阿里云 OSS 桶。静态 URL 仍由 `oss.buckets.public.publicBaseUrl` 提供，已经指向新的 ESA 域名；头像通过 `static-storage.ts` 写入 `avatar/`。`imgs/` 和 `avatar/` 公开交付，`content/` 继续在线鉴权。旧 S3 仅保留历史迁移和恢复材料，日常运行不使用旧配置或凭据。

## 源码与验证

- 播放器渲染和来源限制：[`images.ts`](../../app/utils/content/markdown/images.ts)、[`sanitize.ts`](../../app/utils/content/markdown/sanitize.ts)。
- 静态资源：[`useStaticUrl.ts`](../../app/composables/useStaticUrl.ts)、[`static-storage.ts`](../../server/lib/static-storage.ts)。

自动测试验证播放器地址、标题和嵌入来源限制；实际播放仍取决于外部服务。
