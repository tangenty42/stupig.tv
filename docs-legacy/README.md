# 旧文档归档

2026-11-03 将原 `docs/` 中的 55 份手册、设计、审查和报告移入此目录，为 [Swordoc 文档](../docs/README.md)腾出编写空间。归档基线为提交 `67f8dad0a15c76acdb079c1334b143fcc146b935` 加当时工作区中的文档改动。

归档时原有目录层级和文件内容原样保留；后续维护会修正失效链接、过时操作说明并接入新文档，历史核对仍保留原日期和验证范围。原 `docs/README.md` 的机制草案保存为 [README-DRAFT.md](README-DRAFT.md)，其中的提议和待定状态属于历史草案。人类修订稿已原样成为新的 [docs/README.md](../docs/README.md)，随后由人类继续维护。

现行工作流操作与逐章迁移去向见 [流程整理记录](../docs/AGENT.md#流程草稿与索引退役记录)。1.1～1.4 的操作补充与记录已建立，旧手册的重复操作已精简为新入口；原章节锚点继续兼容旧引用。初配示例已迁入 SID#1.0，本目录继续保留领域机制和原始证据。

本目录是历史参考，不属于新的 Swordoc 权威文档。这里的实现、部署状态和实验结论只在各自记录的版本、时间及验证范围内成立；采用前核对当前代码、配置和新规范。归档不代表这些业务已经退役，也不表示新规范已经编写完成。

| 内容 | 入口 |
| --- | --- |
| 旧导航与文档机制草案 | [原 README](README-DRAFT.md) |
| 业务与架构 | [架构总集](architecture.md) |
| 开发与验证 | [本地开发](development/README.md)、[命令清单](development/commands.md)、[测试](development/testing.md) |
| 部署与资源 | [部署总流程](deployment/README.md)、[云端台账](deployment/aliyun.md) |
| Content | [模块总览](modules/content/README.md) |
| 账号、同步与后台工作 | [账号](modules/accounts.md)、[实时同步](modules/realtime.md)、[后台工作](modules/background-jobs.md) |
| 迁移与恢复 | [迁移](operations/migrations.md)、[Content 切换](operations/content-cutover.md)、[备份恢复](operations/backup-recovery.md) |
| 设计与审查 | [设计记录](designs/)、[审查与实验报告](reviews/) |

历史材料中出现的仓库根路径 `docs/...` 指归档前的位置，对应文件现在位于 `docs-legacy/...`。历史报告内的路径和代码行号保留原貌，不因此假定当前路径或行号仍然适用。后续新文档的编写状态见 [docs/AGENT.md](../docs/AGENT.md)。

归档时发现两处链接到云端台账旧标题“截至 2026-11-01 的发布信息”的失效锚点，现已修正：[OSS 对账](operations/storage-audit.md)指向 [2026-11-01 WebP 维护发布](deployment/aliyun.md#2026-11-01-webp-维护发布与原生持久化权限)，[故障排查](operations/troubleshooting.md)指向 [2026-11-01 早先的 #54 发布核对](deployment/aliyun.md#2026-11-01-早先的-54-发布核对)。两处均为历史发布记录，后续操作仍需核对实际运行版本。
