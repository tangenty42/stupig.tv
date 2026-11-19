# 部署清单

> 当前发布操作见 [SID#1.3.AGENT-DESIGN](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md)，备份恢复见 [SID#1.4.AGENT-DESIGN](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md)。本文保留首次接入清单、验收项目和历史参考，现网状态按对应核对记录的日期理解。

从上往下操作，每项只看对应模块。云端当前状态与未关闭问题放在[审计台账](aliyun.md)，不混进下面的固定步骤。

## 首次上线

| 顺序 | 做什么 | 操作说明 |
| --- | --- | --- |
| 1 | 准备主机、反代、Docker 网络、MySQL/Redis，规划项目 EMQX 的反代切换 | [服务器](server.md)、[MySQL/Redis](mysql-redis.md)、[EMQX](mqtt.md) |
| 2 | 创建 RAM 策略/用户，保存各身份凭据 | [RAM 清单](ram.md)；策略 JSON 已备齐 |
| 3 | 配 OSS 桶、域名、ESA 函数与路由/原生规则，开通短信与图形验证 | [OSS](oss.md)、[ESA 规则](esa.md)、[ESA 函数](esa-functions.md)、[短信/CAPTCHA](sms-captcha.md) |
| 4 | 填好生产 env/YAML，并更新配置密文 | [配置填写清单](configuration.md) |
| 5 | 配 GitHub/ACR，准备待部署镜像 | [GitHub/ACR](github-acr.md)；首次维护前别让自动部署直接升级旧业务库 |
| 6 | 备份，在副本演练，再执行维护迁移 | [授权维护计划](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#授权维护计划)、[Content 切换](../operations/content-cutover.md)、[备份恢复](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#备份与恢复) |
| 7 | 启动应用、检查回调，发布正式函数代码 | [服务器](server.md)、[函数发布](esa-functions.md)；生产回调为 www.stupig.tv，不使用开发隧道 |
| 8 | 验收后开放流量，最后单独启用预热 | 下表 |

生产 Compose 部署应用和专用 EMQX broker，不会自动创建数据库、RAM、桶、域名或 ESA 规则。EMQX 的账号、ACL 与健康检查自动初始化，HTTPS/WSS 反代仍需手动配置。空库也要跑完迁移，再按[首个管理员](mysql-redis.md)完成账号初始化。

## 上线验收

| 项目 | 要确认 |
| --- | --- |
| 配置/数据库 | production、无占位符、debug 关闭、迁移链完成且有回执、备份可恢复 |
| 登录/实时同步 | 密码、受控号码短信、图形验证、退出与撤销；WSS 可订阅且匿名不可发布 |
| 共享草稿 | 同版本维护回填、双权限、自动保存不改 main、跨设备单写者、断线／隐藏交接；/mqtt-drafts 接授权 listener，匿名通配拒绝、票期断开；保留 cloud-v1 发布回执 |
| 上传 | 文件/图片/GIF/SVG、多选/文件夹、暂停续传取消、替换 |
| 权限 | `.good` 继承、普通/机密/删减版、旧 URL 的在线撤权 |
| ESA | 冷请求/HIT、HEAD/Range、完整下载、中文文件名、Canvas、回调失败关闭 |
| 后台 | 图片、同步、上传、退役/刷新无异常积压；生产预热验收后再开 |

健康端点的范围见 [SID#1.4 的故障排查](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#故障排查)；云端核对与待办见 [SID#1.3.AGENT](../../docs/1_workflows/3_deliver/AGENT.md)，原始证据保留在[上线结果与待补验收](aliyun.md)。

## 日常升级

按 [SID#1.3 的普通发布与准入](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#普通发布与准入)执行；预检要求维护时转到[授权维护计划](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#授权维护计划)。失败先查[失败阶段表](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#失败后先确认停在哪一步)，数据库恢复另按 [SID#1.4 的备份与恢复](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#备份与恢复)。

## CSS 样式变更发布准备

当前官方主题 API 路线的范围与未完成项集中在[CSS 验收入口](../reviews/css-official-apis-validation-2026-10-29.md#发布门槛与剩余工作)。本节是后续发布时的操作要求；本机生产 profile 复验不代表已发布或已经演练缓存 / 回退。

| 时点 | 操作与需保留的证据 |
| --- | --- |
| 提交 / 审阅前 | 按 CSS 审阅范围逐项核对 diff，保留同一工作区中的其他功能变更边界；记录候选源码身份、锁文件、关键配置及本机测试结果，重新检出后重跑必要检查 |
| 发布前 | 关闭 CSS 入口列明的兼容未完成项，通过待发布代码树的远端 Check；专项与旧引擎验证见 [SID#1.2 的 CSS 与历史浏览器](../../docs/1_workflows/2_test/AGENT-DESIGN.md#css-与历史浏览器)，job 与复用条件见[CI 汇总](../../docs/1_workflows/2_test/AGENT-DESIGN.md#mqtt-镜像与-ci-汇总) |
| 构建与切换 | body ID / Tailwind selector、preset、静态 CSS、客户端 chunk 和 SSR 随同一镜像交付；版本与恢复材料按 [SID#1.3 的前端资源交付](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#前端资源随版本交付)准备 |
| 交付验收 | 核对真实 HTML 的 body ID、首屏 / hydration、Dialog / ConfirmPopup 定位与动画、六级标题和编辑器；冷加载应取得匹配 CSS / JS chunk，无 404 或样式混用。跨版本旧标签页是否验收按[已接受边界](github-acr.md#静态资源与旧标签页边界)及本次变更需要决定 |
| 缓存核对 | 读取主站 HTML 与 `/_nuxt/` 的实际响应头、回源和旧资产保留行为；本站 Content 域名 `/content/` 的 ESA 规则不证明这些前端资产已安全缓存，不能直接套用该规则 |
| 异常恢复 | 使用匹配版本的镜像 / SSR / 静态资产整体恢复，核对恢复后的 HTML 和动态 chunk；保留故障资源 URL、构建 / 镜像身份和脱敏截图，不在浏览器中临时关闭某一个主题入口来代替回退 |

现有应用健康门检测不到所有视觉故障，健康后才发现的样式异常不会自动触发视觉回退。镜像身份与回执保留见 [SID#1.3 的日志与回执](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#日志与回执)，旧版本恢复条件见[失败阶段表](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#失败后先确认停在哪一步)。本轮未执行生产部署、反代或缓存规则变更。

需要查某一字段、默认值或 env 选择规则时再看[配置项参考](configuration-reference.md)；RAM 授权细节见[权限参考](ram-reference.md)。
