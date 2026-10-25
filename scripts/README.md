# 工具脚本

按职责分目录，入口和内部实现放在同一个领域目录，测试与被测模块相邻。日常从项目根目录运行 package.json 中的 pnpm 命令。

| 目录 | 职责 |
| --- | --- |
| `dev/` | 组合启动、frpc、授权代理、子进程管理及开发 EMQX 初始化 |
| `env/` | env 模板合成、GPG、CLI 环境预载 |
| `background/` | 独立 worker 和状态查询 |
| `db/` | 数据库样本导出 |
| `storage/` | 旧存储只读盘点 |
| `content/` | 开发数据重置、预热检查 |
| `deploy/` | 远端部署、Docker/Compose 交付验证 |
| `esa/` | ESA 函数配置、预检和发布 |
| `migration/` | 统一迁移、本地入口、维护产物打包 |
| `verify/` | 跨模块接线检查、隔离数据库集成验证 |

具体命令、每个脚本的用途及尚未实施的简化建议见[完整清单](../docs/development/commands.md)。版本化迁移位于根目录的 [migrations/](../migrations/)，不要放进这里；它们及冻结依赖的内容和路径必须保持稳定。
