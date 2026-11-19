# 本地开发

> 当前操作见 [SID#1.1.DESIGN](../../docs/1_workflows/1_develop/DESIGN.md)及其[操作补充](../../docs/1_workflows/1_develop/AGENT-DESIGN.md)。本文保留初次接入参考、历史验收记录与旧章节锚点；迁移核对见 [SID#1.1.AGENT](../../docs/1_workflows/1_develop/AGENT.md)。

## 环境

工具安装、环境文件及资源接入见[初次配置](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#1-准备本机)；开发容器、端口和安装钩子见[开发进程与端口](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#开发进程与端口)。EMQX 的认证、listener 和 ACL 仍见[MQTT 手册](../deployment/mqtt.md)。

当前开发隧道要求 frpc 0.71.0。Windows 默认路径见 [config/dev.yaml](../../config/dev.yaml)，其他平台可自行创建开发专用的 `config/local.yaml` 覆盖可执行文件路径。该本机配置不入库，未创建时不存在是正常情况，见[配置说明](../deployment/configuration.md)。

## 首次启动

按[初次配置的开发启动步骤](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#6-连上开发回调并启动)完成接入。空库初始化、已有库迁移和测试账号规则见[开发工作流](../../docs/1_workflows/1_develop/DESIGN.md)；隧道校验与 ESA 提示见[授权隧道与 ESA 提示](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#授权隧道与-esa-提示)。

## 启停与进程归属

启动和停止命令见[日常开发](../../docs/1_workflows/1_develop/DESIGN.md#日常)；端口冲突、已有代理复用及退出清理见[开发进程与端口](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#开发进程与端口)。

## EMQX 版本与升级

当前操作见[EMQX 升级与凭据轮换](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#emqx-升级与凭据轮换)。以下保留当时本机升级的证据范围：

2026-10-24 本机从 5.10.5 升到 6.2.2，升级前确认 durable sessions 关闭，已保存逻辑导出、停机数据/配置与容器元数据，原卷与节点身份保持不变，升级后 MQTT 3.1.1/5 各 10 项权限测试通过。备份位于本机忽略目录 `.data/emqx-upgrade-20261024-6.2.2/`，限制为当前用户访问，不随仓库分发；新检出不依赖它。开启 durable sessions 的其他环境须另外按[官方升级限制](https://docs.emqx.com/en/emqx/v6.2/deploy/rolling-upgrades.html)处理。

## 日常命令

开发和配置变更见[开发工作流](../../docs/1_workflows/1_develop/DESIGN.md)，环境选择细节见[配置实际从哪里来](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#配置实际从哪里来)；验证命令见[测试工作流](../../docs/1_workflows/2_test/DESIGN.md)，后台查询、预热和盘点见[维护工作流](../../docs/1_workflows/4_maintain/DESIGN.md)。脚本职责索引仍见[命令与脚本清单](./commands.md)。

## 测试数据与重置

开发实例已有 `admin`、`user` 测试身份，是否仍存在以本机数据库为准。优先使用既有会话或密码登录；测试号码不是可以发送真实短信的号码白名单。

样本导出与开发清空操作见[开发样本与重置](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#开发样本与重置)，恢复备份另见[备份与恢复](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#备份与恢复)。旧 S3 `storage:cleanup` 盘点入口已随旧表退役删除，当前 OSS 对账由后台领域任务负责。

## 源码入口

开发启动、隧道、环境与迁移入口集中列在[开发实现核对](../../docs/1_workflows/1_develop/AGENT.md#实现对应)；测试和排障分别见[测试补充](../../docs/1_workflows/2_test/AGENT-DESIGN.md)、[维护排障](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#故障排查)。
