# TMP：开发、交付与维护的调查材料

- 本文档状态：PENDING（供人类编写、核对 workflows 文档）
- 覆盖范围：开发与生产环境、构建交付、迁移和验证入口
- 原调查基线：2026-11-03；提交 `67f8dad0a15c76acdb079c1334b143fcc146b935` 加当时工作区
- 权威依据：[SID#README](../README.md)、[SID#0.1.LAW](../0_overall/1_architecture/LAW.md)、[SID#0.1.DESIGN](../0_overall/1_architecture/DESIGN.md)
- 配套材料：[领域实现调查](../2_domains/TMP-IMPLEMENTATION-NOTES.md)

本文保存原 [SID#0.1.TMP-DESIGN](../0_overall/1_architecture/TMP-DESIGN.md) 中与工程流程有关的调查，不是可直接执行的完整操作手册。正文中的“当前”指原调查基线；本轮只重新组织材料，未重新验证生产部署或执行发布、迁移、恢复。

## 开发与部署环境

- 开发环境：Nuxt 在宿主机运行，[开发 Compose](../../docker-compose.dev.yml) 提供 MySQL、Redis、EMQX 和 phpMyAdmin；[开发启动器](../../scripts/dev/cli.ts) 同时管理所需授权代理／隧道。
- 生产编排：[docker-compose.yml](../../docker-compose.yml) 定义应用和 EMQX 容器；应用接入外部 Docker 网络使用数据库等设施，应用及浏览器 MQTT 端口通过宿主机反向代理对外服务。
- 后台扫描默认随应用进程运行。仓库另有[独立 worker 入口](../../scripts/background/worker.ts)，但当前生产 Dockerfile／Compose 没有交付独立 worker 服务；切换配置不能替代补齐部署产物。
- Redis 保留配置、开发容器和惰性连接客户端；在本次 `server/`、`scripts/` 调查中未发现业务命令消费者，不能把它画成现有业务缓存或任务队列。

## 迁移与历史实现

数据库结构以完整 [migrations](../../migrations/) 版本链为依据；`migration_runs` 是迁移回执账本。运行时代码与冻结迁移中出现相似模型，不能据此把历史快照视为可删除的重复实现。

维护历史迁移的可重放与冻结边界；精简运行时代码时单独核对历史恢复依赖。具体操作与验证步骤由相应流程文档展开。

## 交付、维护与验证

[Dockerfile](../../Dockerfile) 构建 Nuxt 产物及维护工具，并提供独立 EMQX 镜像目标。生产应用启动命令先运行迁移检查／执行入口，再启动服务；需要维护窗口的迁移必须按单独流程完成，不能假定容器启动会安全执行全部数据变换。

[Check](../../.github/workflows/check.yml) 编排生成一致性、lint、类型、单元／组件测试、浏览器、CSS、MQTT 和迁移验证；[Deploy](../../.github/workflows/deploy.yml) 负责镜像、部署编排与 ESA 发布；[维护部署流程](../../.github/workflows/maintenance-deploy.yml) 处理专门维护场景。这里说明验证和交付结构，不表示本轮已经执行这些检查。

`/api/hooks/healthz` 核对数据库查询及迁移回执表可读性；`system.health` 仅返回简单在线响应。两者都不能替代全部外部服务和业务链路的验收。

冻结迁移、备份恢复、生产切换和部署前提在 workflows 中详细规定。架构文档保存它们的边界与依赖，不重复每条操作命令。

## 后续展开

开发、测试、部署、迁移与恢复可分别建立所属流程文档。流程说明执行者需要具备的条件、操作步骤、结果与异常处理；通用 runner、通知、配置加载等设施的内部实现，在相应领域 DESIGN 中说明。原调查的 worker 交付、实际云端设置等待核对事项见[领域实现材料](../2_domains/TMP-IMPLEMENTATION-NOTES.md#待核对与可讨论事项)。
