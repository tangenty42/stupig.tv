# 工具脚本

按职责分目录，入口和内部实现放在同一个领域目录，测试与被测模块相邻。日常从项目根目录运行 package.json 中的 pnpm 命令。

| 目录 | 职责 |
| --- | --- |
| `dev/` | 组合启动、frpc、授权代理、子进程管理及开发 EMQX 初始化 |
| `env/` | env 模板合成、GPG、CLI 环境预载 |
| `background/` | 独立 worker 和状态查询 |
| `db/` | 数据库样本导出 |
| `storage/` | OSS 元数据专项盘点、断点与保护关系核对 |
| `content/` | 开发数据重置、预热检查 |
| `deploy/` | 远端部署、Docker/Compose 交付验证 |
| `esa/` | ESA 函数配置、预检和发布 |
| `migration/` | 统一迁移、本地入口、维护产物打包 |
| `verify/` | 跨模块接线检查、隔离数据库集成验证 |
| `testing/` | E2E 目标与分片端口、Playwright 全局准备、草稿验证用的一次性 broker |
| `ci/` | CI 复用 PR 检查结果 |

操作入口按[开发](../docs/1_workflows/1_develop/AGENT-DESIGN.md)、[测试](../docs/1_workflows/2_test/AGENT-DESIGN.md)、[发布](../docs/1_workflows/3_deliver/AGENT-DESIGN.md)、[维护](../docs/1_workflows/4_maintain/AGENT-DESIGN.md)查阅，未实施建议已记入对应阶段的 AGENT。版本化迁移位于根目录的 [migrations/](../migrations/)，不要放进这里；它们及冻结依赖的内容和路径必须保持稳定。

生产 EMQX 由项目 Compose 自动部署，镜像携带 ACL、初始化与健康检查入口；真实镜像权限和持久化测试通过 `STUPIG_EMQX_IMAGE` 启用，并在 Check 工作流中执行。首次配置和反代见 [SID#1.0](../docs/1_workflows/0_setup/AGENT-DESIGN.md)，凭据轮换见 [SID#1.4](../docs/1_workflows/4_maintain/AGENT-DESIGN.md#emqx-升级与凭据轮换)，镜像及公网验收见 [SID#1.2](../docs/1_workflows/2_test/AGENT-DESIGN.md#mqtt-镜像与-ci-汇总)。
