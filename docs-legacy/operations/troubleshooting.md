# 故障排查

> 当前排查入口分别见[开发](../../docs/1_workflows/1_develop/AGENT-DESIGN.md)、[发布](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#失败后先确认停在哪一步)与[维护](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#故障排查)补充说明。本文保留领域问题线索及历史案例，业务内部机制仍按所属领域核对。

先定位失败层：应用进程、数据库／迁移、授权回调、对象存储、ESA 交付、后台扫描或浏览器状态。保留时间、动作、身份类别、请求 ID、安全错误码及状态变化；不要分享 token、完整签名 URL、请求正文或原始 SDK 凭据。

## 开发启动

应用／代理端口、Compose 依赖及复用检查见 [SID#1.1 开发进程与端口](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#开发进程与端口)，frpc 检查见 [授权隧道与 ESA 提示](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#授权隧道与-esa-提示)，环境选择和变量优先级见 [配置实际从哪里来](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#配置实际从哪里来)。

仍需核对具体实例的情况：

- frpc 不能执行时查看操作系统实际错误，不通过关闭防护或跳过 TLS 校验解决。
- env 仍有 `<required>` 时，重跑对应环境生成命令或补齐目标文件，再重新加载进程。
- 修改 MySQL／MQTT 密码后认证失败，核对真实账号；环境值变化不会自动同步已有数据库或 broker 账号，不删除卷来掩盖差异。

## 迁移与健康检查

迁移锁、维护准入、SQL／TS 失败和摘要异常见 [SID#1.4 迁移查询与失败恢复](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#迁移查询与失败恢复)；`healthz` 与公网／业务验收的范围见 [故障排查](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#故障排查)。

恢复步骤见[迁移手册](./migrations.md)和 [Content 切换](./content-cutover.md)。2026-10-25 的回执记录生产 Content 已完成副本预演和正式迁移；后续版本仍须独立核对迁移链与发布回执，不能把新镜像重启成功当成切换验收。2026-11-01 早先的 #54 发布信息与核验边界见[云端台账](../deployment/aliyun.md#2026-11-01-早先的-54-发布核对)。

## 授权回调和 ESA

回调通道逐段诊断见 [SID#1.1 授权隧道与 ESA 提示](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#授权隧道与-esa-提示)，发布参数、失败阶段及真实交付验收见 [SID#1.3 单独发布 ESA](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#单独发布-esa)。

- frpc running、WebSocket 101 只说明局部进程或通道条件，继续核对代理注册和回调响应。
- 合法授权应验证状态与 HMAC；再验 GET/HEAD/Range 及完整文件大小和摘要。
- 当前读取每次经过在线授权，回调故障会拒绝交付。不要为了恢复可用性改为缓存成功授权或只验证旧签名。
- 缓存 HIT 后拒绝旧 URL 属于业务撤权；对象删除和缓存刷新是后续物理清理，二者分开检查。

历史曾遇到 ESA 旁路与 URI 路径匹配／响应头规则组合异常。新的诊断必须记录当前发布版本、规则表达式、优先级、缓存状态和相同对象的对照结果。不能将旧工单的 URI 规避写法视作所有环境已验证的默认规则，也不能凭单次成功宣布云端问题已修复。现行配置及待核对项见 [ESA](../deployment/esa.md)。

## OSS 上传与图片

AccessDenied 和浏览器上传失败的初查见 [SID#1.4 故障排查](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#故障排查)。其他领域症状：

| 症状 | 检查范围 |
| --- | --- |
| 网络断开后完成结果不明 | 保留会话和精确对象身份，让生命周期／对账处理；不要重复创建同目标或删除未知 multipart |
| 图片格式／像素预算拒绝 | 核对实际字节、静态处理白名单、预算和错误码。GIF/SVG 等应按原样附件路径判断，不能只看后缀 |
| 上传成功但列表／正文未同步 | 检查 publication 回执、workspace revision、引用桥接及通知 outbox；不要仅凭对象存在判定业务提交完成 |
| 删除后仍有历史版本 | 当前版本删除与历史永久清除不同，检查版本控制、生命周期及退役账本 |

具体合同见[上传](../modules/content/uploads.md)、[权限](../modules/content/access.md)与[对象生命周期](../modules/content/object-lifecycle.md)。

## 后台任务与实时同步

后台状态查询、worker 模式和预热停滞的检查见 [SID#1.4 后台任务与日常存储检查](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#后台任务与日常存储检查)。领域侧继续核对：

- 检查有效租约、到期候选、重试时间、最老待办和资源槽，不手工把 running 改 pending。
- Content 通知经过事务 outbox 和 MQTT ACK；broker 暂时不可用时保留重试。普通页面重载不能证明 outbox 已清空。
- 浏览器仅活动标签维护连接，其他标签通过 BroadcastChannel 接收；登录身份变化和 SSR hydration 的状态交接也要纳入检查。

详见[后台工作](../modules/background-jobs.md)、[实时同步](../modules/realtime.md)及 [EMQX 部署](../deployment/mqtt.md)。
