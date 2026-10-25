# 部署清单

从上往下操作，每项只看对应模块。云端当前状态与未关闭问题放在[审计台账](aliyun.md)，不混进下面的固定步骤。

## 首次上线

| 顺序 | 做什么 | 操作说明 |
| --- | --- | --- |
| 1 | 准备主机、反代、Docker 网络、MySQL/Redis/EMQX | [服务器](server.md)、[MySQL/Redis](mysql-redis.md)、[EMQX](mqtt.md) |
| 2 | 创建 RAM 策略/用户，保存各身份凭据 | [RAM 清单](ram.md)；策略 JSON 已备齐 |
| 3 | 配 OSS 桶、域名、ESA 函数与路由/原生规则，开通短信与图形验证 | [OSS](oss.md)、[ESA 规则](esa.md)、[ESA 函数](esa-functions.md)、[短信/CAPTCHA](sms-captcha.md) |
| 4 | 填好生产 env/YAML，并更新配置密文 | [配置填写清单](configuration.md) |
| 5 | 配 GitHub/ACR，准备待部署镜像 | [GitHub/ACR](github-acr.md)；首次维护前别让自动部署直接升级旧业务库 |
| 6 | 备份，在副本演练，再执行维护迁移 | [迁移工具](../operations/migrations.md)、[Content 切换](../operations/content-cutover.md)、[备份恢复](../operations/backup-recovery.md) |
| 7 | 启动应用、检查回调，发布正式函数代码 | [服务器](server.md)、[函数发布](esa-functions.md)；生产回调为 www.stupig.tv，不使用开发隧道 |
| 8 | 验收后开放流量，最后单独启用预热 | 下表 |

生产 Compose 只部署应用，不会自动创建数据库、broker、RAM、桶、域名或 ESA 规则。空库也要跑完迁移，再按[首个管理员](mysql-redis.md#空库的首个管理员)完成账号初始化。

## 上线验收

| 项目 | 要确认 |
| --- | --- |
| 配置/数据库 | production、无占位符、debug 关闭、迁移链完成且有回执、备份可恢复 |
| 登录/实时同步 | 密码、受控号码短信、图形验证、退出与撤销；WSS 可订阅且匿名不可发布 |
| 上传 | 文件/图片/GIF/SVG、多选/文件夹、暂停续传取消、替换 |
| 权限 | `.good` 继承、普通/机密/删减版、旧 URL 的在线撤权 |
| ESA | 冷请求/HIT、HEAD/Range、完整下载、中文文件名、Canvas、回调失败关闭 |
| 后台 | 图片、同步、上传、退役/刷新无异常积压；生产预热验收后再开 |

`/healthz` 只证明数据库与迁移账本可读，不代替 OSS、ESA、短信、MQTT 或迁移完整性验收。当前云端代码、生产凭据等待修项看[上线阻塞项](aliyun.md#上线阻塞项)。

## 日常升级

迁移预演与备份 → 必要时维护迁移 → Check → 生产 ESA 预检 → 推送镜像/配置 → 应用健康门 → 自动发布生产 ESA → 业务冒烟。部署失败的镜像/配置恢复不会回滚数据库；应用健康后 ESA 发布失败也不会自动回滚应用。[失败处理](github-acr.md#部署失败与回退)、[恢复](../operations/backup-recovery.md)。

需要查某一字段、默认值或 env 选择规则时再看[配置项参考](configuration-reference.md)；RAM 授权细节见[权限参考](ram-reference.md)。
