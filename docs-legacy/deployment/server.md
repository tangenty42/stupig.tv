# 服务端与反向代理

> 主机、网络与完整反代示例见 [SID#1.0](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#7-准备生产服务器)，发布与健康验收见 [SID#1.3.AGENT-DESIGN](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md)，运行查询与排障见 [SID#1.4.AGENT-DESIGN](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md)。本文保留原章节入口和运行接线说明。

生产事实源：[Compose](../../docker-compose.yml)、[Dockerfile](../../Dockerfile)、[入口脚本](../../docker-entrypoint.sh)、[健康端点](../../server/api/hooks/healthz.get.ts)。当前 Compose 接入已经存在的外部 Docker 网络，应用不是在生产宿主机直接执行 `pnpm dev`。

## 主机准备

主机、数据库、外部网络和部署目录准备见 [SID#1.0 的生产服务器](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#7-准备生产服务器)。

## 主站反代

完整示例及主机／容器网络接法见 [SID#1.0 的主站反代](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#主站反代)。

## Content 授权回调

生产授权入口、方法、响应及 ESA 接线见 [SID#1.0 的生产授权回调](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#生产授权回调)。

## 启动与维护

生产容器默认先执行：

```sh
node .output/server/maintenance/migrate.mjs
```

成功后用 `exec` 启动 `.output/server/index.mjs`。维护迁移准入按 [SID#1.3 的授权维护计划](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#授权维护计划)操作，失败状态查询与处理见 [SID#1.4 的迁移查询与失败恢复](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#迁移查询与失败恢复)。

精简镜像内可用的工具与源码命令差异见 [SID#1.4 的运维工具交付范围](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#运维工具的交付范围)，runner 模式和独立 worker 边界见[后台任务与日常存储检查](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#后台任务与日常存储检查)；领域机制仍见[后台任务](../modules/background-jobs.md)。

## 健康、日志与退出

服务器状态和日志命令见 [SID#1.4.DESIGN 的迁移查询](../../docs/1_workflows/4_maintain/DESIGN.md#迁移查询)，故障判断见 [SID#1.4 的故障排查](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#故障排查)。本机可用 `curl --fail http://127.0.0.1:3042/api/hooks/healthz` 检查应用探针，端口按实际配置替换。

容器探针每 30 秒检查一次，超时 5 秒，连续失败 3 次判不健康，启动宽限 120 秒。部署脚本另有健康门及公网验收，见 [SID#1.3 的普通发布与准入](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#普通发布与准入)。

退出宽限及检查点收尾见 [SID#1.4 的后台任务检查](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#后台任务与日常存储检查)，部署诊断文件见 [SID#1.3 的日志与回执](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#日志与回执)。不要在反代访问日志或故障报告中保存完整签名 URL、Authorization 或凭据。
