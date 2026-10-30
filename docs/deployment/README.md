# 部署清单

从上往下操作，每项只看对应模块。云端当前状态与未关闭问题放在[审计台账](aliyun.md)，不混进下面的固定步骤。

## 首次上线

| 顺序 | 做什么 | 操作说明 |
| --- | --- | --- |
| 1 | 准备主机、反代、Docker 网络、MySQL/Redis，规划项目 EMQX 的反代切换 | [服务器](server.md)、[MySQL/Redis](mysql-redis.md)、[EMQX](mqtt.md) |
| 2 | 创建 RAM 策略/用户，保存各身份凭据 | [RAM 清单](ram.md)；策略 JSON 已备齐 |
| 3 | 配 OSS 桶、域名、ESA 函数与路由/原生规则，开通短信与图形验证 | [OSS](oss.md)、[ESA 规则](esa.md)、[ESA 函数](esa-functions.md)、[短信/CAPTCHA](sms-captcha.md) |
| 4 | 填好生产 env/YAML，并更新配置密文 | [配置填写清单](configuration.md) |
| 5 | 配 GitHub/ACR，准备待部署镜像 | [GitHub/ACR](github-acr.md)；首次维护前别让自动部署直接升级旧业务库 |
| 6 | 备份，在副本演练，再执行维护迁移 | [迁移工具](../operations/migrations.md)、[Content 切换](../operations/content-cutover.md)、[备份恢复](../operations/backup-recovery.md) |
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

`/healthz` 只证明数据库与迁移账本可读，不代替 OSS、ESA、短信、MQTT 或迁移完整性验收。当前云端状态与待补验收看[上线结果与待补验收](aliyun.md)。

## 日常升级

迁移预演与备份 → 必要时维护迁移 → Check → 生产 ESA 预检 → 推送镜像/配置 → 应用健康门 → 自动发布生产 ESA → 业务冒烟。部署失败的镜像/配置恢复不会回滚数据库；应用健康后 ESA 发布失败也不会自动回滚应用。[失败处理](github-acr.md)、[恢复](../operations/backup-recovery.md)。

## CSS 样式变更发布准备

当前官方主题 API 路线的范围与未完成项集中在[CSS 验收入口](../reviews/css-official-apis-validation-2026-10-29.md#发布门槛与剩余工作)。本节是后续发布时的操作要求；本机生产 profile 复验不代表已发布或已经演练缓存 / 回退。

| 时点 | 操作与需保留的证据 |
| --- | --- |
| 提交 / 审阅前 | 按 CSS 审阅范围逐项核对 diff，保留同一工作区中的其他功能变更边界；记录候选源码身份、锁文件、关键配置及本机测试结果，重新检出后重跑必要检查 |
| 发布前 | 关闭 CSS 入口列明的兼容未完成项，通过待发布代码树的远端 Check。生产 CSS profile 位于 Check 第一 browser 分片，旧引擎 profile 仍需带已安装历史二进制的验证环境 |
| 构建与切换 | body ID / Tailwind selector、preset、静态 CSS、客户端 chunk 和 SSR 随同一镜像交付。记录实际 checkout SHA、镜像身份、配置 / Compose 和旧版本恢复材料；沿用现有 Deploy，不单独替换一份 CSS |
| 交付验收 | 核对真实 HTML 的 body ID、首屏 / hydration、Dialog / ConfirmPopup 定位与动画、六级标题和编辑器；冷加载与已有标签页导航都能取得匹配的 CSS / JS chunk，无 404 或样式混用 |
| 缓存核对 | 读取主站 HTML 与 `/_nuxt/` 的实际响应头、回源和旧资产保留行为；本站 Content 域名 `/content/` 的 ESA 规则不证明这些前端资产已安全缓存，不能直接套用该规则 |
| 异常恢复 | 使用匹配版本的镜像 / SSR / 静态资产整体恢复，核对恢复后的 HTML 和动态 chunk；保留故障资源 URL、构建 / 镜像身份和脱敏截图，不在浏览器中临时关闭某一个主题入口来代替回退 |

现有应用健康门检测不到所有视觉故障，健康后才发现的样式异常不会自动触发视觉回退。云端草稿版本起，Deploy 额外推送应用 SHA／broker mqtt-SHA tag，运行配置固定到实际 RepoDigest，发布回执记录提交、镜像、schema 和共享 settings 摘要；latest/mqtt 只保留兼容别名。镜像和旧 chunk 的保留仍需运维保证，回执不是备份。旧版本再交付见[部署失败与回退](github-acr.md#部署失败与回退)及[备份恢复](../operations/backup-recovery.md)。跨回无租约草稿协议禁止自动恢复，首次切换失败会停应用并保留数据；本轮未执行生产部署、反代或缓存规则变更。

需要查某一字段、默认值或 env 选择规则时再看[配置项参考](configuration-reference.md)；RAM 授权细节见[权限参考](ram-reference.md)。
